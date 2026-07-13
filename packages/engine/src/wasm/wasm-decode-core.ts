/**
 * WASM 解码核心 — 主线程与 Worker 共享的唯一实现
 *
 * 两层结构:
 *   decodeAsfToPayload / decodeMpcToPayload  格式分支 (MSF v2 vs 原始 ASF/MPC) → WASM 解码 → 可转移 payload
 *   buildAsfFromPayload / buildMpcFromPayload  payload → AsfData / Mpc (ImageData 组装, 仅主线程调用)
 *
 * Worker (wasm-decode-worker.ts) 与主线程同步路径 (wasm-asf-decoder.ts /
 * wasm-mpc-decoder.ts) 都委托到这里 — 解码行为改动只改本文件。
 */

import type { Mpc, MpcFrame, MpcHead } from "../map/types";
import type { AsfData, AsfFrame } from "../resource/format/asf";
import type { WasmModule } from "./wasm-manager";

/** MSF v2 magic bytes: "MSF2" (little-endian)。本地声明以避免 Worker bundle 引入 wasm-manager 的运行时依赖 */
const MSF_MAGIC = 0x3246534d;

// ===================== Payload 类型 =====================

export interface AsfPayload {
  kind: "asf";
  /** Canvas width (used for anchor positioning) */
  width: number;
  /** Canvas height (used for anchor positioning) */
  height: number;
  frameCount: number;
  directions: number;
  colorCount: number;
  interval: number;
  left: number;
  bottom: number;
  framesPerDirection: number;
  pixelFormat: number;
  /** 所有帧的像素数据（RGBA，连续存储） */
  pixelBuffer: ArrayBuffer;
  /** Per-frame sizes [w0,h0,w1,h1,...] — tight bounding box. Absent → all frames are width×height */
  frameSizesBuffer?: ArrayBuffer;
  /** Per-frame pixel offsets in pixelBuffer [off0,off1,...] */
  frameOffsetsBuffer?: ArrayBuffer;
  /** Per-frame canvas offsets [ox0,oy0,ox1,oy1,...] — position of tight bbox within canvas */
  canvasOffsetsBuffer?: ArrayBuffer;
}

export interface MpcPayload {
  kind: "mpc";
  framesDataLengthSum: number;
  globalWidth: number;
  globalHeight: number;
  frameCount: number;
  direction: number;
  colorCount: number;
  interval: number;
  bottom: number;
  left: number;
  /** 所有帧的像素数据（RGBA，按帧偏移索引） */
  pixelBuffer: ArrayBuffer;
  /** Uint32Array 视图：[w0, h0, w1, h1, …] */
  frameSizesBuffer: ArrayBuffer;
  /** Uint32Array 视图：[offset0, offset1, …] */
  frameOffsetsBuffer: ArrayBuffer;
  /** MSF flags bit1：帧带 per-frame 画布偏移（IMG 转换的 tile） */
  tileAnchored: boolean;
  /** Int16Array 视图：[ox0, oy0, ox1, oy1, …]（仅 tileAnchored 时存在） */
  canvasOffsetsBuffer?: ArrayBuffer;
}

// ===================== 解码 → payload =====================

