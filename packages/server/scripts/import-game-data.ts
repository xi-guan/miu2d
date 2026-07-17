/**
 * 游戏数据导入脚本（ini → DB）
 *
 * 复刻 dashboard ImportAllModal 的导入流程，但脱离浏览器：直接读 resources/<slug>/,
 * 用生产同款 parseResourcesFolder 解析为各模块数据，再逐模块调 server service 的
 * batchImportFromIni / importScene / ... 写库。
 *
 * 用法:
 *   tsx --tsconfig tsconfig.dev.json scripts/import-game-data.ts <slug> [--no-clear]
 *   tsx --tsconfig tsconfig.dev.json scripts/import-game-data.ts <slug> --only npc,magic
 *
 * 背景: sword2 等剑侠系 ini 的 section/key 为全小写(name=/[init]/...)，而各 service 的
 * parser 多为 PascalCase 大小写敏感(case "Name" / === "Init")。导入前用 canonical-keys.json
 * (月影 ini ∪ parser case 标签 派生的 lower→Pascal 词表)把 key 规范化，section 仅归一
 * Init/Level/Header(其余 parser 自身 toLowerCase/toUpperCase 已兼容)。月影本身已是
 * PascalCase，规范化对其为幂等无副作用。
 */

import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseResourcesFolder } from "@miu2d/types";
import type { DroppedFileEntry, ResourceFile } from "@miu2d/types";

import { gameConfigService } from "../src/modules/gameConfig";
import { goodsService } from "../src/modules/goods";
import { levelConfigService } from "../src/modules/level";
import { magicService } from "../src/modules/magic";
import { npcService } from "../src/modules/npc";
import { objService } from "../src/modules/obj";
import { playerService } from "../src/modules/player";
import { sceneService } from "../src/modules/scene";
import { shopService } from "../src/modules/shop";
import { talkService } from "../src/modules/talk";
import { talkPortraitService } from "../src/modules/talkPortrait";
import { db } from "../src/db/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 配置 ───────────────────────────────────────────────────────────────────
const LANGUAGE = "zh" as const;
const REPO_ROOT = resolve(__dirname, "../../.."); // packages/server/scripts → repo root
const CHUNK_SIZE = 100;
const TEXT_EXTS = new Set([".ini", ".txt", ".npc", ".obj"]);

// canonical key 词表: lower(key) → 正确 PascalCase 拼写
const CANON: Record<string, string> = JSON.parse(
  readFileSync(join(__dirname, "canonical-keys.json"), "utf-8")
);

// ── ini 大小写规范化 ─────────────────────────────────────────────────────────

/** 规范化一段 ini 文本: section 归一 Init/Level/Header + key 按词表归一 */
function normalizeIniKeys(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmedStart = line.replace(/^\s+/, "");
      // section 头: 仅归一 parser 大小写敏感的 Init/LevelN/Header，其余原样
      const sec = trimmedStart.match(/^\[([^\]]+)\]\s*$/);
      if (sec) {
        const name = sec[1];
        if (/^init$/i.test(name)) return "[Init]";
        const lvl = name.match(/^level(\d+)$/i);
        if (lvl) return `[Level${lvl[1]}]`;
        if (/^header$/i.test(name)) return "[Header]";
        return line;
      }
      // key=value: 把 key 换成 canonical 拼写(保留原 value 与等号后内容)
      const kv = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_]*)(\s*=.*)$/);
      if (kv) {
        const canon = CANON[kv[2].toLowerCase()];
        if (canon) return `${kv[1]}${canon}${kv[3]}`;
      }
      return line;
    })
    .join("\n");
}

// ── Node File 垫片 ───────────────────────────────────────────────────────────

