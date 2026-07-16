/**
 * check-game-refs — referential-integrity linter for the miu2d games.
 *
 * The bugs it exists to catch all share one shape: some game data REFERENCES an asset
 * by name (a .map wants a tile, an .npc wants a DeathScript, a script wants AddGoods),
 * but that asset can't be found → the engine 404s at runtime → black ground / dead-end
 * quest. This walks every reference and resolves it the way the engine would; anything
 * that doesn't resolve is a latent bug, surfaced here instead of by playing to it.
 *
 * WHY per-game: the resolution rules are ENGINE-level (shared), only the data SOURCE
 * differs — sword1/sword2 read disk, yueying reads DB+S3. V1 does disk; s3 is a TODO hook.
 * WHY sword1 gets a "recoverable?" verdict: only sword1's .pak lost its filenames, so a
 * dangling ref there is usually a name we failed to recover (fixable) vs truly absent data.
 *
 * Usage:  node scripts/check-game-refs.ts <slug>        (slug: sword1 | sword2 | yueying)
 * Exit 1 if any RECOVERABLE dangling refs exist (i.e. fixable bugs remain).
 *
 * Resolution rules are replicated from the engine (can't import the browser bundle into a
 * bare node process); each is cited to its source. The per-type hit-rate is the guardrail:
 * a rule that resolves ~0% of its refs is a WRONG RULE here, not a thousand real bugs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;

interface GameConfig {
  slug: string;
  root: string; // resources dir on disk
  paks?: string; // dir of hash-named .pak files (sword1 only) → enables "recoverable?" verdict
}

const GAMES: Record<string, GameConfig> = {
  sword1: {
    slug: "sword1",
    root: join(REPO, "resources/sword1"),
    paks: join(REPO, "games-raw/xinjianxiaqingyuan/data"),
  },
  sword2: { slug: "sword2", root: join(REPO, "resources/sword2") },
  yueying: { slug: "yueying", root: join(REPO, "resources/yueying") }, // TODO: s3/db source
};

// ── one reference: "file `from` asks for asset `name` of `type`" ──
interface Ref {
  type: string;
  name: string; // as written in the data
  from: string; // the file that references it (for the report)
  mapDir?: string; // owning map dir, for map-scoped script resolution
}

// ── recursive file walk ──
function walk(dir: string, pred: (f: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (pred(e.name)) out.push(p);
  }
  return out;
}

// engine gets scripts from the DB manifest (UTF-8, re-encoded at import); on disk many
// sword1 .txt scripts are still GBK. read them the way their content means, not raw bytes:
// try UTF-8, fall back to GBK — else every Chinese ref name comes out as mojibake.
const utf8 = new TextDecoder("utf-8", { fatal: true });
const gbk = new TextDecoder("gbk");
function read(p: string): string {
  const buf = readFileSync(p);
  try {
    return utf8.decode(buf);
  } catch {
    return gbk.decode(buf);
  }
}

// ═══ reference extractors ═══

/** tiles: an .mmf lists the tile files its map draws (parseMMF header, mmf-helper.ts:39). */
function tilesFromMmf(root: string): Ref[] {
  const refs: Ref[] = [];
  for (const f of walk(join(root, "map"), (n) => n.endsWith(".mmf"))) {
    const d = readFileSync(f);
    if (d.length < 20 || d.toString("latin1", 0, 4) !== "MMF1") continue;
    const stem = basename(f, ".mmf");
    let off = 8 + 4; // preamble + cols/rows
    const msfCount = d.readUInt16LE(off);
    off += 2 + 2 + 4; // msfCount + trapCount + reserved
    for (let i = 0; i < msfCount; i++) {
      const len = d[off++];
      refs.push({ type: "tile", name: d.toString("utf8", off, off + len), from: `${stem}.mmf`, mapDir: stem });
      off += len + 1;
    }
  }
  return refs;
}

const NPC_KEYS = ["NpcIni", "BodyIni", "FlyIni", "FlyIni2", "DeathScript", "ScriptFile", "TimerScript"];
const OBJ_KEYS = ["ObjFile", "ScriptFile", "WavFile"];

