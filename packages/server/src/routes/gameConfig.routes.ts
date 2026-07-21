/**
 * 游戏配置 REST 路由（Hono）
 *
 * GET /game/:gameSlug/api/config    - 获取游戏全局配置
 * GET /game/:gameSlug/api/manifest  - 获取游戏专属 PWA Manifest（动态）
 * GET /game/:gameSlug/api/logo/:size - 获取指定尺寸 Logo（128/192/512）
 * POST /game/:gameSlug/api/logo     - 上传游戏 Logo（>=512px，自动生成多尺寸，需认证）
 * DELETE /game/:gameSlug/api/logo   - 删除游戏 Logo（需认证）
 */

import { createDefaultGameConfig, GameConfigDataSchema } from "@miu2d/types";
import { Hono } from "hono";
import { Jimp } from "jimp";
import { db } from "../db/client";
import type { Prisma } from "../db/generated/prisma/client";
import { gameConfigService } from "../modules/gameConfig/gameConfig.service";
import { deleteBlob, getBlob, putBlob } from "../storage/local-blob";
import { Logger } from "../utils/logger";
import { resolveUserId } from "../utils/session";

const logger = new Logger("GameConfigRoutes");

/** Jimp 1.6 装了哪些解码器就支持哪些格式，webp/avif/heic 需要额外的 wasm 包 */
const SUPPORTED_LOGO_FORMATS = "PNG, JPEG, BMP, GIF, TIFF";

/** PWA 图标尺寸规格 */
const LOGO_SIZES = [512, 192, 128] as const;

/** 源图尺寸下限 */
const MIN_LOGO_SIZE = 256;
type LogoSize = (typeof LOGO_SIZES)[number];

/** Logo 原图的存储 key */
function logoStorageKey(gameId: string): string {
  return `games/${gameId}/_logo`;
}

/** Logo 指定尺寸变体的存储 key */
function logoSizedKey(gameId: string, size: LogoSize): string {
  return `games/${gameId}/_logo_${size}`;
}

/** 所有尺寸变体 + 原图的 key 列表 */
function allLogoKeys(gameId: string): string[] {
  return [logoStorageKey(gameId), ...LOGO_SIZES.map((size) => logoSizedKey(gameId, size))];
}

async function removeLogos(gameId: string): Promise<void> {
  await Promise.all(allLogoKeys(gameId).map((k) => deleteBlob(k)));
}

/**
 * 将原图缩放并生成所有 PWA 尺寸变体，返回 Buffer 数组
 */
async function generateLogoVariants(src: Buffer): Promise<Array<{ size: LogoSize; buf: Buffer }>> {
  const image = await Jimp.read(src);
  const results: Array<{ size: LogoSize; buf: Buffer }> = [];
  for (const size of LOGO_SIZES) {
    // cover mutates in place, so clone per size
    const buf = await image.clone().cover({ w: size, h: size }).getBuffer("image/png");
    results.push({ size, buf });
  }
  return results;
}

export const gameConfigRoutes = new Hono();

/**
 * 获取游戏全局配置
 */
