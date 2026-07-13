/**
 * WASM 精灵解码器（主线程同步路径）
 *
 * 支持两种格式：
 * - MSF v2 (Miu Sprite Format): zstd 压缩 + 调色板索引
 * - ASF 1.0 (原始格式): RLE 压缩
 *
 * 解码逻辑在 wasm-decode-core.ts（与 Worker 共享）；使用前需要 await initWasm()
 */

import { logger } from "../core/logger";
import type { AsfData } from "../resource/format/asf";
import { buildAsfFromPayload, decodeAsfToPayload } from "./wasm-decode-core";
import { getWasmModule } from "./wasm-manager";

/**
 * 使用 WASM 解码精灵文件（支持 MSF v2 和原始 ASF 格式）
 */
export function decodeAsfWasm(buffer: ArrayBuffer): AsfData | null {
  const wasmModule = getWasmModule();
  if (!wasmModule) {
    logger.warn("[SpriteDecoder] WASM not initialized");
    return null;
  }

  const data = new Uint8Array(buffer);

  if (data.length < 8) {
    logger.warn("[SpriteDecoder] Data too short");
    return null;
  }

  const payload = decodeAsfToPayload(wasmModule, data);
  return payload ? buildAsfFromPayload(payload) : null;
}