/** .npc / .obj scene files: each entry names its sprite/script/sound resources. */
function refsFromSceneInis(root: string): Ref[] {
  const refs: Ref[] = [];
  for (const f of walk(join(root, "ini"), (n) => n.endsWith(".npc") || n.endsWith(".obj"))) {
    const txt = read(f);
    const mapDir = txt.match(/^Map=(.+?)\.map/m)?.[1]?.trim();
    const keys = f.endsWith(".npc") ? NPC_KEYS : OBJ_KEYS;
    for (const k of keys) {
      for (const m of txt.matchAll(new RegExp(`^${k}=(.+?)\\s*$`, "gm"))) {
        const name = m[1].trim();
        if (name) refs.push({ type: k, name, from: basename(f), mapDir });
      }
    }
  }
  return refs;
}

// script command → {referenced-asset type}. arg is the first quoted string (or 2nd for SetMapTrap).
const SCRIPT_CALLS: { re: RegExp; type: string }[] = [
  { re: /\bRunScript\s*\(\s*"([^"]+)"/gi, type: "RunScript" },
  { re: /\bCallScript\s*\(\s*"([^"]+)"/gi, type: "RunScript" },
  { re: /\bSetMapTrap\s*\([^,]*,\s*"([^"]+)"/gi, type: "RunScript" },
  { re: /\bLoadNpc\s*\(\s*"([^"]+)"/gi, type: "LoadNpc" },
  { re: /\bLoadObj\s*\(\s*"([^"]+)"/gi, type: "LoadObj" },
  { re: /\bLoadMap\s*\(\s*"([^"]+)"/gi, type: "LoadMap" },
  { re: /\bAddGoods\s*\(\s*"([^"]+)"/gi, type: "AddGoods" },
  { re: /\bAddMagic\s*\(\s*"([^"]+)"/gi, type: "AddMagic" },
];

/** map scripts: command args naming other scripts / npcs / goods / maps. */
function refsFromScripts(root: string): Ref[] {
  const refs: Ref[] = [];
  for (const f of walk(join(root, "script"), (n) => n.endsWith(".txt"))) {
    const txt = read(f);
    const mapDir = basename(join(f, "..")); // script/map/<mapDir>/foo.txt
    for (const { re, type } of SCRIPT_CALLS) {
      for (const m of txt.matchAll(re)) {
        refs.push({ type, name: m[1].trim(), from: basename(f), mapDir });
      }
    }
  }
  return refs;
}

// ═══ resolvers: does `ref` resolve on disk? (engine rules, each cited) ═══

const swapExt = (n: string, ext: string) => n.replace(/\.(txt|ini)$/i, "") + ext;

// basenames of every script under script/ (any map dir), built once. an event/trap NPC
// gets loaded into a DIFFERENT map at runtime, so its DeathScript resolves under that
// runtime map, not the .npc's declared Map= — statically we only know "does a script by
// this name exist somewhere". present-somewhere ⇒ almost certainly resolves; nowhere ⇒
// definitely broken. this keeps "absent" high-precision (no cross-map false positives).
let scriptNames = new Set<string>();
function indexScripts(root: string): void {
  scriptNames = new Set(walk(join(root, "script"), (n) => n.endsWith(".txt") || n.endsWith(".ini")).map((p) => basename(p).toLowerCase()));
}
const scriptExists = (name: string) =>
  [".txt", ".ini"].some((e) => scriptNames.has(swapExt(name, e).toLowerCase())) || scriptNames.has(name.toLowerCase());

