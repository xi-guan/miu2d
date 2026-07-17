/**
 * 文件公开访问路由（Hono）
 *
 * 提供 /game/:gameSlug/resources/* 路径的公开访问
 * 用于游戏客户端直接加载资源文件
 *
 * 开发模式回退：MinIO 无文件时从本地 resources/ 目录读取
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import * as fs from "node:fs";
import * as path from "node:path";
import { db } from "../db/client";
import { env } from "../env";
import * as s3 from "../storage/s3";
import { resolveFilePath } from "../utils/file";
import { Logger } from "../utils/logger";

const logger = new Logger("FileRoutes");
// resolve from cwd (packages/server in dev, /app/packages/server in docker), NOT __dirname:
// the rolldown bundle sits a dir shallower than src, so __dirname-relative paths drift and 404
const RESOURCE_ROOT = path.resolve(env.resourceRoot);

// dev keeps no-cache so re-converted local assets show up immediately; prod assets change only via re-import
const CACHE_CONTROL = env.isProd ? `public, max-age=${env.assetCacheMaxAge}` : "no-cache";

// every asset request used to cost a slug lookup + a recursive CTE; short TTL keeps fresh imports visible
const CACHE_TTL_MS = 60_000;
const gameIdCache = new Map<string, { v: string | null; exp: number }>();
const fileCache = new Map<string, { v: Awaited<ReturnType<typeof resolveFilePath>>; exp: number }>();

function cacheGet<T>(map: Map<string, { v: T; exp: number }>, key: string): { v: T } | undefined {
  const hit = map.get(key);
  return hit && hit.exp > Date.now() ? hit : undefined;
}

function cacheSet<T>(map: Map<string, { v: T; exp: number }>, key: string, v: T): void {
  // crude size bound: full reset beats unbounded growth from bogus paths
  if (map.size >= 20_000) map.clear();
  map.set(key, { v, exp: Date.now() + CACHE_TTL_MS });
}

const MIME_TYPES: Record<string, string> = {
  ".asf": "application/octet-stream",
  ".msf": "application/octet-stream",
  ".map": "application/octet-stream",
  ".mmf": "application/octet-stream",
  ".shd": "application/octet-stream",
  ".xnb": "application/octet-stream",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".ini": "text/plain",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".lua": "text/plain",
  ".npc": "text/plain",
};

function detectMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? null;
}

export const fileRoutes = new Hono();

/**
 * 公开访问游戏资源文件
 *
 * GET /game/:gameSlug/resources/*resourcePath
 * 例如: /game/william-chan/resources/测试/1.txt
 */