/** 用 fs 实现 parseResourcesFolder 所需的最小 File 接口 */
function makeResourceFile(absPath: string, name: string): ResourceFile {
  const isText = TEXT_EXTS.has(name.slice(name.lastIndexOf(".")).toLowerCase());
  return {
    name,
    async text() {
      const raw = readFileSync(absPath, "utf-8");
      return isText ? normalizeIniKeys(raw) : raw;
    },
    async arrayBuffer() {
      const buf = readFileSync(absPath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
  };
}

/**
 * 把 sword2 特有的存档槽目录映射到 parseResourcesFolder 认的 ini/save/。
 * 剑侠系把场景 NPC/OBJ 存档放在 save/<slot>/(如 save/rpg0/)，月影放在 ini/save/。
 * 解析器只扫 ini/save/ 与 save/game/，故把 save/<非 game 槽>/ 重写为 ini/save/，
 * 让 .npc/.obj/Traps.ini 能挂到场景。仅改导入时喂入的路径，不动磁盘文件。
 */
function remapSaveDir(rel: string): string {
  return rel.replace(/\/save\/(?!game\/)[^/]+\//i, "/ini/save/");
}

/** 递归遍历目录, 产出 DroppedFileEntry[](relativePath 形如 "<slug>/ini/npc/x.ini") */
function walk(absDir: string, relPrefix: string): DroppedFileEntry[] {
  const out: DroppedFileEntry[] = [];
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...walk(abs, rel));
    } else if (st.isFile()) {
      out.push({ relativePath: remapSaveDir(rel), file: makeResourceFile(abs, name) });
    }
  }
  return out;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

interface ModuleResult {
  module: string;
  success: number;
  failed: number;
  errors: string[];
}

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) {
    console.error("用法: tsx scripts/import-game-data.ts <slug> [--no-clear] [--only m1,m2]");
    process.exit(1);
  }
  const noClear = args.includes("--no-clear");
  const onlyArg = args[args.indexOf("--only") + 1];
  const only =
    args.includes("--only") && onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim())) : null;

  const resourcesDir = join(REPO_ROOT, "resources", slug);
  if (!statSync(resourcesDir).isDirectory()) {
    console.error(`资源目录不存在: ${resourcesDir}`);
    process.exit(1);
  }

  // 解析 game
  const game = await db.game.findFirst({ where: { slug } });
  if (!game) {
    console.error(`数据库中无 slug=${slug} 的 game`);
    process.exit(1);
  }
  const owner = await db.gameMember.findFirst({
    where: { gameId: game.id, role: "owner" },
  });
  if (!owner) {
    console.error(`game ${slug} 无 owner 成员，无法通过 verifyGameAccess`);
    process.exit(1);
  }
  const gameId = game.id;
  const userId = owner.userId;

  console.log(`── 导入 ${slug} (gameId=${gameId}) ──`);
  console.log(`资源目录: ${resourcesDir}`);

  // 读取并解析
  console.log("遍历资源目录...");
  const files = walk(resourcesDir, slug);
  console.log(`共 ${files.length} 个文件，解析中...`);
  const data = await parseResourcesFolder(files, (t) => console.log(`  · ${t}`));

  const want = (m: string) => !only || only.has(m);
  const results: ModuleResult[] = [];

  // Phase 1: 清空(与 ImportAllModal 一致, 各 service clearAll)
  if (!noClear) {
    console.log("── 清空现有数据 ──");
    const clears: Array<[string, () => Promise<unknown>]> = [
      ["magic", () => magicService.clearAll({ gameId }, userId, LANGUAGE)],
      ["npc", () => npcService.clearAll({ gameId }, userId, LANGUAGE)],
      ["obj", () => objService.clearAll({ gameId }, userId, LANGUAGE)],
      ["goods", () => goodsService.clearAll({ gameId }, userId, LANGUAGE)],
      ["shop", () => shopService.clearAll({ gameId }, userId, LANGUAGE)],
      ["player", () => playerService.clearAll({ gameId }, userId, LANGUAGE)],
      ["level", () => levelConfigService.clearAll({ gameId }, userId, LANGUAGE)],
      ["talk", () => talkService.clearAll({ gameId }, userId, LANGUAGE)],
      ["talkPortrait", () => talkPortraitService.clearAll({ gameId }, userId, LANGUAGE)],
      ["scene", () => sceneService.clearAll({ gameId }, userId, LANGUAGE)],
    ];
    for (const [m, fn] of clears) {
      if (!want(m)) continue;
      await fn();
    }
  }

  // Phase 2: 导入(顺序同 ImportAllModal)
  console.log("── 导入 ──");

  // magic (chunked)
  if (want("magic") && data.magic.length > 0) {
    const r: ModuleResult = { module: "magic", success: 0, failed: 0, errors: [] };
    for (let i = 0; i < data.magic.length; i += CHUNK_SIZE) {
      const res = await magicService.batchImportFromIni(
        { gameId, items: data.magic.slice(i, i + CHUNK_SIZE) },
        userId,
        LANGUAGE
      );
      r.success += res.success.length;
      r.failed += res.failed.length;
      r.errors.push(...res.failed.map((f) => `${f.fileName}: ${f.error}`));
    }
    results.push(r);
  }

  // npc (single call)
  if (want("npc") && data.npc.length > 0) {
    const res = await npcService.batchImportFromIni({ gameId, items: data.npc }, userId, LANGUAGE);
    results.push({
      module: "npc",
      success: res.success.length,
      failed: res.failed.length,
      errors: res.failed.map((f) => `${f.fileName}: ${f.error}`),
    });
  }

  // obj (single call)
  if (want("obj") && data.obj.length > 0) {
    const res = await objService.batchImportFromIni({ gameId, items: data.obj }, userId, LANGUAGE);
    results.push({
      module: "obj",
      success: res.success.length,
      failed: res.failed.length,
      errors: res.failed.map((f) => `${f.fileName}: ${f.error}`),
    });
  }

  // goods (chunked)
  if (want("goods") && data.goods.length > 0) {
    const r: ModuleResult = { module: "goods", success: 0, failed: 0, errors: [] };
    for (let i = 0; i < data.goods.length; i += CHUNK_SIZE) {
      const res = await goodsService.batchImportFromIni(
        { gameId, items: data.goods.slice(i, i + CHUNK_SIZE) },
        userId,
        LANGUAGE
      );
      r.success += res.success.length;
      r.failed += res.failed.length;
      r.errors.push(...res.failed.map((f) => `${f.fileName}: ${f.error}`));
    }
    results.push(r);
  }

  // shop (chunked)
  if (want("shop") && data.shop.length > 0) {
    const r: ModuleResult = { module: "shop", success: 0, failed: 0, errors: [] };
    for (let i = 0; i < data.shop.length; i += CHUNK_SIZE) {
      const res = await shopService.batchImportFromIni(
        { gameId, items: data.shop.slice(i, i + CHUNK_SIZE) },
        userId,
        LANGUAGE
      );
      r.success += res.success.length;
      r.failed += res.failed.length;
      r.errors.push(...res.failed.map((f) => `${f.fileName}: ${f.error}`));
    }
    results.push(r);
  }

  // player (single call)
  if (want("player") && data.player.length > 0) {
    const res = await playerService.batchImportFromIni(
      { gameId, items: data.player, clearBeforeImport: false },
      userId,
      LANGUAGE
    );
    results.push({
      module: "player",
      success: res.success.length,
      failed: res.failed.length,
      errors: res.failed.map((f) => `${f.fileName}: ${f.error}`),
    });
  }

  // level (逐个 importFromIni)
  if (want("level") && data.level.length > 0) {
    const r: ModuleResult = { module: "level", success: 0, failed: 0, errors: [] };
    for (const lvl of data.level) {
      try {
        await levelConfigService.importFromIni(
          { gameId, fileName: lvl.fileName, userType: lvl.userType, iniContent: lvl.iniContent },
          userId,
          LANGUAGE
        );
        r.success++;
      } catch (e) {
        r.failed++;
        r.errors.push(`${lvl.fileName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    results.push(r);
  }

  // talk (importFromTxt)
  if (want("talk") && data.talk) {
    await talkService.importFromTxt({ gameId, content: data.talk }, userId, LANGUAGE);
    results.push({ module: "talk", success: 1, failed: 0, errors: [] });
  }

  // talkPortrait (importFromIni)
  if (want("talkPortrait") && data.talkPortrait) {
    await talkPortraitService.importFromIni(
      { gameId, iniContent: data.talkPortrait },
      userId,
      LANGUAGE
    );
    results.push({ module: "talkPortrait", success: 1, failed: 0, errors: [] });
  }

  // scene (逐个 importScene)
  if (want("scene") && data.scene.length > 0) {
    const r: ModuleResult = { module: "scene", success: 0, failed: 0, errors: [] };
    for (const scene of data.scene) {
      try {
        const res = await sceneService.importScene(
          {
            gameId,
            scene: {
              key: scene.key,
              name: scene.name,
              mapFileName: scene.mapFileName,
              mmfData: scene.mmfBase64,
              data: scene.data as Record<string, unknown>,
              trapOverrides: scene.trapOverrides,
            },
          },
          userId,
          LANGUAGE
        );
        if (res.action === "error") {
          r.failed++;
          r.errors.push(`${scene.name}: ${res.error ?? "未知错误"}`);
        } else {
          r.success++;
        }
      } catch (e) {
        r.failed++;
        r.errors.push(`${scene.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    results.push(r);
  }

  // gameConfig (setUiTheme) — 仅在解析出 uiTheme 时; Node 默认不传 convertUiTheme 故通常为 null
  if (want("gameConfig") && data.uiTheme) {
    await gameConfigService.patchUiTheme(gameId, data.uiTheme, userId, LANGUAGE);
    results.push({ module: "gameConfig", success: 1, failed: 0, errors: [] });
  }

  // ── 汇总 ──
  console.log("── 导入结果 ──");
  for (const r of results) {
    const tag = r.failed > 0 ? "⚠" : "✓";
    console.log(`${tag} ${r.module.padEnd(13)} 成功 ${r.success}  失败 ${r.failed}`);
    for (const e of r.errors.slice(0, 5)) console.log(`    - ${e}`);
    if (r.errors.length > 5) console.log(`    … 另有 ${r.errors.length - 5} 条`);
  }

  await db.$disconnect();
  console.log("完成");
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