function resolve(root: string, ref: Ref): boolean {
  const has = (rel: string) => existsSync(join(root, rel));
  const { type, name, mapDir } = ref;
  switch (type) {
    // tile: msf/map/<dir>/<name>, fallback mpc/map (map-renderer.ts:318, file.routes.ts:138)
    case "tile":
      return has(`msf/map/${mapDir}/${name}`) || has(`mpc/map/${mapDir}/${name}`);
    // map-scoped scripts: script/map/<dir>/<name>, fallback script/common (parser.ts:242),
    // then any map dir (cross-map event/trap NPCs — see indexScripts).
    case "DeathScript":
    case "ScriptFile":
    case "TimerScript":
    case "RunScript":
      return scriptExists(name);
    // LoadNpc/LoadObj → ini/save (observed: ini/save/map027_fight.npc)
    case "LoadNpc":
    case "LoadObj":
      return has(`ini/save/${name}`);
    case "LoadMap":
      return has(`map/${name}`) || has(`map/${name}.map`);
    // ini config refs (ResourcePath.goods/magic/npc/obj, resource-paths.ts:234-248)
    case "AddGoods":
      return has(`ini/goods/${name}`);
    case "AddMagic":
    case "FlyIni":
    case "FlyIni2":
      return has(`ini/magic/${name}`);
    case "NpcIni":
      return has(`ini/npcres/${name}`) || has(`ini/npc/${name}`);
    case "BodyIni":
    case "ObjFile":
      return has(`ini/obj/${name}`) || has(`ini/objres/${name}`);
    case "WavFile":
      return has(`content/sound/${name}`) || has(`sound/${name}`);
    default:
      return true; // unknown type: don't flag
  }
}

// ═══ sword1 only: is a dangling ref RECOVERABLE (name lost, blob still in the pak)? ═══

const M32 = 0xffffffff;
function pakHash(name: string): number | null {
  const gbk = gbkEncode(name);
  if (!gbk) return null; // not GBK-encodable → can't be a pak filename
  let result = 0;
  for (let cnt = 0; cnt < gbk.length; cnt++) {
    let c = gbk[cnt];
    if (c === 0x2f) c = 0x5c; // '/' -> '\'
    if (c >= 0x41 && c <= 0x5a) c += 0x20; // upper -> lower
    const u = c >= 0x80 ? (c - 256) >>> 0 : c; // signed char -> u32
    result = ((Math.imul(u, cnt + 1) >>> 0) + result) >>> 0;
    result = result % 0x8000000b;
    result = ((((((result ^ M32) + 1) >>> 0) << 4) >>> 0) - result) >>> 0;
  }
  return (result ^ 0x12345678) >>> 0;
}
// GBK encode via iconv (node has no built-in). GB18030 is a GBK superset with identical
// bytes over the GBK range, so the hash matches the pak; it just also tolerates rare chars
// (which, if outside GBK, hash to a value no GBK-named pak entry has → correctly no match).
const gbkCache = new Map<string, Buffer | null>();
function gbkEncode(s: string): Buffer | null {
  if (gbkCache.has(s)) return gbkCache.get(s)!;
  let out: Buffer | null;
  try {
    out = execFileSync("iconv", ["-f", "UTF-8", "-t", "GB18030"], { input: Buffer.from(s, "utf8") });
  } catch {
    out = null;
  }
  gbkCache.set(s, out);
  return out;
}

function loadPakIds(paksDir: string): Set<number> {
  const ids = new Set<number>();
  for (const f of readdirSync(paksDir).filter((n) => n.endsWith(".pak"))) {
    const d = readFileSync(join(paksDir, f));
    if (d.toString("latin1", 0, 8) !== "PACKAGE\0") continue;
    const count = d.readUInt32LE(8);
    for (let i = 0; i < count; i++) ids.add(d.readUInt32LE(16 + i * 12));
  }
  return ids;
}

