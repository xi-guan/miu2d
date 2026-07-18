/**
 * 游戏内容种子导出（DB → JSON）
 *
 * 按 slug 导出一个游戏的全部内容表(保留 UUID, 换 id 会断 S3 logo key
 * games/<gameId>/_logo)。产物供 seed-games.ts 在空库启动时整套插入,
 * 随游戏内容镜像分发。用户态表(User/Session/GameMember/Save)不导。
 *
 * 用法:
 *   tsx --tsconfig tsconfig.dev.json scripts/export-game-seed.ts <slug>
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { db } from "../src/db/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../../..", ".data/game-seeds");

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("usage: export-game-seed.ts <slug>");
    process.exit(1);
  }

  const game = await db.game.findFirst({ where: { slug } });
  if (!game) {
    console.error(`✗ game not found: ${slug}`);
    process.exit(1);
  }
  const where = { gameId: game.id };

  // key = prisma model accessor; seed-games.ts 按自己的 FK 序插入, 此处顺序无关
  const tables = {
    gameConfig: await db.gameConfig.findMany({ where }),
    magic: await db.magic.findMany({ where }),
    levelConfig: await db.levelConfig.findMany({ where }),
    good: await db.good.findMany({ where }),
    shop: await db.shop.findMany({ where }),
    npc: await db.npc.findMany({ where }),
    npcResource: await db.npcResource.findMany({ where }),
    obj: await db.obj.findMany({ where }),
    objResource: await db.objResource.findMany({ where }),
    player: await db.player.findMany({ where }),
    talkPortrait: await db.talkPortrait.findMany({ where }),
    talk: await db.talk.findMany({ where }),
    scene: await db.scene.findMany({ where }),
    sceneItem: await db.sceneItem.findMany({ where }),
    file: await db.file.findMany({ where }),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${slug}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), game, tables })
  );

  console.log(`✓ ${slug} (gameId=${game.id}) → ${outPath}`);
  for (const [name, rows] of Object.entries(tables)) {
    console.log(`  ${name.padEnd(13)} ${rows.length}`);
  }
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
