/**
 * 本地 blob 存储：用户上传（存档截图、游戏 logo）落盘
 *
 * key 与 S3 object key 同构（saves/<userId>/<saveId>.jpg、games/<gameId>/_logo），
 * 所以同一个 key 在两边都认；迁移期读取 disk → S3 回退，写入只落盘，
 * S3 退役后把回退分支删掉即可，key 不用动。
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { env } from "../env";

const ROOT = path.resolve(env.uploadDir);

/** key → 磁盘绝对路径；越界返回 null（key 有客户端可控成分，需防路径遍历） */
export function blobPath(key: string): string | null {
  const abs = path.resolve(ROOT, key);
  return abs.startsWith(ROOT + path.sep) ? abs : null;
}

export async function putBlob(key: string, body: Buffer): Promise<void> {
  const abs = blobPath(key);
  if (!abs) throw new Error(`invalid blob key: ${key}`);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

/** 不存在返回 null，让调用方自己决定是回退 S3 还是 404 */
export async function getBlob(key: string): Promise<Buffer | null> {
  const abs = blobPath(key);
  if (!abs) return null;
  try {
    return await readFile(abs);
  } catch {
    return null;
  }
}

export async function blobExists(key: string): Promise<boolean> {
  const abs = blobPath(key);
  if (!abs) return false;
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

export async function deleteBlob(key: string): Promise<void> {
  const abs = blobPath(key);
  if (abs) await rm(abs, { force: true });
}
