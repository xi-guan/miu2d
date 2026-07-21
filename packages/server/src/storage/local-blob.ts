/**
 * 本地 blob 存储：用户上传（存档截图、游戏 logo）落盘
 *
 * key 结构沿用 S3 时代的 object key（saves/<userId>/<saveId>.jpg、games/<gameId>/_logo），
 * 所以 S3 退役时把残留对象按同样的路径拷进来就行，DB 里存的 key 一个都不用改。
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

/** 不存在返回 null，让调用方自己决定怎么兜 */
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
