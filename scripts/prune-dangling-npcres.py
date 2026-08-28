#!/usr/bin/env python3
"""Null out npc_resources image refs whose sprite is absent from resources/<slug>/.

The original games ship npcres templates listing all five actions, but non-combat
NPCs never got attack/magic/death art. A name with no file behind it makes the
engine fetch and 404; null makes it skip silently (same as run/sit/hurt already do).

Resolution mirrors character-res-loader.ts:
  *.mpc  -> mpc/character/
  else   -> asf/character/ then asf/interlude/   (loadAsf rewrites .asf -> .msf)

Usage:
  python3 scripts/prune-dangling-npcres.py                  # dry run, all games
  python3 scripts/prune-dangling-npcres.py --apply          # write the SQL and run it
  python3 scripts/prune-dangling-npcres.py --apply sword2   # single game
"""
import collections
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTAINER = "miu2d-postgres"
DB = ["-U", "postgres", "-d", "miu2d_db"]
SLUGS = ["yueying", "sword2", "sword1"]


def psql(args, sql):
    out = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", *DB, *args, "-c", sql],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"psql failed: {out.stderr.strip()}")
    return out.stdout


def stems(directory):
    if not os.path.isdir(directory):
        return set()
    return {os.path.splitext(f.lower())[0] for f in os.listdir(directory)}


def prune_game(slug, apply):
    root = os.path.join(REPO, "resources", slug)
    asf_have = stems(os.path.join(root, "asf", "character")) | stems(
        os.path.join(root, "asf", "interlude")
    )
    mpc_have = stems(os.path.join(root, "mpc", "character"))

    rows = psql(
        ["-At", "-F", "\t"],
        f"SELECT r.id, r.key, r.data FROM npc_resources r "
        f"JOIN games g ON g.id = r.game_id WHERE g.slug = '{slug}'",
    ).splitlines()

    updates, by_action = [], collections.Counter()
    for line in rows:
        if not line.strip():
            continue
        rid, key, raw = line.split("\t", 2)
        data = json.loads(raw)
        res = data.get("resources") or {}
        touched = False
        for action, entry in res.items():
            img = (entry or {}).get("image")
            if not img:
                continue
            stem, ext = os.path.splitext(img.lower())
            have = mpc_have if ext == ".mpc" else asf_have
            if stem in have:
                continue
            entry["image"] = None
            by_action[action] += 1
            touched = True
        if touched:
            updates.append((rid, key, data))

    print(f"── {slug}: {len(rows)} npcres rows, {len(updates)} rows to patch, "
          f"{sum(by_action.values())} image refs nulled")
    for action, n in by_action.most_common():
        print(f"     {action:12s} {n}")

    if not updates or not apply:
        return

    sql_path = os.path.join(REPO, ".data", f"prune-npcres-{slug}.sql")
    with open(sql_path, "w", encoding="utf-8") as fh:
        for rid, _key, data in updates:
            payload = json.dumps(data, ensure_ascii=False)
            fh.write(f"UPDATE npc_resources SET data = $j${payload}$j$::jsonb, "
                     f"updated_at = now() WHERE id = '{rid}';\n")
    subprocess.run(["docker", "cp", sql_path, f"{CONTAINER}:/tmp/prune.sql"], check=True)
    out = subprocess.run(
        ["docker", "exec", CONTAINER, "psql", *DB, "-q", "-f", "/tmp/prune.sql"],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"apply failed: {out.stderr.strip()}")
    print(f"     applied {len(updates)} updates ({sql_path})")


def main():
    args = [a for a in sys.argv[1:] if a != "--apply"]
    apply = "--apply" in sys.argv
    for slug in (args or SLUGS):
        prune_game(slug, apply)
    if not apply:
        print("\ndry run — pass --apply to write")


if __name__ == "__main__":
    main()
