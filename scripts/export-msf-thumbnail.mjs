#!/usr/bin/env node
import { deflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import initWasm, { decode_msf_individual_frames, parse_msf_header } from "../packages/engine-wasm/pkg/miu2d_engine_wasm.js";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const input = args.get("--input");
const output = args.get("--output");

if (!input || !output) {
  console.error("usage: node scripts/export-msf-thumbnail.mjs --input <file.msf> --output <file.png>");
  process.exit(1);
}

const wasmBytes = await readFile(new URL("../packages/engine-wasm/pkg/miu2d_engine_wasm_bg.wasm", import.meta.url));
await initWasm({ module_or_path: wasmBytes });

const data = new Uint8Array(await readFile(input));
const header = parse_msf_header(data);
const pixels = new Uint8Array(header.total_individual_pixel_bytes);
const frameSizes = new Uint8Array(header.frame_count * 2 * 4);
const frameOffsets = new Uint8Array(header.frame_count * 4);
const canvasOffsets = new Uint8Array(header.frame_count * 2 * 2);
const frameCount = decode_msf_individual_frames(data, pixels, frameSizes, frameOffsets, canvasOffsets);

if (!frameCount) {
  console.error(`decode failed: ${input}`);
  process.exit(1);
}

const sizes = new Uint32Array(frameSizes.buffer);
const offsets = new Uint32Array(frameOffsets.buffer);
const width = sizes[0];
const height = sizes[1];
const offset = offsets[0];
const rgba = pixels.subarray(offset, offset + width * height * 4);

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, encodePng(width, height, rgba));
console.log(JSON.stringify({ input, output, frameCount, width, height }, null, 2));

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (width * 4 + 1);
    raw[dst] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, dst + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
