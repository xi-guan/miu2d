/**
 * NPC queries tests - 查询工具函数
 *
 * findClosestCharacter 的 NPC 最近查找已迁移到 WASM AiSearch
 * (engine-wasm/src/ai_search.rs, 自带 Rust 单测), 无 wasm 环境时该路径不生效。
 * 这里覆盖纯 JS 部分: player 比较路径 + findCharactersInTileDistance。
 */
import { describe, expect, it } from "vitest";
import { findCharactersInTileDistance, findClosestCharacter } from "../../src/npc/npc-query-helpers";

// Minimal Npc-like mock
function mockNpc(
  id: string,
  x: number,
  y: number,
  opts: { isDeathInvoked?: boolean } = {}
) {
  return {
    id,
    positionInWorld: { x, y },
    tilePosition: { x: Math.floor(x / 64), y: Math.floor(y / 32) },
    isDeathInvoked: opts.isDeathInvoked ?? false,
  } as never;
}

function mockPlayer(x: number, y: number, opts: { isDeathInvoked?: boolean } = {}) {
  return {
    positionInWorld: { x, y },
    tilePosition: { x: Math.floor(x / 64), y: Math.floor(y / 32) },
    isDeathInvoked: opts.isDeathInvoked ?? false,
  } as never;
}

type MockNpc = ReturnType<typeof mockNpc>;

function makeNpcMap(...npcs: MockNpc[]): Map<string, never> {
  const map = new Map<string, never>();
  for (const npc of npcs) {
    map.set((npc as { id: string }).id, npc);
  }
  return map;
}

describe("findClosestCharacter (player path)", () => {
  it("returns null when no player", () => {
    const result = findClosestCharacter(null, { x: 0, y: 0 });
    expect(result).toBeNull();
  });

  it("returns player when playerFilter passes", () => {
    const player = mockPlayer(5, 5);
    const result = findClosestCharacter(player, { x: 0, y: 0 }, () => true);
    expect(result).toBe(player);
  });

  it("skips player when playerFilter not provided", () => {
    const player = mockPlayer(5, 5);
    const result = findClosestCharacter(player, { x: 0, y: 0 });
    expect(result).toBeNull();
  });

  it("skips player when playerFilter rejects", () => {
    const player = mockPlayer(5, 5);
    const result = findClosestCharacter(player, { x: 0, y: 0 }, () => false);
    expect(result).toBeNull();
  });

  it("skips player in ignoreList", () => {
    const player = mockPlayer(5, 5);
    const result = findClosestCharacter(player, { x: 0, y: 0 }, () => true, [player]);
    expect(result).toBeNull();
  });

  it("skips dead player", () => {
    const player = mockPlayer(1, 1, { isDeathInvoked: true });
    const result = findClosestCharacter(player, { x: 0, y: 0 }, () => true);
    expect(result).toBeNull();
  });
});

describe("findCharactersInTileDistance", () => {
  it("returns empty array when no matches", () => {
    const result = findCharactersInTileDistance(
      new Map(),
      null,
      { x: 0, y: 0 },
      5,
      () => true
    );
    expect(result).toEqual([]);
  });

  it("finds NPCs within tile distance", () => {
    // tilePosition = {x:0, y:0}, {x:1, y:0}, {x:10, y:10}
    const close = mockNpc("close", 30, 10);
    const mid = mockNpc("mid", 60, 10);
    const far = mockNpc("far", 640, 320);
    const npcs = makeNpcMap(close, mid, far);

    const result = findCharactersInTileDistance(
      npcs,
      null,
      { x: 0, y: 0 },
      3,
      () => true
    );

    // close and mid should be within 3 tiles; far (10,10) should not
    expect(result).toContain(close);
    expect(result).toContain(mid);
    expect(result).not.toContain(far);
  });

  it("applies NPC filter", () => {
    const excluded = mockNpc("excluded", 30, 10);
    const included = mockNpc("included", 60, 10);
    const npcs = makeNpcMap(excluded, included);

    const result = findCharactersInTileDistance(
      npcs,
      null,
      { x: 0, y: 0 },
      3,
      (npc) => (npc as { id: string }).id === "included"
    );

    expect(result).toContain(included);
    expect(result).not.toContain(excluded);
  });

  it("includes player when in range and filter passes", () => {
    const npcs = makeNpcMap(mockNpc("npc1", 640, 320)); // far
    const player = mockPlayer(30, 10); // close

    const result = findCharactersInTileDistance(
      npcs,
      player,
      { x: 0, y: 0 },
      3,
      () => true,
      () => true
    );

    expect(result).toContain(player);
  });
});
