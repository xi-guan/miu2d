/**
 * S3 素材 vs 磁盘副本差集（只读）
 *
 * 回答一个问题：把某个游戏的 File 记录删掉、让它落回磁盘回退，会不会丢文件。
 * 对每条 File 记录还原出引擎会请求的相对路径，再看磁盘上有没有。
 * 「只在 S3」非空 = 还不能删记录。
 *
 * 静态比对回答不了「路径形状对不对」，所以还可以加 --probe：把每条记录还原成引擎会请
 * 求的 URL，逐个打一遍。配合 S3_ENDPOINT 指向死端口起的 server，这就是删记录后的终态。
 *
 * 用法:
 *   tsx --tsconfig tsconfig.dev.json scripts/diff-s3-vs-disk.ts <slug>
 *   tsx --tsconfig tsconfig.dev.json scripts/diff-s3-vs-disk.ts <slug> --probe http://localhost:4321
 */

import "dotenv/config";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { db } from "../src/db/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("usage: diff-s3-vs-disk.ts <slug>");
    process.exit(1);
  }

  const game = await db.game.findFirst({ where: { slug } });
  if (!game) {
    console.error(`✗ game not found: ${slug}`);
    process.exit(1);
  }

  const rows = await db.file.findMany({
    where: { gameId: game.id },
    select: { id: true, name: true, type: true, parentId: true, storageKey: true },
  });

  // 目录树在 DB 里靠 parentId 串起来，逐级回溯还原相对路径
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    let cur = byId.get(id);
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join("/");
  };

  const gameRoot = join(REPO_ROOT, "resources", slug);

  // 按文件名建一次磁盘索引：用来区分「路径形状不同」和「文件真的不在」
  const diskNames = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else diskNames.add(e.name.toLowerCase());
    }
  };
  walk(gameRoot);

  const files = rows.filter((r) => r.type === "file");
  const missing: string[] = []; // 路径对不上, 但同名文件在磁盘别处
  const absent: string[] = []; // 整个磁盘都没有这个名字 —— 真正的风险
  const noKey: string[] = [];

  for (const f of files) {
    if (!f.storageKey) {
      noKey.push(pathOf(f.id));
      continue;
    }
    const rel = pathOf(f.id);
    // 与 file.routes.ts 的磁盘回退保持一致：msf/map/* 在磁盘上是 mpc/map/*
    const candidates = [rel];
    if (rel.startsWith("msf/map/")) candidates.push(`mpc${rel.slice(3)}`);
    if (candidates.some((p) => existsSync(join(gameRoot, p)))) continue;
    if (diskNames.has(basename(rel).toLowerCase())) missing.push(rel);
    else absent.push(rel);
  }

  console.log(`游戏      ${slug} (gameId=${game.id})`);
  console.log(`磁盘根    ${gameRoot}`);
  console.log(`File 记录 ${rows.length}  (其中文件 ${files.length}, 目录 ${rows.length - files.length})`);
  console.log(`磁盘文件  ${diskNames.size} 个不同文件名`);
  console.log("");
  console.log(`路径对不上但同名文件在磁盘  ${missing.length}   (DB 目录树形状问题, 不丢数据)`);
  console.log(`磁盘上完全没有这个文件      ${absent.length}   ← 真正的风险`);
  console.log(`有记录但无 storageKey       ${noKey.length}`);

  for (const p of absent.slice(0, 40)) console.log(`  ✗ ${p}`);
  if (absent.length > 40) console.log(`  … 另有 ${absent.length - 40} 条`);

  console.log("");
  console.log(
    absent.length === 0
      ? "✓ 每个 S3 文件在磁盘上都有对应 —— 删掉 File 记录后不会丢素材"
      : "✗ 有文件只存在于 S3 —— 先补齐磁盘再考虑删记录"
  );

  const probeIdx = process.argv.indexOf("--probe");
  if (probeIdx !== -1) {
    const base = process.argv[probeIdx + 1];
    if (!base) {
      console.error("--probe 需要一个 base url, 例如 http://localhost:4321");
      process.exit(1);
    }
    const prefix = `${base.replace(/\/$/, "")}/game/${slug}/resources/`;
    console.log("");
    console.log(`── 行为探测 ${files.length} 条路径 → ${prefix} ──`);

    const paths = files.map((f) => pathOf(f.id));
    const bad: string[] = [];
    let ok = 0;
    const CONC = 32;
    for (let i = 0; i < paths.length; i += CONC) {
      const results = await Promise.all(
        paths.slice(i, i + CONC).map(async (p) => {
          const url = prefix + p.split("/").map(encodeURIComponent).join("/");
          try {
            return { p, s: (await fetch(url)).status };
          } catch {
            return { p, s: 0 };
          }
        })
      );
      for (const r of results) (r.s === 200 ? ok++ : bad.push(`${r.s} ${r.p}`));
    }

    console.log(`200      ${ok}`);
    console.log(`非 200   ${bad.length}`);
    for (const b of bad.slice(0, 25)) console.log(`  ${b}`);
    if (bad.length > 25) console.log(`  … 另有 ${bad.length - 25} 条`);
    console.log("");
    console.log(bad.length === 0 ? "✓ 每条路径都取得到" : "✗ 有路径取不到");
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
