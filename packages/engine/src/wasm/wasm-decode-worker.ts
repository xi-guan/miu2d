/**
 * WASM Decode Worker
 *
 * 在 Worker 线程中执行 CPU 密集的 MSF/ASF/MPC 解码，释放主线程渲染。
 * 解码结果以可转移的 ArrayBuffer 返回，主线程再组装 ImageData。
 * 解码逻辑在 wasm-decode-core.ts（与主线程同步路径共享），本文件只有消息循环。
 *
 * 消息协议：
 *   请求: { id, type: 'decode-asf' | 'decode-mpc', buffer: ArrayBuffer }
 *   回复: { id, ok: true, payload: AsfPayload | MpcPayload }
 *        { id, ok: false }
 */

import {
  type AsfPayload,
  decodeAsfToPayload,
  decodeMpcToPayload,
  type MpcPayload,
} from "./wasm-decode-core";
import type { WasmModule } from "./wasm-manager";

let wasmModule: WasmModule | null = null;
let wasmInitPromise: Promise<void> | null = null;

async function ensureWasm(): Promise<void> {
  if (wasmModule) return;
  if (wasmInitPromise) {
    await wasmInitPromise;
    return;
  }
  wasmInitPromise = (async () => {
    const wasm = await import("@miu2d/engine-wasm");
    await wasm.default();
    wasmModule = wasm as unknown as WasmModule;
  })();
  await wasmInitPromise;
}

// ===================== 消息循环 =====================

export type WorkerRequest = {
  id: number;
  type: "decode-asf" | "decode-mpc";
  buffer: ArrayBuffer;
};

export type WorkerResponse =
  | { id: number; ok: true; payload: AsfPayload | MpcPayload }
  | { id: number; ok: false };

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, type, buffer } = e.data;

  try {
    await ensureWasm();
    const data = new Uint8Array(buffer);

    if (type === "decode-asf") {
      const payload = decodeAsfToPayload(wasmModule as WasmModule, data);
      if (!payload) {
        (self as unknown as Worker).postMessage({ id, ok: false } satisfies WorkerResponse);
        return;
      }
      const transfers: Transferable[] = [payload.pixelBuffer];
      if (payload.frameSizesBuffer) transfers.push(payload.frameSizesBuffer);
      if (payload.frameOffsetsBuffer) transfers.push(payload.frameOffsetsBuffer);
      if (payload.canvasOffsetsBuffer) transfers.push(payload.canvasOffsetsBuffer);
      (self as unknown as Worker).postMessage(
        { id, ok: true, payload } satisfies WorkerResponse,
        transfers
      );
    } else {
      const payload = decodeMpcToPayload(wasmModule as WasmModule, data);
      if (!payload) {
        (self as unknown as Worker).postMessage({ id, ok: false } satisfies WorkerResponse);
        return;
      }
      const transfers: Transferable[] = [
        payload.pixelBuffer,
        payload.frameSizesBuffer,
        payload.frameOffsetsBuffer,
      ];
      if (payload.canvasOffsetsBuffer) transfers.push(payload.canvasOffsetsBuffer);
      (self as unknown as Worker).postMessage(
        { id, ok: true, payload } satisfies WorkerResponse,
        transfers
      );
    }
  } catch {
    (self as unknown as Worker).postMessage({ id, ok: false } satisfies WorkerResponse);
  }
};
