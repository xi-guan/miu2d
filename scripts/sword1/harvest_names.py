#!/usr/bin/env python3
"""harvest filename candidates for sword1 paks and match against hash indexes.

sources:
  1. yueying resource tree (same engine generation, shared layout/names)
  2. extracted sword1 text files (ini/script reference each other by name)
  3. loose files in the install dir

outputs names-<pak>.txt (full pak paths, utf-8) next to this script.
"""
import os
import re
import struct
import sys

REPO = "/Users/xig/coaster/oss/miu2d"
PAK_DIR = os.path.join(REPO, "games-raw/xinjianxiaqingyuan/data")
YUEYING = os.path.join(REPO, "resources/yueying")
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SCAN_DIRS = [os.path.join(OUT_DIR, d) for d in ("sword1-ini", "sword1-script", "sword1-extract")]
TEXT_EXTS = (".ini", ".txt", ".npc", ".obj")

PAKS = ["asf", "font", "img", "ini", "map", "mpc", "script", "sound"]


def hash_name(name: str) -> int:
    data = name.encode("gbk", errors="ignore")
    result = 0
    for cnt, b in enumerate(data):
        if b == 0x2F:  # '/'
            b = 0x5C
        if 0x41 <= b <= 0x5A:
            b += 0x20
        u = b - 0x100 if b >= 0x80 else b  # signed char
        u &= 0xFFFFFFFF
        # C++ does u*(cnt+1)+result in 32-bit uint (wraps) BEFORE the modulo
        result = ((u * (cnt + 1) + result) & 0xFFFFFFFF) % 0x8000000B
        result = ((((result ^ 0xFFFFFFFF) + 1) << 4) - result) & 0xFFFFFFFF
    return result ^ 0x12345678


def read_index(pak_path: str) -> dict:
    with open(pak_path, "rb") as f:
        head = f.read(16)
        assert head[:8] == b"PACKAGE\x00"
        count = struct.unpack_from("<I", head, 8)[0]
        idx = f.read(count * 12)
    ids = {}
    for i in range(count):
        fid = struct.unpack_from("<I", idx, i * 12)[0]
        ids[fid] = i
    return ids


# candidate prefixes to try per bare-name extension (yueying layout as prior)
PREFIXES = {
    ".ini": ["ini\\npcres\\", "ini\\npc\\", "ini\\objres\\", "ini\\obj\\",
             "ini\\goods\\", "ini\\magic\\", "ini\\buy\\", "ini\\level\\",
             "ini\\ui\\", "ini\\save\\", "ini\\map\\", "ini\\"],
    ".txt": ["script\\map\\", "script\\common\\", "script\\goods\\", "script\\"],
    ".map": ["map\\map\\", "map\\littlemap\\", "map\\"],
    ".asf": ["asf\\character\\", "asf\\effect\\", "asf\\goods\\", "asf\\magic\\",
             "asf\\object\\", "asf\\portrait\\", "asf\\ui\\", "asf\\font\\",
             "asf\\interlude\\", "asf\\sound\\", "asf\\music\\", "asf\\video\\",
             "asf\\", "mpc\\character\\", "mpc\\effect\\", "mpc\\goods\\",
             "mpc\\magic\\", "mpc\\object\\", "mpc\\portrait\\", "mpc\\ui\\",
             "mpc\\interlude\\", "mpc\\"],
    ".mpc": ["mpc\\character\\", "mpc\\effect\\", "mpc\\goods\\", "mpc\\magic\\",
             "mpc\\object\\", "mpc\\portrait\\", "mpc\\ui\\", "mpc\\interlude\\",
             "mpc\\"],
    ".wav": ["sound\\", "sound\\effect\\", "sound\\music\\"],
    ".mp3": ["sound\\", "music\\"],
    ".npc": ["ini\\save\\", "ini\\map\\", "save\\", "ini\\"],
    ".obj": ["ini\\save\\", "ini\\map\\", "save\\", "ini\\"],
    ".shd": ["shd\\", "mpc\\shd\\", "img\\"],
    ".img": ["img\\"],
    ".ttf": ["font\\"],
    ".fnt": ["font\\"],
}

# token: filename-ish string ending in a known extension (GBK text already decoded)
EXTS = "|".join(e[1:] for e in PREFIXES)
TOKEN_RE = re.compile(
    r"[0-9A-Za-z_\-一-鿿()（）·．.\\/]+?\.(?:" + EXTS + r")",
    re.IGNORECASE,
)