/** candidate pak paths a dangling ref could live under (mirrors the resolver's roots). */
function pakCandidates(ref: Ref): string[] {
  const { type, name, mapDir } = ref;
  const s = (p: string) => p.replace(/\//g, "\\");
  switch (type) {
    case "tile":
      return [s(`mpc/map/${mapDir}/${name}`)];
    case "DeathScript":
    case "ScriptFile":
    case "TimerScript":
    case "RunScript":
      return [".txt", ".ini"].flatMap((e) => [s(`script/map/${mapDir}/${swapExt(name, e)}`), s(`script/common/${swapExt(name, e)}`)]);
    case "LoadNpc":
    case "LoadObj":
      return [s(`ini/save/${name}`)];
    case "LoadMap":
      return [s(`map/${name}`)];
    case "AddGoods":
      return [s(`ini/goods/${name}`)];
    case "AddMagic":
    case "FlyIni":
    case "FlyIni2":
      return [s(`ini/magic/${name}`)];
    case "NpcIni":
      return [s(`ini/npcres/${name}`), s(`ini/npc/${name}`)];
    case "BodyIni":
    case "ObjFile":
      return [s(`ini/obj/${name}`), s(`ini/objres/${name}`)];
    default:
      return [];
  }
}

// ═══ main ═══

const slug = process.argv[2];
const cfg = GAMES[slug];
if (!cfg) {
  console.error(`usage: node scripts/check-game-refs.ts <sword1|sword2|yueying>`);
  process.exit(2);
}
if (!existsSync(cfg.root)) {
  console.error(`resources not found: ${cfg.root}`);
  process.exit(2);
}

indexScripts(cfg.root);
const refs = [...tilesFromMmf(cfg.root), ...refsFromSceneInis(cfg.root), ...refsFromScripts(cfg.root)];

// per-type tally (the self-calibration guardrail)
const byType = new Map<string, { total: number; resolved: number; dangling: Ref[] }>();
for (const r of refs) {
  const t = byType.get(r.type) ?? { total: 0, resolved: 0, dangling: [] };
  t.total++;
  if (resolve(cfg.root, r)) t.resolved++;
  else t.dangling.push(r);
  byType.set(r.type, t);
}

// dedup dangling by (type, mapDir, name)
const seen = new Set<string>();
const dangling: Ref[] = [];
for (const t of byType.values())
  for (const r of t.dangling) {
    const k = `${r.type}|${r.mapDir}|${r.name.toLowerCase()}`;
    if (!seen.has(k)) (seen.add(k), dangling.push(r));
  }

// sword1: classify each dangling ref recoverable vs absent
let pakIds: Set<number> | null = null;
if (cfg.paks && existsSync(cfg.paks)) pakIds = loadPakIds(cfg.paks);
const recoverable: Ref[] = [];
const absent: Ref[] = [];
for (const r of dangling) {
  const hit = (c: string) => {
    const h = pakHash(c);
    return h !== null && pakIds!.has(h);
  };
  if (pakIds && pakCandidates(r).some(hit)) recoverable.push(r);
  else absent.push(r);
}

// ── report ──
console.log(`── ${slug}: ${refs.length} references across ${byType.size} types\n`);
console.log(`type              refs   resolved   dangling   (rate)`);
for (const [type, t] of [...byType].sort((a, b) => b[1].total - a[1].total)) {
  const rate = ((t.resolved / t.total) * 100).toFixed(0);
  const warn = t.total >= 20 && t.resolved === 0 ? "  ← 0% : rule likely wrong, not real bugs" : "";
  console.log(`${type.padEnd(16)} ${String(t.total).padStart(5)} ${String(t.resolved).padStart(10)} ${String(t.total - t.resolved).padStart(10)}   ${rate.padStart(3)}%${warn}`);
}

console.log(`\n── dangling (deduped): ${dangling.length}`);
if (pakIds) {
  console.log(`   recoverable (name in a .pak, fixable) : ${recoverable.length}`);
  console.log(`   absent (not in any .pak, original gap) : ${absent.length}`);
}
if (recoverable.length) {
  console.log(`\n── RECOVERABLE (add name → re-unpack):`);
  for (const r of recoverable.sort((a, b) => a.type.localeCompare(b.type)))
    console.log(`  [${r.type}] ${r.mapDir ? r.mapDir + "/" : ""}${r.name}   ←${r.from}`);
}
if (absent.length) {
  // tiles have a known story (numeric-name gaps / -1 variant dirs) → just summarize;
  // non-tile absents (missing scripts / npc-res / goods) are the ones worth eyeballing.
  const tileAbsent = absent.filter((r) => r.type === "tile");
  const other = absent.filter((r) => r.type !== "tile");
  if (other.length) {
    console.log(`\n── absent, non-tile (original data gap): ${other.length}`);
    for (const r of other.sort((a, b) => a.type.localeCompare(b.type)))
      console.log(`  [${r.type}] ${r.mapDir ? r.mapDir + "/" : ""}${r.name}   ←${r.from}`);
  }
  if (tileAbsent.length) {
    const maps = [...new Set(tileAbsent.map((r) => r.mapDir))];
    console.log(`\n── absent tiles: ${tileAbsent.length} across ${maps.length} maps (${maps.join(", ")})`);
  }
}

process.exit(recoverable.length > 0 ? 1 : 0);
