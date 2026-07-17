/**
 * 一次性迁移脚本：将旧格式存档中的 otherCharacters + partnerRegistry 合并为统一的 characterProfiles。
 *
 * key 规则：
 *   - otherCharacters[N]              → idx:N
 *   - partnerRegistry[name] (有 API 玩家映射)  → idx:<index>
 *   - partnerRegistry[name] (无 API 映射)      → name:<name>
 *
 * 已包含 characterProfiles 的存档会被跳过。
 *
 * 用法：
 *   预览（默认）: cd packages/server && bunx tsx scripts/migrate-character-profile.ts
 *   实际写入   : cd packages/server && bunx tsx scripts/migrate-character-profile.ts --apply
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

interface MagicContainer {
  panelMagics: unknown[];
  xiuLianMagic: unknown;
  bottomMagics: unknown[];
  hiddenMagics: unknown[];
}

interface GoodsContainer {
  bagItems: unknown[];
  equipItems: unknown[];
  bottomItems: unknown[];
}

interface CharacterProfile {
  player: unknown;
  magicContainer: MagicContainer;
  goodsContainer: GoodsContainer;
  memo?: string[];
}

interface PartnerRegistryItem {
  character: unknown;
  magicContainer: MagicContainer;
  goodsContainer: GoodsContainer;
}

interface CharacterSaveSlot {
  player: unknown;
  magicContainer?: MagicContainer | null;
  goodsContainer?: GoodsContainer | null;
  memo?: string[] | null;
}

const EMPTY_MAGIC: MagicContainer = {
  panelMagics: [],
  xiuLianMagic: null,
  bottomMagics: [],
  hiddenMagics: [],
};

const EMPTY_GOODS: GoodsContainer = {
  bagItems: [],
  equipItems: [],
  bottomItems: [],
};

function buildProfiles(
  data: Record<string, unknown>,
  nameToIndex: Map<string, number>
): { profiles: Record<string, CharacterProfile>; conflicts: string[] } {
  const profiles: Record<string, CharacterProfile> = {};
  const conflicts: string[] = [];

  const otherCharacters = data.otherCharacters as Record<string, CharacterSaveSlot> | undefined;
  if (otherCharacters) {
    for (const [idx, slot] of Object.entries(otherCharacters)) {
      profiles[`idx:${idx}`] = {
        player: slot.player ?? null,
        magicContainer: slot.magicContainer ?? EMPTY_MAGIC,
        goodsContainer: slot.goodsContainer ?? EMPTY_GOODS,
        memo: slot.memo ?? undefined,
      };
    }
  }

  const partnerRegistry = data.partnerRegistry as Record<string, PartnerRegistryItem> | undefined;
  if (partnerRegistry) {
    for (const [name, entry] of Object.entries(partnerRegistry)) {
      const idx = nameToIndex.get(name);
      const key = idx !== undefined ? `idx:${idx}` : `name:${name}`;
      if (profiles[key]) {
        conflicts.push(`${key} (partner ${name})`);
        profiles[key].magicContainer = entry.magicContainer ?? profiles[key].magicContainer;
        profiles[key].goodsContainer = entry.goodsContainer ?? profiles[key].goodsContainer;
      } else {
        profiles[key] = {
          player: entry.character ?? null,
          magicContainer: entry.magicContainer ?? EMPTY_MAGIC,
          goodsContainer: entry.goodsContainer ?? EMPTY_GOODS,
        };
      }
    }
  }

  return { profiles, conflicts };
}

async function buildNameToIndex(pool: Pool): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const { rows } = await pool.query<{ name: string; index: number }>(
      'SELECT name, "index" FROM players'
    );
    for (const row of rows) {
      if (!map.has(row.name)) {
        map.set(row.name, row.index);
      }
    }
  } catch (err) {
    console.warn("[migrate] 无法查询 players 表，伙伴将全部回退到 name: 前缀:", err);
  }
  return map;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log(`[migrate-character-profile] mode: ${apply ? "APPLY" : "DRY-RUN"}`);

  try {
    const nameToIndex = await buildNameToIndex(pool);
    console.log(`[migrate-character-profile] players 映射条目: ${nameToIndex.size}`);

    const { rows } = await pool.query<{ id: string; data: Record<string, unknown> }>(
      `SELECT id, data FROM saves
       WHERE NOT (data ? 'characterProfiles')
         AND ((data ? 'otherCharacters') OR (data ? 'partnerRegistry'))`
    );

    console.log(`找到 ${rows.length} 条需要迁移的存档`);
    if (rows.length === 0) {
      console.log("无需迁移，退出");
      return;
    }

    let migrated = 0;
    let failed = 0;
    let totalConflicts = 0;

    for (const row of rows) {
      try {
        const { profiles, conflicts } = buildProfiles(row.data, nameToIndex);
        const profileCount = Object.keys(profiles).length;
        if (conflicts.length > 0) {
          totalConflicts += conflicts.length;
          console.warn(`! ${row.id} 冲突 key: ${conflicts.join(", ")}`);
        }
        if (apply) {
          const newData: Record<string, unknown> = { ...row.data, characterProfiles: profiles };
          delete newData.otherCharacters;
          delete newData.partnerRegistry;
          await pool.query("UPDATE saves SET data = $1::jsonb WHERE id = $2", [
            JSON.stringify(newData),
            row.id,
          ]);
        }
        migrated++;
        console.log(`${apply ? "✓" : "·"} ${row.id} (${profileCount} profiles)`);
      } catch (err) {
        failed++;
        console.error(`✗ ${row.id}:`, err);
      }
    }

    console.log(
      `\n迁移${apply ? "完成" : "预览"}：成功 ${migrated} 条，失败 ${failed} 条，冲突 ${totalConflicts} 处`
    );
    if (!apply) {
      console.log("使用 --apply 参数实际写入。");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("迁移失败:", err);
  process.exit(1);
});