fileRoutes.get(":gameSlug/resources/*", async (c) => {
  try {
    const gameSlug = c.req.param("gameSlug");
    // 从 URL 中提取完整路径（去除 /:gameSlug/resources/ 前缀）
    const fullPath = new URL(c.req.url).pathname;
    const prefix = `/game/${gameSlug}/resources/`;
    const filePath = decodeURIComponent(fullPath.substring(prefix.length));

    if (!filePath) {
      return c.json({ error: "File path is required" }, 400);
    }

    logger.debug(`[getResource] gameSlug=${gameSlug}, filePath=${filePath}`);

    // 1. 根据 slug 获取游戏
    let gameId: string | null;
    const gameHit = cacheGet(gameIdCache, gameSlug);
    if (gameHit) {
      gameId = gameHit.v;
    } else {
      const game = await db.game.findFirst({ where: { slug: gameSlug }, select: { id: true } });
      gameId = game?.id ?? null;
      cacheSet(gameIdCache, gameSlug, gameId);
    }

    if (!gameId) {
      return c.json({ error: "Game not found" }, 404);
    }

    // 2. 解析路径，找到目标文件
    const pathSegments = filePath.split("/").filter(Boolean);
    let file: Awaited<ReturnType<typeof resolveFilePath>>;
    const fileHit = cacheGet(fileCache, `${gameId}:${filePath}`);
    if (fileHit) {
      file = fileHit.v;
    } else {
      file = await resolveFilePath(gameId, pathSegments);
      cacheSet(fileCache, `${gameId}:${filePath}`, file);
    }

    if (file) {
      if (file.type !== "file" || !file.storageKey) {
        return c.json({ error: "Path is not a file" }, 400);
      }

      // 3. 从 S3 获取文件流
      const ifNoneMatch = c.req.header("if-none-match");
      const {
        stream: fileStream,
        contentType,
        contentLength,
        etag,
        notModified,
      } = await s3.getFileStream(file.storageKey, ifNoneMatch);

      if (notModified) {
        c.header("Cache-Control", CACHE_CONTROL);
        if (etag) c.header("ETag", etag);
        return c.body(null, 304);
      }

      // 4. 设置响应头
      c.header("Content-Type", file.mimeType || contentType || "application/octet-stream");
      if (contentLength !== undefined) {
        c.header("Content-Length", String(contentLength));
      }
      c.header("Cache-Control", CACHE_CONTROL);
      if (etag) c.header("ETag", etag);

      // 5. 流式传输
      return stream(c, async (s) => {
        for await (const chunk of fileStream) {
          await s.write(chunk as Uint8Array);
        }
      });
    }

    // 6. 开发回退：从本地 resources/<gameSlug>/ 目录读取（MinIO 无文件时）
    const relativePath = pathSegments.join("/");
    const gameResourceRoot = path.join(RESOURCE_ROOT, gameSlug);
    let localPath = path.join(gameResourceRoot, relativePath);
    // 防止路径遍历攻击
    if (!localPath.startsWith(gameResourceRoot)) {
      return c.json({ error: "Invalid path" }, 403);
    }

    // stat 兼作存在性检查并给出 size/mtime 供 etag; 一次 async stat 取代原来的
    // existsSync×2 + statSync (每次同步调用都会阻塞事件循环, 跑图时并发几百 tile 会互卡)
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(localPath);
    } catch {
      // MSF/MPC 路径兼容：引擎期望 msf/map/... 但本地文件在 mpc/map/...
      if (relativePath.startsWith("msf/map/")) {
        localPath = path.join(gameResourceRoot, "mpc" + relativePath.slice(3));
        try {
          stat = await fs.promises.stat(localPath);
        } catch {
          return c.json({ error: "File not found" }, 404);
        }
      } else {
        return c.json({ error: "File not found" }, 404);
      }
    }

    // 磁盘回退也要支持协商缓存: 否则 dev 的 no-cache 下浏览器每次全量重下,
    // 跑图时 tile/精灵反复整包传输 (S3 路径有 ETag/304, 两路径行为须对称)
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    if (c.req.header("if-none-match") === etag) {
      c.header("Cache-Control", CACHE_CONTROL);
      c.header("ETag", etag);
      return c.body(null, 304);
    }

    c.header("Content-Type", detectMimeType(localPath) || "application/octet-stream");
    c.header("Cache-Control", CACHE_CONTROL);
    c.header("ETag", etag);
    c.header("Content-Length", String(stat.size));

    // 与 S3 分支对称走 hono stream(): await write 天然 backpressure (慢客户端不会把
    // 整个文件积压进内存), onAbort 断连时销毁 fileStream 释放 fd。取代原先手写的
    // wrapper——它无 backpressure, 且靠 closed 标志硬防 enqueue-after-close 崩进程
    const fileStream = fs.createReadStream(localPath);
    return stream(c, async (s) => {
      s.onAbort(() => {
        fileStream.destroy();
      });
      try {
        for await (const chunk of fileStream) {
          if (s.aborted) break;
          await s.write(chunk as Uint8Array);
        }
      } catch {
        // 客户端中途断开: fd 已由 onAbort 销毁, 静默收尾即可
      }
    });
  } catch (error) {
    logger.error("[getResource] Error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});
