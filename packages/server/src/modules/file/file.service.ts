/**
 * 文件系统服务
 *
 * PostgreSQL 存文件元数据，内容在磁盘上（resources/<slug>/，由内容镜像投放）。
 * 重命名、移动只改 PG 记录。写操作（上传/替换）随 S3 退役下线，见 uploadDisabled
 */

import type { FileNode } from "@miu2d/types";
import { TRPCError } from "@trpc/server";
import { db } from "../../db/client";
import type { File as PrismaFile } from "../../db/generated/prisma/client";
import { getMessage, type Language } from "../../i18n";
import { verifyGameAccess } from "../../utils/gameAccess";

/**
 * 写操作曾靠 S3 预签名 URL，rustfs 已下线（2026-07-19）而磁盘上传还没实现。
 * 明确报错好过让前端去连一个不存在的 endpoint 干等超时
 */
function uploadDisabled(language: Language): never {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: getMessage(language, "errors.file.uploadDisabled"),
  });
}

/**
 * 将数据库记录转换为输出格式
 * @param dbFile 数据库文件记录
 * @param path 文件完整路径（可选，默认为文件名）
 */
export function toFileNodeOutput(dbFile: PrismaFile, path?: string): FileNode {
  return {
    id: dbFile.id,
    gameId: dbFile.gameId,
    parentId: dbFile.parentId,
    name: dbFile.name,
    type: dbFile.type as "file" | "folder",
    path: path ?? `/${dbFile.name}`,
    storageKey: dbFile.storageKey,
    size: dbFile.size,
    mimeType: dbFile.mimeType,
    checksum: dbFile.checksum,
    createdAt: dbFile.createdAt?.toISOString() ?? null,
    updatedAt: dbFile.updatedAt?.toISOString() ?? null,
  };
}

export class FileService {
  /**
   * 获取文件/目录的完整路径字符串
   * 递归获取父目录名称，组成完整路径
   */
  async buildFilePath(fileId: string): Promise<string> {
    const pathParts: string[] = [];
    let currentId: string | null = fileId;

    while (currentId) {
      const file: { id: string; name: string; parentId: string | null } | null =
        await db.file.findFirst({
          where: { id: currentId },
          select: { id: true, name: true, parentId: true },
        });

      if (!file) break;

      pathParts.unshift(file.name);
      currentId = file.parentId;
    }

    return `/${pathParts.join("/")}`;
  }

  /**
   * 获取目录的完整路径（用于列表时计算子项路径）
   */
  async getDirectoryPath(parentId: string | null): Promise<string> {
    if (!parentId) return "";
    return this.buildFilePath(parentId);
  }

  /**
   * 列出目录内容
   */
  async listFiles(
    gameId: string,
    parentId: string | null | undefined,
    userId: string,
    language: Language
  ): Promise<FileNode[]> {
    await verifyGameAccess(gameId, userId, language);

    // 获取父目录路径
    const parentPath = await this.getDirectoryPath(parentId ?? null);

    const condition =
      parentId !== undefined && parentId !== null
        ? { gameId, parentId, deletedAt: null as null }
        : { gameId, parentId: null as null, deletedAt: null as null };

    const rows = await db.file.findMany({ where: condition });
    return rows.map((row) => toFileNodeOutput(row, `${parentPath}/${row.name}`));
  }

  /**
   * 创建目录
   */
  async createFolder(
    gameId: string,
    parentId: string | null | undefined,
    name: string,
    userId: string,
    language: Language
  ): Promise<FileNode> {
    await verifyGameAccess(gameId, userId, language);

    // 检查同名文件/目录
    await this.checkNameConflict(gameId, parentId ?? null, name, language);

    const folder = await db.file.create({
      data: { gameId, parentId: parentId ?? null, name, type: "folder" },
    });

    const parentPath = await this.getDirectoryPath(parentId ?? null);
    return toFileNodeOutput(folder, `${parentPath}/${folder.name}`);
  }

