/**
 * 启动时游戏内容播种（JSON → DB）
 *
 * 游戏内容镜像把 <slug>.json 拷进 SEED_DIR，server 启动时扫一遍：slug 已存在就跳过。
 * DB 是真相源，种子只负责把空库填起来，永不覆盖既有游戏。目录不存在则静默跳过（dev 无感）。
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { db } from "./client";
import { env } from "../env";

// 导出侧 (scripts/export-game-seed.ts) 的产物结构
interface GameSeed {
  version: number;
  game: { id: string; slug: string; name: string } & Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

/** 认得的种子格式版本；对不上就拒绝，别让旧镜像静默灌进半套数据 */
const SEED_VERSION = 1;

async function seedOne(seed: GameSeed): Promise<void> {
  const { game, tables } = seed;

  if (seed.version !== SEED_VERSION) {
    console.error(
      `[seed] ${game?.slug ?? "?"}: unsupported seed version ${seed.version} (expected ${SEED_VERSION}), skipped`
    );
    return;
  }

  const existing = await db.game.findFirst({ where: { slug: game.slug } });
  if (existing) {
    console.log(`[seed] ${game.slug}: already present, skipped`);
    return;
  }

  const t = tables;
  // yueying 级别的种子有上万行，默认 5s 事务超时不够
  await db.$transaction(
    async (tx) => {
      // Game 必须最先（其余表都以 gameId 为外键）
      await tx.game.create({ data: game as never });

      await tx.gameConfig.createMany({ data: t.gameConfig as never });
      await tx.magic.createMany({ data: t.magic as never });
      await tx.levelConfig.createMany({ data: t.levelConfig as never });
      await tx.good.createMany({ data: t.good as never });
      await tx.shop.createMany({ data: t.shop as never });
      await tx.npcResource.createMany({ data: t.npcResource as never });
      await tx.objResource.createMany({ data: t.objResource as never });
      await tx.player.createMany({ data: t.player as never });
      await tx.talkPortrait.createMany({ data: t.talkPortrait as never });
      await tx.talk.createMany({ data: t.talk as never });
      await tx.file.createMany({ data: t.file as never });

      // resourceId 指向上面两张 *Resource（松散列，无 DB 外键，但按序插更干净）
      await tx.npc.createMany({ data: t.npc as never });
      await tx.obj.createMany({ data: t.obj as never });

      // SceneItem.sceneId → Scene 是真外键，必须在 Scene 之后
      await tx.scene.createMany({ data: t.scene as never });
      await tx.sceneItem.createMany({ data: t.sceneItem as never });
    },
    { timeout: 180_000, maxWait: 15_000 }
  );

  const total = Object.values(t).reduce((n, rows) => n + rows.length, 0);
  console.log(`[seed] ${game.slug}: seeded ${total} rows (gameId=${game.id})`);
}

/**
 * 播种 SEED_DIR 下的全部游戏。失败只记日志不抛出——种子有问题不该拖垮整个 server。
 */
export async function seedGames(): Promise<void> {
  const seedDir = path.resolve(env.seedDir);

  let files: string[];
  try {
    files = readdirSync(seedDir).filter((f) => f.endsWith(".json"));
  } catch {
    return; // 目录不存在 = 没有要播的种子
  }

  for (const file of files.sort()) {
    try {
      const seed = JSON.parse(readFileSync(path.join(seedDir, file), "utf-8")) as GameSeed;
      await seedOne(seed);
    } catch (err) {
      console.error(`[seed] ${file} failed:`, err);
    }
  }
}
