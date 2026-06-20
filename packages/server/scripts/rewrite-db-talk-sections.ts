/**
 * rewrite talk("section") -> talk(start,end) in scene.data scripts/traps (DB).
 *
 * the engine reads map scripts from scene.data (DB), NOT from disk. sword2
 * scripts call dialogs by named section, e.g. talk("enter0"); the engine's
 * talk command only understands numeric TalkIndex ids. this rewrites every
 * scene's scripts+traps using talk-section-mapping.txt (map/section -> id range).
 *
 * idempotent: a talk() already numeric is left untouched. commented calls
 * (-- before talk on the same line) are skipped.
 *
 * usage:  tsx --tsconfig tsconfig.dev.json scripts/rewrite-db-talk-sections.ts [--apply]
 * without --apply it is a dry-run (reports counts, writes nothing).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/db/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo-root/resources/sword2/content/talk-section-mapping.txt
const MAPPING_FILE = resolve(
  __dirname,
  "../../../resources/sword2/content/talk-section-mapping.txt"
);

// "沙漠之战/enter0 → Talk(38040,38040)"  (arrow is a multibyte char)
const MAPPING_RE = /^(.+?)\/(\S+).*?Talk\((\d+),(\d+)\)/;
// talk("section")  (string-form dialog call)
const TALK_RE = /talk\s*\(\s*"([^"]+)"\s*\)/gi;

type Mapping = {
  byMapSection: Map<string, [number, number]>; // "map/section" -> [start, end]
  bySection: Map<string, [number, number]>; // "section" -> first match in any map
};

function loadMapping(): Mapping {
  const text = readFileSync(MAPPING_FILE, "utf-8");
  const byMapSection = new Map<string, [number, number]>();
  const bySection = new Map<string, [number, number]>();
  for (const line of text.split("\n")) {
    const m = MAPPING_RE.exec(line);
    if (!m) continue;
    const range: [number, number] = [Number(m[3]), Number(m[4])];
    byMapSection.set(`${m[1]}/${m[2]}`, range);
    // sword2 talk sections share a cross-map namespace: a script in map A may
    // call a section defined in map B's talk.txt. mirror the converter's
    // lookup_talk_ids fallback — same-map first, else first match anywhere.
    const sec = m[2].toLowerCase();
    if (!bySection.has(sec)) bySection.set(sec, range);
  }
  return { byMapSection, bySection };
}

/** resolve a section id range: same-map first, then cross-map fallback. */
function lookupSection(
  mapName: string,
  section: string,
  mapping: Mapping
): [number, number] | undefined {
  return (
    mapping.byMapSection.get(`${mapName}/${section}`) ??
    mapping.bySection.get(section.toLowerCase())
  );
}

/** rewrite one script body; returns [newBody, changed, missingSections]. */
function rewriteBody(
  body: string,
  mapName: string,
  mapping: Mapping
): [string, number, string[]] {
  let changed = 0;
  const missing: string[] = [];
  const out = body.replace(TALK_RE, (full, section: string, offset: number) => {
    // skip commented-out calls: -- earlier on the same line
    const lineStart = body.lastIndexOf("\n", offset) + 1;
    if (body.slice(lineStart, offset).includes("--")) return full;
    const hit = lookupSection(mapName, section, mapping);
    if (!hit) {
      missing.push(`${mapName}/${section}`);
      return full;
    }
    changed++;
    return `talk(${hit[0]},${hit[1]})`;
  });
  return [out, changed, missing];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mapping = loadMapping();
  console.log(
    `loaded ${mapping.byMapSection.size} map/section mappings (${mapping.bySection.size} unique sections)`
  );

  const scenes = await db.scene.findMany({ select: { id: true, key: true, data: true } });
  console.log(`scanning ${scenes.length} scenes`);

  let totalChanged = 0;
  const allMissing = new Set<string>();
  let scenesTouched = 0;

  for (const scene of scenes) {
    const data = scene.data as Record<string, Record<string, string>> | null;
    if (!data) continue;
    let sceneChanged = 0;
    let sceneDirty = false;

    for (const bucket of ["scripts", "traps"] as const) {
      const files = data[bucket];
      if (!files) continue;
      for (const [fileName, body] of Object.entries(files)) {
        if (typeof body !== "string") continue;
        const [newBody, changed, missing] = rewriteBody(body, scene.key, mapping);
        missing.forEach((m) => allMissing.add(m));
        if (changed > 0) {
          // changed > 0 implies a replacement happened, so newBody !== body.
          sceneChanged += changed;
          files[fileName] = newBody;
          sceneDirty = true;
        }
      }
    }

    if (sceneChanged > 0) {
      scenesTouched++;
      totalChanged += sceneChanged;
      console.log(`  ${scene.key}: ${sceneChanged} rewrite(s)`);
      if (apply && sceneDirty) {
        await db.scene.update({ where: { id: scene.id }, data: { data } });
      }
    }
  }

  console.log(
    `\n${apply ? "APPLIED" : "DRY-RUN"}: ${totalChanged} talk() rewrites across ${scenesTouched} scenes`
  );
  if (allMissing.size > 0) {
    console.log(`\n${allMissing.size} section(s) with NO mapping (left unchanged):`);
    const sorted = [...allMissing].sort();
    console.log("  " + sorted.slice(0, 40).join("\n  "));
    if (sorted.length > 40) console.log(`  ... and ${sorted.length - 40} more`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