  /**
   * 检查名称冲突
   */
  private async checkNameConflict(
    gameId: string,
    parentId: string | null,
    name: string,
    language: Language,
    excludeId?: string
  ): Promise<void> {
    const condition =
      parentId !== null
        ? { gameId, parentId, name, deletedAt: null as null }
        : { gameId, parentId: null as null, name, deletedAt: null as null };

    const existing = await db.file.findFirst({ where: condition, select: { id: true } });

    if (existing && existing.id !== excludeId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: getMessage(language, "errors.file.nameConflict"),
      });
    }
  }

  /**
   * 准备上传（已下线）
   */
  async prepareUpload(
    _gameId: string,
    _parentId: string | null | undefined,
    _name: string,
    _size: number,
    _mimeType: string | undefined,
    _userId: string,
    language: Language
  ): Promise<{ fileId: string; uploadUrl: string; storageKey: string }> {
    return uploadDisabled(language);
  }

  /**
   * 确认上传完成
   */
  async confirmUpload(fileId: string, userId: string, language: Language): Promise<FileNode> {
    // 获取文件记录
    const file = await db.file.findFirst({ where: { id: fileId, deletedAt: null } });

    if (!file) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: getMessage(language, "errors.file.notFound"),
      });
    }

    await verifyGameAccess(file.gameId, userId, language);

    // 更新 updatedAt
    const updated = await db.file.update({
      where: { id: fileId },
      data: { updatedAt: new Date() },
    });

    const path = await this.buildFilePath(updated.id);
    return toFileNodeOutput(updated, path);
  }

  /**
   * 获取下载 URL
   *
   * 返回公开资源路由的同源相对地址，由 file.routes 从磁盘取。原先返回 S3 预签名
   * URL，S3 退役后 storageKey 已全部置空，那条路取不到任何东西
   */
  async getDownloadUrl(fileId: string, userId: string, language: Language): Promise<string> {
    const file = await db.file.findFirst({ where: { id: fileId, deletedAt: null } });

    if (!file) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: getMessage(language, "errors.file.notFound"),
      });
    }

    await verifyGameAccess(file.gameId, userId, language);

    if (file.type !== "file") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: getMessage(language, "errors.file.notAFile"),
      });
    }

    const game = await db.game.findFirst({
      where: { id: file.gameId },
      select: { slug: true },
    });

    if (!game) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: getMessage(language, "errors.file.notFound"),
      });
    }

    // buildFilePath 以 / 开头，逐段编码后拼回去（素材名有中文和空格）
    const encoded = (await this.buildFilePath(fileId)).split("/").map(encodeURIComponent).join("/");
    return `/game/${game.slug}/resources${encoded}`;
  }

  /**
   * 获取上传 URL（已下线）
   */
  async getUploadUrl(
    _fileId: string,
    _size: number | undefined,
    _mimeType: string | undefined,
    _userId: string,
    language: Language
  ): Promise<{ uploadUrl: string; storageKey: string }> {
    return uploadDisabled(language);
  }

  /**
   * 重命名文件/目录
   */
  async rename(
    fileId: string,
    newName: string,
    userId: string,
    language: Language
  ): Promise<FileNode> {
    const file = await db.file.findFirst({ where: { id: fileId, deletedAt: null } });

    if (!file) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: getMessage(language, "errors.file.notFound"),
      });
    }

    await verifyGameAccess(file.gameId, userId, language);

    // 检查同名冲突
    await this.checkNameConflict(file.gameId, file.parentId, newName, language, fileId);

    const updated = await db.file.update({
      where: { id: fileId },
      data: { name: newName, updatedAt: new Date() },
    });

    const path = await this.buildFilePath(updated.id);
    return toFileNodeOutput(updated, path);
  }

  /**
   * 移动文件/目录
   */
  async move(
    fileId: string,
    newParentId: string | null,
    userId: string,
    language: Language
  ): Promise<FileNode> {
    const file = await db.file.findFirst({ where: { id: fileId, deletedAt: null } });

    if (!file) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: getMessage(language, "errors.file.notFound"),
      });
    }

    await verifyGameAccess(file.gameId, userId, language);

    // 验证目标目录存在且是目录
    if (newParentId) {
      const parent = await db.file.findFirst({
        where: { id: newParentId, gameId: file.gameId, deletedAt: null },
      });

      if (!parent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: getMessage(language, "errors.file.parentNotFound"),
        });
      }

      if (parent.type !== "folder") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: getMessage(language, "errors.file.parentNotFolder"),
        });
      }

      // 防止将目录移动到自己的子目录中
      if (file.type === "folder") {
        const isDescendant = await this.isDescendant(newParentId, fileId);
        if (isDescendant) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: getMessage(language, "errors.file.cannotMoveToDescendant"),
          });
        }
      }
    }

    // 检查同名冲突
    await this.checkNameConflict(file.gameId, newParentId, file.name, language, fileId);

    const updated = await db.file.update({
      where: { id: fileId },
      data: { parentId: newParentId, updatedAt: new Date() },
    });

    const path = await this.buildFilePath(updated.id);
    return toFileNodeOutput(updated, path);
  }

  /**
   * 检查 targetId 是否是 ancestorId 的后代
   */
  private async isDescendant(targetId: string, ancestorId: string): Promise<boolean> {
    let currentId: string | null = targetId;
    const visited = new Set<string>();

    while (currentId) {
      if (currentId === ancestorId) return true;
      if (visited.has(currentId)) break; // 防止循环
      visited.add(currentId);

      const file: { parentId: string | null } | null = await db.file.findFirst({
        where: { id: currentId },
        select: { parentId: true },
      });

      currentId = file?.parentId ?? null;
    }

    return false;
  }

  /**
   * 删除文件/目录
   */
  async delete(fileId: string, userId: string, language: Language): Promise<{ id: string }> {
    const file = await db.file.findFirst({ where: { id: fileId, deletedAt: null } });

    if (!file) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: getMessage(language, "errors.file.notFound"),
      });
    }

    await verifyGameAccess(file.gameId, userId, language);

    // 软删除：只打标记，不删除数据库记录和磁盘文件
    await this.softDeleteRecursive(fileId);

    return { id: fileId };
  }

  /**
   * 递归收集文件/目录及其所有子项的 ID（仅未删除的节点）
   */
  private async collectAllIds(fileId: string): Promise<string[]> {
    const ids: string[] = [fileId];

    const children = await db.file.findMany({
      where: { parentId: fileId, deletedAt: null },
      select: { id: true },
    });

    for (const child of children) {
      const childIds = await this.collectAllIds(child.id);
      ids.push(...childIds);
    }

    return ids;
  }

  /**
   * 软删除文件/目录及其所有子项。
   * 先收集所有需要标记的 ID，再通过单次事务批量更新，避免部分更新后失败导致数据不一致。
   */
  private async softDeleteRecursive(fileId: string): Promise<void> {
    const allIds = await this.collectAllIds(fileId);
    const now = new Date();

    await db.$transaction(async (tx) => {
      await tx.file.updateMany({ where: { id: { in: allIds } }, data: { deletedAt: now } });
    });
  }

  /**
   * 获取文件路径（从根到当前）
   */
  async getFilePath(
    fileId: string,
    userId: string,
    language: Language
  ): Promise<{ path: Array<{ id: string; name: string }> }> {
    const file = await db.file.findFirst({ where: { id: fileId, deletedAt: null } });

    if (!file) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: getMessage(language, "errors.file.notFound"),
      });
    }

    await verifyGameAccess(file.gameId, userId, language);

    // 构建路径
    const path: Array<{ id: string; name: string }> = [];
    let currentId: string | null = fileId;

    while (currentId) {
      const current: { id: string; name: string; parentId: string | null } | null =
        await db.file.findFirst({
          where: { id: currentId },
          select: { id: true, name: true, parentId: true },
        });

      if (!current) break;

      path.unshift({ id: current.id, name: current.name });
      currentId = current.parentId;
    }

    return { path };
  }

  /**
   * 获取文件信息
   */
  async getFile(fileId: string, userId: string, language: Language): Promise<FileNode> {
    const file = await db.file.findFirst({ where: { id: fileId, deletedAt: null } });

    if (!file) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: getMessage(language, "errors.file.notFound"),
      });
    }

    await verifyGameAccess(file.gameId, userId, language);

    const path = await this.buildFilePath(file.id);
    return toFileNodeOutput(file, path);
  }

  /**
   * 批量准备上传（已下线）
   */
  async batchPrepareUpload(
    _gameId: string,
    _fileItems: Array<{
      clientId: string;
      parentId: string | null | undefined;
      name: string;
      size: number;
      mimeType: string | undefined;
    }>,
    _skipExisting: boolean,
    _userId: string,
    language: Language
  ): Promise<
    Array<{
      clientId: string;
      fileId: string;
      uploadUrl: string;
      storageKey: string;
      skipped: boolean;
    }>
  > {
    return uploadDisabled(language);
  }

  /**
   * 批量确认上传完成
   * 一次性确认多个文件，减少网络往返
   */
  async batchConfirmUpload(fileIds: string[], userId: string, language: Language): Promise<number> {
    if (fileIds.length === 0) return 0;

    // 验证所有文件存在且用户有权限
    const fileRecords = await db.file.findMany({
      where: { id: { in: fileIds }, deletedAt: null },
    });

    if (fileRecords.length === 0) return 0;

    // 验证对所有涉及的游戏有权限（通常只有一个）
    const gameIds = [...new Set(fileRecords.map((f) => f.gameId))];
    for (const gid of gameIds) {
      await verifyGameAccess(gid, userId, language);
    }

    const validFileIds = fileRecords.map((f) => f.id);

    // 批量更新 updatedAt
    await db.file.updateMany({
      where: { id: { in: validFileIds } },
      data: { updatedAt: new Date() },
    });

    return validFileIds.length;
  }

  /**
   * 服务端创建文件夹路径（递归创建所有中间文件夹）
   * 如果文件夹已存在则复用，避免客户端逐级查询
   */
  async ensureFolderPath(
    gameId: string,
    parentId: string | null | undefined,
    pathParts: string[],
    userId: string,
    language: Language
  ): Promise<string> {
    await verifyGameAccess(gameId, userId, language);

    let currentParentId: string | null = parentId ?? null;

    for (const folderName of pathParts) {
      // 检查此层是否已存在
      const existing = await db.file.findFirst({
        where: currentParentId
          ? { gameId, parentId: currentParentId, name: folderName, type: "folder", deletedAt: null }
          : { gameId, parentId: null, name: folderName, type: "folder", deletedAt: null },
        select: { id: true },
      });

      if (existing) {
        currentParentId = existing.id;
      } else {
        const folder = await db.file.create({
          data: { gameId, parentId: currentParentId, name: folderName, type: "folder" },
        });
        currentParentId = folder.id;
      }
    }

    return currentParentId!;
  }
}

export const fileService = new FileService();
