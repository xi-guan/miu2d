/**
 * 文件公开访问路由（Hono）
 *
 * 提供 /game/:gameSlug/resources/* 路径的公开访问
 * 用于游戏客户端直接加载资源文件
 *
 * 内容一律读本地 resources/<slug>/（由内容镜像投放）；File 表只用来撑 dashboard
 * 的资源树，取用不依赖它，所以 sword1/sword2 没有记录也照样能取
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import * as fs from "node:fs";
import * as path from "node:path";
import { env } from "../env";
import { Logger } from "../utils/logger";

const logger = new Logger("FileRoutes");
// resolve from cwd (packages/server in dev, /app/packages/server in docker), NOT __dirname:
// the rolldown bundle sits a dir shallower than src, so __dirname-relative paths drift and 404
const RESOURCE_ROOT = path.resolve(env.resourceRoot);

// dev keeps no-cache so re-converted local assets show up immediately; prod assets change only via re-import
const CACHE_CONTROL = env.isProd ? `public, max-age=${env.assetCacheMaxAge}` : "no-cache";

// 大小写兜底的结果；没有它每次未命中都要逐层 readdir。短 TTL 让重新投放的素材可见
const CACHE_TTL_MS = 60_000;
const diskPathCache = new Map<string, { v: string | null; exp: number }>();

function cacheGet<T>(map: Map<string, { v: T; exp: number }>, key: string): { v: T } | undefined {
  const hit = map.get(key);
  return hit && hit.exp > Date.now() ? hit : undefined;
}

function cacheSet<T>(map: Map<string, { v: T; exp: number }>, key: string, v: T): void {
  // crude size bound: full reset beats unbounded growth from bogus paths
  if (map.size >= 20_000) map.clear();
  map.set(key, { v, exp: Date.now() + CACHE_TTL_MS });
}

/**
 * 大小写不敏感地解析磁盘路径：逐段扫目录取匹配项，任一段无匹配即返回 null。
 *
 * 素材的大小写本身就不自洽：yueying 的脚本对同一个文件用过 mc003/Mc003 两种写法，
 * 而 audio-manager 又把音乐名统一小写后再请求（磁盘上是 MC001.ogg）。改文件名或
 * 改引擎都堵不住，只能在这里兜。macOS 文件系统不区分大小写，所以这类 404 只在
 * Linux 上出现——本地永远复现不了。
 */
async function resolveCaseInsensitivePath(
  root: string,
  relativePath: string
): Promise<string | null> {
  let current = root;
  for (const segment of relativePath.split("/")) {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(current);
    } catch {
      return null;
    }
    const lower = segment.toLowerCase();
    const match = entries.find((e) => e.toLowerCase() === lower);
    if (!match) return null;
    current = path.join(current, match);
  }
  return current;
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

    // 读本地 resources/<gameSlug>/。以前这里先查 DB 拿 storageKey 再走 S3，
    // 每个素材请求要付一次 slug 查询 + 一次递归 CTE；S3 退役后那条路只剩开销
    const pathSegments = filePath.split("/").filter(Boolean);
    const relativePath = pathSegments.join("/");
    const gameResourceRoot = path.join(RESOURCE_ROOT, gameSlug);

    // MSF/MPC 路径兼容：引擎期望 msf/map/... 但本地文件在 mpc/map/...
    const candidates = [relativePath];
    if (relativePath.startsWith("msf/map/")) candidates.push(`mpc${relativePath.slice(3)}`);

    // 防止路径遍历攻击
    if (candidates.some((rel) => !path.join(gameResourceRoot, rel).startsWith(gameResourceRoot))) {
      return c.json({ error: "Invalid path" }, 403);
    }

    // stat 兼作存在性检查并给出 size/mtime 供 etag; 一次 async stat 取代原来的
    // existsSync×2 + statSync (每次同步调用都会阻塞事件循环, 跑图时并发几百 tile 会互卡)
    let localPath: string | null = null;
    let stat: fs.Stats | null = null;
    for (const rel of candidates) {
      const p = path.join(gameResourceRoot, rel);
      try {
        const s = await fs.promises.stat(p);
        // 目录不可取用；以前靠 DB 记录的 type 挡掉，现在不查库了得自己判
        if (!s.isFile()) continue;
        stat = s;
        localPath = p;
        break;
      } catch {
        // 换下一个候选
      }
    }

    // 字面路径都没命中才扫目录做大小写兜底——它比 stat 贵，不能进热路径
    if (!localPath) {
      for (const rel of candidates) {
        const key = `${gameSlug}:${rel}`;
        const hit = cacheGet(diskPathCache, key);
        const resolved = hit ? hit.v : await resolveCaseInsensitivePath(gameResourceRoot, rel);
        if (!hit) cacheSet(diskPathCache, key, resolved);
        if (!resolved) continue;
        try {
          const s = await fs.promises.stat(resolved);
          if (!s.isFile()) continue;
          stat = s;
          localPath = resolved;
          break;
        } catch {
          // 缓存里的路径已失效（素材被内容镜像换过），当未命中处理
        }
      }
    }

    if (!localPath || !stat) {
      return c.json({ error: "File not found" }, 404);
    }

    // 协商缓存: 否则 dev 的 no-cache 下浏览器每次全量重下, 跑图时 tile/精灵反复整包传输
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

    // hono stream(): await write 天然 backpressure (慢客户端不会把整个文件积压进内存),
    // onAbort 断连时销毁 fileStream 释放 fd。取代原先手写的 wrapper——它无 backpressure,
    // 且靠 closed 标志硬防 enqueue-after-close 崩进程
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