export function decodeAsfToPayload(wasm: WasmModule, data: Uint8Array): AsfPayload | null {
  const magic = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);

  if (magic === MSF_MAGIC) {
    const header = wasm.parse_msf_header(data);
    if (!header) return null;

    // Decode as tight-bbox individual frames instead of canvas-sized
    const pixelOutput = new Uint8Array(header.total_individual_pixel_bytes);
    const frameSizesOutput = new Uint8Array(header.frame_count * 2 * 4);
    const frameOffsetsOutput = new Uint8Array(header.frame_count * 4);
    const canvasOffsetsOutput = new Uint8Array(header.frame_count * 2 * 2); // i16 pairs

    const decoded = wasm.decode_msf_individual_frames(
      data,
      pixelOutput,
      frameSizesOutput,
      frameOffsetsOutput,
      canvasOffsetsOutput
    );
    if (decoded === 0) return null;

    const interval = header.fps > 0 ? Math.round(1000 / header.fps) : 67;
    return {
      kind: "asf",
      width: header.canvas_width,
      height: header.canvas_height,
      frameCount: header.frame_count,
      directions: header.directions,
      colorCount: header.palette_size,
      interval,
      left: header.anchor_x,
      bottom: header.anchor_y,
      framesPerDirection: header.frames_per_direction,
      pixelFormat: header.pixel_format,
      pixelBuffer: pixelOutput.buffer,
      frameSizesBuffer: frameSizesOutput.buffer,
      frameOffsetsBuffer: frameOffsetsOutput.buffer,
      canvasOffsetsBuffer: canvasOffsetsOutput.buffer,
    };
  }

  // 原始 ASF 格式
  const header = wasm.parse_asf_header(data);
  if (!header) return null;

  const frameSize = header.width * header.height * 4;
  const allPixels = new Uint8Array(frameSize * header.frame_count);

  const decoded = wasm.decode_asf_frames(data, allPixels);
  if (decoded === 0) return null;

  return {
    kind: "asf",
    width: header.width,
    height: header.height,
    frameCount: header.frame_count,
    directions: header.directions,
    colorCount: header.color_count,
    interval: header.interval || 67,
    left: header.left,
    bottom: header.bottom,
    framesPerDirection: header.frames_per_direction,
    pixelFormat: 0,
    pixelBuffer: allPixels.buffer,
  };
}

export function decodeMpcToPayload(wasm: WasmModule, data: Uint8Array): MpcPayload | null {
  const magic = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);

  if (magic === MSF_MAGIC) {
    // MSF → MPC 路径
    const header = wasm.parse_msf_header(data);
    if (!header) return null;

    const pixelOutput = new Uint8Array(header.total_individual_pixel_bytes);
    const frameSizesOutput = new Uint8Array(header.frame_count * 2 * 4);
    const frameOffsetsOutput = new Uint8Array(header.frame_count * 4);

    // flags bit1: tile 带 per-frame 画布偏移，请求 canvas offsets 供锚点定位
    const tileAnchored = (header.flags & 2) !== 0;
    const canvasOffsetsOutput = tileAnchored
      ? new Uint8Array(header.frame_count * 2 * 2)
      : undefined;

    const frameCount = wasm.decode_msf_individual_frames(
      data,
      pixelOutput,
      frameSizesOutput,
      frameOffsetsOutput,
      canvasOffsetsOutput
    );
    if (frameCount === 0) return null;

    return {
      kind: "mpc",
      framesDataLengthSum: 0,
      globalWidth: header.canvas_width,
      globalHeight: header.canvas_height,
      frameCount: header.frame_count,
      direction: header.directions,
      colorCount: header.palette_size,
      interval: Math.round(1000 / Math.max(header.fps, 1)),
      bottom: header.anchor_y,
      left: header.anchor_x,
      pixelBuffer: pixelOutput.buffer,
      frameSizesBuffer: frameSizesOutput.buffer,
      frameOffsetsBuffer: frameOffsetsOutput.buffer,
      tileAnchored,
      canvasOffsetsBuffer: canvasOffsetsOutput?.buffer,
    };
  }

  // 原始 MPC 格式
  const header = wasm.parse_mpc_header(data);
  if (!header) return null;

  const pixelOutput = new Uint8Array(header.total_pixel_bytes);
  const frameSizesOutput = new Uint8Array(header.frame_count * 2 * 4);
  const frameOffsetsOutput = new Uint8Array(header.frame_count * 4);

  const frameCount = wasm.decode_mpc_frames(
    data,
    pixelOutput,
    frameSizesOutput,
    frameOffsetsOutput
  );
  if (frameCount === 0) return null;

  return {
    kind: "mpc",
    framesDataLengthSum: header.frames_data_length_sum,
    globalWidth: header.global_width,
    globalHeight: header.global_height,
    frameCount: header.frame_count,
    direction: header.direction,
    colorCount: header.color_count,
    interval: header.interval,
    bottom: header.bottom,
    left: header.left,
    pixelBuffer: pixelOutput.buffer,
    frameSizesBuffer: frameSizesOutput.buffer,
    frameOffsetsBuffer: frameOffsetsOutput.buffer,
    tileAnchored: false,
  };
}

