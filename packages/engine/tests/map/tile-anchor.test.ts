/**
 * 瓦片锚点定位测试
 *
 * 两种 MSF 来源、两套定位语义:
 * - 原始 MPC / MPC→MSF (yueying): 满幅帧, 几何回退 (居中, 底边贴 py+16)
 * - IMG→MSF (sword2, flags bit1): 紧致帧 + per-frame offset, 按 header 锚点定位
 *   drawX = px - left + offX, drawY = py - (bottom - 16) + offY
 *
 * 用例数据取自实测 resources/sword2/msf/map/主角家/jiaju04.msf:
 * canvas 62x118, left=31, bottom=121; 帧77 (对联) 26x30 @ (34,25) —
 * 忽略 offset 时低 66px (对联落地 bug 的最小复现)。
 */

import { describe, expect, it } from "vitest";
import { createMapRenderer, getTileTextureRegion, type MpcAtlas } from "../../src/map/map-renderer";
import type { MiuMapData } from "../../src/map/types";

/** 构造 1x1 地图, layer1 引用 atlas 0 的指定帧 */
function makeRenderer(atlas: MpcAtlas, frame: number) {
  const renderer = createMapRenderer();
  renderer.isLoading = false;
  renderer.mpcAtlases = [atlas];
  renderer.mapData = {
    mapColumnCounts: 1,
    mapRowCounts: 1,
    layer1: new Uint8Array([1, frame]),
    layer2: new Uint8Array([0, 0]),
    layer3: new Uint8Array([0, 0]),
  } as unknown as MiuMapData;
  return renderer;
}

// getTileTextureRegion 不触碰 canvas, 测试无需 DOM
const fakeCanvas = null as unknown as HTMLCanvasElement;

describe("tile positioning", () => {
  // tile (0,0) → px=0, py=0 (tileToPixel)

  it("legacy atlas (yueying/original MPC): centered, bottom-anchored at py+16", () => {
    const atlas: MpcAtlas = {
      canvas: fakeCanvas,
      rects: [{ x: 0, y: 0, w: 62, h: 32, offX: 0, offY: 0 }],
      bottom: 144, // ASF 语义的 bottom 不参与 legacy tile 定位
      left: 31,
      anchored: false,
    };
    const region = getTileTextureRegion(makeRenderer(atlas, 0), 0, 0, "layer1");
    expect(region).toEqual({ x: -31, y: -16, width: 62, height: 32 });
  });

  it("anchored atlas (sword2 IMG): header anchor + per-frame offset", () => {
    // jiaju04.msf 帧77 (对联): 26x30 @ offset (34,25), left=31, bottom=121
    const atlas: MpcAtlas = {
      canvas: fakeCanvas,
      rects: [{ x: 0, y: 0, w: 26, h: 30, offX: 34, offY: 25 }],
      bottom: 121,
      left: 31,
      anchored: true,
    };
    const region = getTileTextureRegion(makeRenderer(atlas, 0), 0, 0, "layer1");
    // x = 0 - 31 + 34 = 3; y = 0 - (121-16) + 25 = -80 (挂墙, 而非落地的 -14)
    expect(region).toEqual({ x: 3, y: -80, width: 26, height: 30 });
  });

  it("anchored ground tile: identical to legacy result (bottom==h, offset 0)", () => {
    // ground-沙漠.msf: 62x32 满幅帧, left=31, bottom=32
    const atlas: MpcAtlas = {
      canvas: fakeCanvas,
      rects: [{ x: 0, y: 0, w: 62, h: 32, offX: 0, offY: 0 }],
      bottom: 32,
      left: 31,
      anchored: true,
    };
    const region = getTileTextureRegion(makeRenderer(atlas, 0), 0, 0, "layer1");
    expect(region).toEqual({ x: -31, y: -16, width: 62, height: 32 });
  });
});