def gen_candidates():
    cands = set()

    # 1. yueying tree, translated to pak paths
    for root, _, files in os.walk(YUEYING):
        for fn in files:
            rel = os.path.relpath(os.path.join(root, fn), YUEYING)
            cands.add(rel.replace("/", "\\"))

    # 2. tokens from extracted sword1 text
    for d in SCAN_DIRS:
        if not os.path.isdir(d):
            continue
        for root, _, files in os.walk(d):
            for fn in files:
                if not fn.lower().endswith(TEXT_EXTS):
                    continue
                try:
                    raw = open(os.path.join(root, fn), "rb").read()
                    text = raw.decode("gbk", errors="ignore")
                except OSError:
                    continue
                # self-naming: config inis carry their own identity in Name=/ObjName=
                for m in re.finditer(r"^(?:Obj)?Name=(.+?)\s*$", text, re.M):
                    nm = m.group(1).strip()
                    if not nm or len(nm) > 40:
                        continue
                    for p in ("ini\\npc\\", "ini\\goods\\", "ini\\obj\\",
                              "ini\\magic\\", "ini\\npcres\\", "ini\\objres\\",
                              "ini\\buy\\", "ini\\level\\"):
                        cands.add(p + nm + ".ini")
                        for i in range(1, 10):
                            cands.add(f"{p}{nm}{i}.ini")
                    # numbered-prefix style: ini\npc\npc024_张林.ini
                    for fam in ("npc", "obj", "goods", "magic", "npcres", "objres"):
                        for i in range(300):
                            cands.add(f"ini\\{fam}\\{fam}{i:03d}_{nm}.ini")
                for tok in TOKEN_RE.findall(text):
                    tok = tok.strip(".\\/")
                    if not tok or len(tok) > 80:
                        continue
                    # token may already carry a path
                    if "\\" in tok or "/" in tok:
                        cands.add(tok.replace("/", "\\"))
                        tok = re.split(r"[\\/]", tok)[-1]
                    ext = "." + tok.rsplit(".", 1)[-1].lower()
                    for p in PREFIXES.get(ext, [""]):
                        cands.add(p + tok)

    # 2b. dynamic per-map candidates from harvested map names
    stems = set()
    for c in list(cands):
        base = c.split("\\")[-1]
        if base.lower().endswith(".map"):
            stems.add(base[:-4])
    txt_tokens = {c.split("\\")[-1] for c in cands if c.lower().endswith(".txt")}
    for stem in stems:
        cands.add("map\\" + stem + ".map")
        num = stem.split("_")[0]
        for n in (stem, num):
            for p in ("map\\littlemap\\", "map\\smap\\", "map\\little\\", "map\\"):
                cands.add(p + n + ".bmp")
        for i in range(3000):
            cands.add(f"mpc\\map\\{stem}\\{i}.mpc")
            cands.add(f"mpc\\map\\{stem}\\{i:03d}.mpc")
        for i in range(200):
            cands.add(f"mpc\\map\\{stem}\\{i}.bmp")
            cands.add(f"mpc\\map\\{stem}\\{i:03d}.bmp")
        for t in txt_tokens:
            cands.add(f"script\\{stem}\\{t}")
            cands.add(f"script\\map\\{stem}\\{t}")
            cands.add(f"script\\{num}\\{t}")
            cands.add(f"script\\npc\\{t}")
            cands.add(f"script\\magic\\{t}")
            cands.add(f"script\\event\\{t}")
            cands.add(f"script\\talk\\{t}")
    # cross-extension: an asf/mpc token stem often has a sibling config ini
    for c in list(cands):
        base = c.split("\\")[-1]
        stem, dot, ext = base.rpartition(".")
        if dot and ext.lower() in ("asf", "mpc") and stem:
            for p in ("ini\\goods\\", "ini\\magic\\", "ini\\npcres\\",
                      "ini\\objres\\", "ini\\ui\\"):
                cands.add(p + stem + ".ini")

    # numeric save-file generation (loose files show map%03d(_event%d) style)
    for n in range(0, 150):
        for ext in (".npc", ".obj"):
            cands.add(f"ini\\save\\map{n:03d}{ext}")
            cands.add(f"ini\\save\\temp_map{n:03d}{ext}")
            for ev in range(0, 40):
                cands.add(f"ini\\save\\map{n:03d}_event{ev}{ext}")

    # 2c. font names (debug.log style: \font\lb12.fnt) + minimap bmp patterns
    for fam in ("lb", "hz", "asc", "song", "kai", "hei", "fs"):
        for sz in range(8, 49):
            cands.add(f"font\\{fam}{sz}.fnt")
    for stem in stems:
        num = stem.split("_")[0]
        num3 = num.replace("map", "")
        for pat in (f"map\\littlemap\\{stem}s.bmp", f"map\\{stem}s.bmp",
                    f"map\\littlemap\\little{num3}.bmp", f"map\\bmp\\{stem}.bmp",
                    f"map\\map\\{stem}.bmp", f"map\\{num}s.bmp",
                    f"map\\littlemap\\{num3}.bmp", f"map\\s{num3}.bmp",
                    f"map\\small\\{stem}.bmp", f"map\\smallmap\\{stem}.bmp",
                    f"map\\minimap\\{stem}.bmp", f"map\\小地图\\{stem}.bmp",
                    f"map\\littlemap\\小{stem}.bmp", f"map\\little\\{num}.bmp"):
            cands.add(pat)

    # 3. loose install files (bare + common roots)
    install = os.path.dirname(PAK_DIR)
    for fn in os.listdir(install):
        if "." not in fn:
            continue
        ext = "." + fn.rsplit(".", 1)[-1].lower()
        for p in PREFIXES.get(ext, [""]):
            cands.add(p + fn)

    return cands


def main():
    indexes = {p: read_index(os.path.join(PAK_DIR, p + ".pak")) for p in PAKS}
    cands = gen_candidates()
    print(f"candidates: {len(cands)}")

    matched = {p: {} for p in PAKS}  # pak -> {hash: name}
    for name in cands:
        h = hash_name(name)
        for p in PAKS:
            if h in indexes[p]:
                # entries live under their pak's root dir; anything else is a
                # hash false positive from the generated candidate flood
                if not name.lower().startswith(p + "\\"):
                    continue
                prev = matched[p].get(h)
                if prev is not None and prev.lower() != name.lower():
                    print(f"  COLLISION in {p}: {prev!r} vs {name!r}")
                matched[p][h] = name

    total_named = 0
    for p in PAKS:
        n, total = len(matched[p]), len(indexes[p])
        total_named += n
        print(f"{p}.pak: {n}/{total} named ({100 * n // max(total, 1)}%)")
        with open(os.path.join(OUT_DIR, f"names-{p}.txt"), "w", encoding="utf-8") as f:
            for h in sorted(matched[p]):
                f.write(matched[p][h] + "\n")
    print(f"total named: {total_named}")


if __name__ == "__main__":
    main()
