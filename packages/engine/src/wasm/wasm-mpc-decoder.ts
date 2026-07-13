/**
 * WASM MPC 解码器（主线程同步路径）
 *
 * 支持两种格式：
 * - MSF v2 (Miu Sprite Format): zstd 压缩 + 调色板索引
 * - MPC (原始格式): RLE 压缩
 *
 * 解码逻辑在 wasm-decode-core.ts（与 Worker 共享）；使用前需要 await initWasm()
 */

import type { Mpc } from "../map/types";
import { buildMpcFromPayload, decodeMpcToPayload } from "./wasm-decode-core";
import { getWasmModule } from "./wasm-manager";

/**
 * 使用 WASM 解码 MPC 文件（支持 MSF v2 和原始 MPC 格式）
 * 返回 null 如果 WASM 不可用或解码失败
 */
export function decodeMpcWasm(buffer: ArrayBuffer): Mpc | null {
  const wasmModule = getWasmModule();
  if (!wasmModule) {
    return null;
  }

  const data = new Uint8Array(buffer);

  if (data.length < 8) {
    return null;
  }

  const payload = decodeMpcToPayload(wasmModule, data);
  return payload ? buildMpcFromPayload(payload) : null;
}