gameConfigRoutes.get(":gameSlug/api/config", async (c) => {
  try {
    const gameSlug = c.req.param("gameSlug");
    logger.debug(`[getConfig] gameSlug=${gameSlug}`);

    const config = await gameConfigService.getPublicBySlug(gameSlug);

    c.header("Cache-Control", "public, max-age=300");

    return c.json(config);
  } catch (error) {
    logger.error("[getConfig] Error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * 获取游戏专属 PWA Manifest（动态生成，含游戏名称/图标/start_url）
 */
gameConfigRoutes.get(":gameSlug/api/manifest", async (c) => {
  try {
    const gameSlug = c.req.param("gameSlug");

    const game = await db.game.findFirst({
      where: { slug: gameSlug },
      select: { id: true, name: true },
    });

    if (!game) {
      return c.json({ error: "Game not found" }, 404);
    }

    const startUrl = `/game/${gameSlug}/`;

    // 通过 gameConfig 判断是否有自定义 logo（省一次读盘）
    const gameConfig = await gameConfigService.getPublicBySlug(gameSlug);
    const hasLogo = Boolean(gameConfig?.logoUrl?.startsWith("games/"));

    const icons: Array<{ src: string; sizes: string; type: string; purpose: "any" | "maskable" }> =
      hasLogo
        ? ([512, 192] as const).flatMap((size) => [
            // Use the server logo route (reads from private MinIO) — NOT a raw /s3 key,
            // which 403s because the bucket is private and the URL is unsigned.
            {
              src: `/game/${gameSlug}/api/logo/${size}`,
              sizes: `${size}x${size}`,
              type: "image/png",
              purpose: "any" as const,
            },
            {
              src: `/game/${gameSlug}/api/logo/${size}`,
              sizes: `${size}x${size}`,
              type: "image/png",
              purpose: "maskable" as const,
            },
          ])
        : [
            { src: "/icons/pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/icons/pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            {
              src: "/icons/pwa-maskable-192x192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "maskable",
            },
            {
              src: "/icons/pwa-maskable-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ];

    const manifest = {
      id: startUrl,
      name: game.name,
      short_name: game.name,
      description: `Play ${game.name} online`,
      start_url: startUrl,
      scope: `/game/${gameSlug}/`,
      display: "standalone",
      orientation: "landscape",
      background_color: "#000000",
      theme_color: "#1a1a2e",
      lang: "zh-CN",
      categories: ["games", "entertainment"],
      icons,
    };

    c.header("Content-Type", "application/manifest+json");
    c.header("Cache-Control", "public, max-age=300");

    return c.json(manifest);
  } catch (error) {
    logger.error("[getManifest] Error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * 获取游戏 Logo 指定尺寸变体（128/192/512）
 * dashboard 和游戏前端都走这条
 */
gameConfigRoutes.get(":gameSlug/api/logo/:size", async (c) => {
  try {
    const gameSlug = c.req.param("gameSlug");
    const sizeParam = Number(c.req.param("size"));

    if (!LOGO_SIZES.includes(sizeParam as LogoSize)) {
      return c.json({ error: `Invalid size. Allowed: ${LOGO_SIZES.join(", ")}` }, 400);
    }
    const size = sizeParam as LogoSize;

    const game = await db.game.findFirst({
      where: { slug: gameSlug },
      select: { id: true },
    });

    if (!game) {
      return c.json({ error: "Game not found" }, 404);
    }

    // 变体固定是 generateLogoVariants 出的 png；logo 最大 5MB，整块读比流省事
    const buf = await getBlob(logoSizedKey(game.id, size));
    if (!buf) return c.json({ error: "Logo not found" }, 404);

    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "public, max-age=86400");
    // 重包一层：node 的 Buffer<ArrayBufferLike> 不满足 hono 要的 Uint8Array<ArrayBuffer>
    return c.body(new Uint8Array(buf));
  } catch (error) {
    // 「没上传过」由 getBlob 返回 null 覆盖，走到这里的都是真异常
    logger.error("[getLogoSized] Error:", error);
    return c.json({ error: "Logo not found" }, 404);
  }
});

/**
 * 上传游戏 Logo
 */
gameConfigRoutes.post(":gameSlug/api/logo", async (c) => {
  try {
    const gameSlug = c.req.param("gameSlug");

    // 认证
    const userId = await resolveUserId(c.req.header("cookie") ?? null);
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // 查找游戏
    const game = await db.game.findFirst({
      where: { slug: gameSlug },
      select: { id: true },
    });

    if (!game) {
      return c.json({ error: "Game not found" }, 404);
    }

    // 检查权限
    const member = await db.gameMember.findFirst({
      where: { gameId: game.id, userId },
    });

    if (!member) {
      return c.json({ error: "No access" }, 403);
    }

    // 读取 body
    const body = Buffer.from(await c.req.arrayBuffer());

    if (body.length === 0) {
      return c.json({ error: "Empty body" }, 400);
    }

    if (body.length > 5 * 1024 * 1024) {
      return c.json({ error: "File too large (max 5MB)" }, 400);
    }

    // 解码失败是客户端传了 Jimp 不认的格式（webp/avif/heic），属输入问题，别当 500 抛出去
    let bitmap: { width: number; height: number };
    try {
      bitmap = (await Jimp.read(body)).bitmap;
    } catch {
      return c.json({ error: `Unsupported image format (${SUPPORTED_LOGO_FORMATS})` }, 400);
    }

    // 下限取最小那档变体：128/192 缩得清晰，只有 512 档会被放大糊掉，
    // 自部署场景不值得为此卡住上传（PWA 桌面图标才用得到 512）
    const { width, height } = bitmap;
    if (!width || !height || width < MIN_LOGO_SIZE || height < MIN_LOGO_SIZE) {
      return c.json(
        {
          error: `Logo must be at least ${MIN_LOGO_SIZE}x${MIN_LOGO_SIZE} pixels (got ${width}x${height})`,
        },
        400
      );
    }

    // 生成所有尺寸变体（512/192/128）
    const variants = await generateLogoVariants(body);

    const key = logoStorageKey(game.id);

    // 落盘原图 + 所有变体（原图只作重新生成变体的源，对外只暴露变体）
    await putBlob(key, body);
    await Promise.all(
      variants.map(({ size, buf }) => putBlob(logoSizedKey(game.id, size), buf))
    );

    const logoUrl = logoStorageKey(game.id);
    try {
      const existing = await db.gameConfig.findFirst({ where: { gameId: game.id } });

      if (existing) {
        const defaults = createDefaultGameConfig();
        const raw = existing.data as Record<string, unknown>;
        const merged = { ...defaults, ...raw, logoUrl };
        const data = GameConfigDataSchema.parse(merged);
        await db.gameConfig.update({
          where: { gameId: game.id },
          data: { data: data as unknown as Prisma.InputJsonValue, updatedAt: new Date() },
        });
      } else {
        const data = GameConfigDataSchema.parse({
          ...createDefaultGameConfig(),
          logoUrl,
        });
        await db.gameConfig.create({
          data: { gameId: game.id, data: data as unknown as Prisma.InputJsonValue },
        });
      }
    } catch (dbError) {
      // DB 写入失败：回滚已落盘的 logo，避免产生孤立文件
      logger.error("[uploadLogo] DB update failed, rolling back logo files:", dbError);
      try {
        await removeLogos(game.id);
      } catch (rollbackError) {
        logger.error("[uploadLogo] rollback also failed:", rollbackError);
      }
      throw dbError;
    }

    logger.log(`[uploadLogo] Logo uploaded for game ${gameSlug}`);
    return c.json({ logoUrl });
  } catch (error) {
    logger.error("[uploadLogo] Error:", error);
    return c.json({ error: "Upload failed" }, 500);
  }
});

/**
 * 删除游戏 Logo
 */
gameConfigRoutes.delete(":gameSlug/api/logo", async (c) => {
  try {
    const gameSlug = c.req.param("gameSlug");

    const userId = await resolveUserId(c.req.header("cookie") ?? null);
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const game = await db.game.findFirst({
      where: { slug: gameSlug },
      select: { id: true },
    });

    if (!game) {
      return c.json({ error: "Game not found" }, 404);
    }

    const member = await db.gameMember.findFirst({
      where: { gameId: game.id, userId },
    });

    if (!member) {
      return c.json({ error: "No access" }, 403);
    }

    // 先清除 DB 中的 logoUrl，再删磁盘文件
    const existing = await db.gameConfig.findFirst({ where: { gameId: game.id } });

    if (existing) {
      const defaults = createDefaultGameConfig();
      const raw = existing.data as Record<string, unknown>;
      const merged = { ...defaults, ...raw, logoUrl: "" };
      const data = GameConfigDataSchema.parse(merged);
      await db.gameConfig.update({
        where: { gameId: game.id },
        data: { data: data as unknown as Prisma.InputJsonValue, updatedAt: new Date() },
      });
    }

    // DB 更新成功后再清文件（失败只产生孤立文件，不影响一致性）
    try {
      await removeLogos(game.id);
    } catch {
      logger.warn(`[deleteLogo] cleanup failed for game ${game.id}, orphaned files may exist`);
    }

    logger.log(`[deleteLogo] Logo deleted for game ${gameSlug}`);
    return c.json({ ok: true });
  } catch (error) {
    logger.error("[deleteLogo] Error:", error);
    return c.json({ error: "Delete failed" }, 500);
  }
});
