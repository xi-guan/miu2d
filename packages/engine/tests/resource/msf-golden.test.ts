/**
 * MSF/ASF/MPC 解码 golden 回归测试
 *
 * 用真实游戏资源做 WASM 解码基线: header 字段快照 + 解码输出 sha256。
 * 历史回归 (sword2 directions=0、tile 锚点丢失) 都发生在这一层 —
 * golden 变化 = converter 输出或解码行为变化, 必须人工确认后更新基线。
 *
 * 资源不入 git: 本地无 resources/ 时整组 skip。
 * 更新基线: GOLDEN_UPDATE=1 pnpm vitest run tests/resource/msf-golden.test.ts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import initWasm, {
  decode_asf_frames,
  decode_mpc_frames,
  decode_msf_individual_frames,
  parse_asf_header,
  parse_mpc_header,
  parse_msf_header,
} from "../../../engine-wasm/pkg/miu2d_engine_wasm.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(dirname, "../../../..");
const RESOURCES = path.join(REPO_ROOT, "resources");
const WASM_BINARY = path.join(REPO_ROOT, "packages/engine-wasm/pkg/miu2d_engine_wasm_bg.wasm");
const GOLDEN_PATH = path.join(dirname, "__golden__/msf-golden.json");
const UPDATE = !!process.env.GOLDEN_UPDATE;

/** 每条解码语义一个代表文件 (排序首个, 保证确定性) */
const FIXTURES: { name: string; file: string; kind: "msf" | "asf" | "mpc" }[] = [
  // MPC→MSF tile (Indexed8, flags bit1=0, 满幅帧语义)
  { name: "yueying-mpc-tile", file: "yueying/mpc/map/map_001_凌绝峰连接地图/map001-1.msf", kind: "msf" },
  // ASF→MSF character (Indexed8Alpha8)
  { name: "yueying-asf-character", file: "yueying/asf/character/npc005_pst.msf", kind: "msf" },
  // IMG→MSF tile (flags bit1=1, per-frame 锚点语义)
  { name: "sword2-img-tile", file: "sword2/msf/map/中都-矿山/树带雪_1.msf", kind: "msf" },
  // IMG→MSF character (directions/fps/anchor 曾出过回归的路径)
  { name: "sword2-img-character", file: "sword2/asf/character/8-普通女剑客-at.msf", kind: "msf" },
  // sword1 (yueying 同代, 走 MPC/ASF 路)
  { name: "sword1-mpc-tile", file: "sword1/mpc/map/map001_衡山/000.msf", kind: "msf" },
  { name: "sword1-asf-character", file: "sword1/asf/character/map005路人.msf", kind: "msf" },
  // 原始格式 (引擎仍按 magic 分支解码它们)
  { name: "yueying-original-mpc", file: "yueying/mpc/map/map_001_凌绝峰连接地图/map001-1.mpc", kind: "mpc" },
  { name: "yueying-original-asf", file: "yueying/asf/character/npc005_pst.asf", kind: "asf" },
];

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function decodeMsfFixture(data: Uint8Array) {
  const h = parse_msf_header(data);
  if (!h) throw new Error("parse_msf_header failed");
  const header = {
    canvasWidth: h.canvas_width,
    canvasHeight: h.canvas_height,
    frameCount: h.frame_count,
    directions: h.directions,
    fps: h.fps,
    anchorX: h.anchor_x,
    anchorY: h.anchor_y,
    pixelFormat: h.pixel_format,
    paletteSize: h.palette_size,
    framesPerDirection: h.frames_per_direction,
    flags: h.flags,
  };
  const pixels = new Uint8Array(h.total_individual_pixel_bytes);
  const frameSizes = new Uint8Array(h.frame_count * 2 * 4);
  const frameOffsets = new Uint8Array(h.frame_count * 4);
  const canvasOffsets = new Uint8Array(h.frame_count * 2 * 2);
  const decoded = decode_msf_individual_frames(data, pixels, frameSizes, frameOffsets, canvasOffsets);
  return {
    header,
    decodedFrames: decoded,
    sha256: {
      pixels: sha256(pixels),
      frameSizes: sha256(frameSizes),
      frameOffsets: sha256(frameOffsets),
      canvasOffsets: sha256(canvasOffsets),
    },
  };
}

function decodeAsfFixture(data: Uint8Array) {
  const h = parse_asf_header(data);
  if (!h) throw new Error("parse_asf_header failed");
  const header = {
    width: h.width,
    height: h.height,
    frameCount: h.frame_count,
    directions: h.directions,
    colorCount: h.color_count,
    interval: h.interval,
    left: h.left,
    bottom: h.bottom,
    framesPerDirection: h.frames_per_direction,
  };
  const pixels = new Uint8Array(h.width * h.height * 4 * h.frame_count);
  const decoded = decode_asf_frames(data, pixels);
  return { header, decodedFrames: decoded, sha256: { pixels: sha256(pixels) } };
}

function decodeMpcFixture(data: Uint8Array) {
  const h = parse_mpc_header(data);
  if (!h) throw new Error("parse_mpc_header failed");
  const header = {
    globalWidth: h.global_width,
    globalHeight: h.global_height,
    frameCount: h.frame_count,
    direction: h.direction,
    colorCount: h.color_count,
    interval: h.interval,
    left: h.left,
    bottom: h.bottom,
    framesDataLengthSum: h.frames_data_length_sum,
  };
  const pixels = new Uint8Array(h.total_pixel_bytes);
  const frameSizes = new Uint8Array(h.frame_count * 2 * 4);
  const frameOffsets = new Uint8Array(h.frame_count * 4);
  const decoded = decode_mpc_frames(data, pixels, frameSizes, frameOffsets);
  return {
    header,
    decodedFrames: decoded,
    sha256: {
      pixels: sha256(pixels),
      frameSizes: sha256(frameSizes),
      frameOffsets: sha256(frameOffsets),
    },
  };
}

const DECODERS = { msf: decodeMsfFixture, asf: decodeAsfFixture, mpc: decodeMpcFixture };

describe.skipIf(!existsSync(RESOURCES))("msf decode golden", () => {
  const golden: Record<string, unknown> = existsSync(GOLDEN_PATH)
    ? JSON.parse(readFileSync(GOLDEN_PATH, "utf8"))
    : {};
  const actual: Record<string, unknown> = {};

  beforeAll(async () => {
    await initWasm({ module_or_path: readFileSync(WASM_BINARY) });
  });

  afterAll(() => {
    if (UPDATE) {
      mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    }
  });

  for (const fixture of FIXTURES) {
    const filePath = path.join(RESOURCES, fixture.file);
    it.skipIf(!existsSync(filePath))(fixture.name, () => {
      const data = new Uint8Array(readFileSync(filePath));
      const result = DECODERS[fixture.kind](data);
      actual[fixture.name] = result;

      if (UPDATE) return;
      if (!(fixture.name in golden)) {
        throw new Error(`golden 缺 "${fixture.name}" — 先跑 GOLDEN_UPDATE=1 生成基线`);
      }
      expect(result).toEqual(golden[fixture.name]);
    });
  }
});