// ===================== payload → 对象组装 (主线程) =====================

export function buildAsfFromPayload(payload: AsfPayload): AsfData {
  const { width, height, frameCount } = payload;
  const allPixels = new Uint8Array(payload.pixelBuffer);
  const frames: AsfFrame[] = [];

  if (payload.frameSizesBuffer && payload.frameOffsetsBuffer) {
    // Tight-bbox per-frame decoding (MSF path)
    const frameSizes = new Uint32Array(payload.frameSizesBuffer);
    const frameOffsets = new Uint32Array(payload.frameOffsetsBuffer);
    const canvasOffsets = payload.canvasOffsetsBuffer
      ? new Int16Array(payload.canvasOffsetsBuffer)
      : null;

    for (let i = 0; i < frameCount; i++) {
      const w = frameSizes[i * 2];
      const h = frameSizes[i * 2 + 1];
      const offset = frameOffsets[i];
      const size = w * h * 4;
      const slice = new Uint8ClampedArray(size);
      slice.set(allPixels.subarray(offset, offset + size));
      frames.push({
        width: w,
        height: h,
        imageData: new ImageData(slice, w, h),
        canvas: null,
        canvasOffsetX: canvasOffsets ? canvasOffsets[i * 2] : 0,
        canvasOffsetY: canvasOffsets ? canvasOffsets[i * 2 + 1] : 0,
      });
    }
  } else {
    // Legacy uniform-sized decoding (old ASF path)
    const frameSize = width * height * 4;
    for (let i = 0; i < frameCount; i++) {
      const offset = i * frameSize;
      const slice = new Uint8ClampedArray(allPixels.buffer, offset, frameSize);
      frames.push({
        width,
        height,
        imageData: new ImageData(slice, width, height),
        canvas: null,
        canvasOffsetX: 0,
        canvasOffsetY: 0,
      });
    }
  }

  return {
    width: payload.width,
    height: payload.height,
    frameCount: payload.frameCount,
    directions: payload.directions,
    colorCount: payload.colorCount,
    interval: payload.interval,
    left: payload.left,
    bottom: payload.bottom,
    framesPerDirection: payload.framesPerDirection,
    frames,
    isLoaded: true,
    pixelFormat: payload.pixelFormat,
  };
}

export function buildMpcFromPayload(payload: MpcPayload): Mpc {
  const frameSizes = new Uint32Array(payload.frameSizesBuffer);
  const frameOffsets = new Uint32Array(payload.frameOffsetsBuffer);
  const allPixels = new Uint8Array(payload.pixelBuffer);
  const canvasOffsets = payload.canvasOffsetsBuffer
    ? new Int16Array(payload.canvasOffsetsBuffer)
    : null;

  const frames: MpcFrame[] = [];
  for (let i = 0; i < payload.frameCount; i++) {
    const w = frameSizes[i * 2];
    const h = frameSizes[i * 2 + 1];
    const offset = frameOffsets[i];
    const size = w * h * 4;
    const pixelData = new Uint8ClampedArray(size);
    pixelData.set(allPixels.subarray(offset, offset + size));
    if (canvasOffsets) {
      frames.push({
        width: w,
        height: h,
        imageData: new ImageData(pixelData, w, h),
        offsetX: canvasOffsets[i * 2],
        offsetY: canvasOffsets[i * 2 + 1],
      });
    } else {
      frames.push({ width: w, height: h, imageData: new ImageData(pixelData, w, h) });
    }
  }

  const head: MpcHead = {
    framesDataLengthSum: payload.framesDataLengthSum,
    globalWidth: payload.globalWidth,
    globalHeight: payload.globalHeight,
    frameCounts: payload.frameCount,
    direction: payload.direction,
    colourCounts: payload.colorCount,
    interval: payload.interval,
    bottom: payload.bottom,
    left: payload.left,
    tileAnchored: payload.tileAnchored,
  };

  return { head, frames, palette: [] };
}
