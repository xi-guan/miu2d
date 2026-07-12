#!/usr/bin/env python3
"""
找出 save/game/ 里存在的 NPC 文件，但脚本调用 LoadNpc 时所处的地图
与该 .npc 文件头部 Map= 字段不一致的场景。

用法：
  python3 scripts/check-npc-map-mismatch.py
  python3 scripts/check-npc-map-mismatch.py --resources resources-sword2-new
"""

import argparse
import configparser
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent

DEFAULT_RESOURCES = [
    "resources-sword2-new",
    "resources-sword2",
    "resources-xin",
    "resources",
]

LOAD_SAVE_RE = re.compile(r'\bLoad(Npc|Obj)\s*\(\s*"([^"]+)"\s*\)', re.IGNORECASE)
LOAD_MAP_RE = re.compile(r'\bLoadMap\s*\(\s*"([^"]+)"\s*\)', re.IGNORECASE)


def read_npc_map(npc_path: Path) -> str | None:
    """读取 .npc 文件中 [Head] Map= 字段，返回 None 表示没有该字段。"""
    try:
        text = npc_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    # configparser 不喜欢没有 section 就有键的情况，手动解析
    for line in text.splitlines():
        m = re.match(r'^\s*Map\s*=\s*(.+)', line, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return None


def build_file_index(root: Path) -> dict[str, Path]:
    """构建大小写不敏感的 NPC/OBJ 文件索引。"""
    index: dict[str, Path] = {}
    for search_dir in ["save/game", "ini/save"]:
        d = root / search_dir
        if not d.is_dir():
            continue
        for f in d.iterdir():
            if f.is_file() and f.suffix.lower() in (".npc", ".obj"):
                index[f.name.lower()] = f
    return index


def scan(resources_root: Path, file_index: dict[str, Path]) -> list[dict]:
    """扫描脚本，收集 LoadMap+LoadNpc/LoadObj 对，找出 Map 字段不一致的情况。"""
    script_dir = resources_root / "script"
    if not script_dir.is_dir():
        return []

    results = []
    for script_path in sorted(script_dir.rglob("*.txt")):
        try:
            content = script_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        current_map: str | None = None
        for lineno, line in enumerate(content.splitlines(), 1):
            mm = LOAD_MAP_RE.search(line)
            if mm:
                current_map = mm.group(1)

            nm = LOAD_SAVE_RE.search(line)
            if nm and current_map:
                cmd = "Load" + nm.group(1)
                ref_file = nm.group(2)
                file_path = file_index.get(ref_file.lower())
                if file_path is None:
                    continue  # 文件不存在，另一个脚本负责报告

                file_map = read_npc_map(file_path)
                if file_map is None:
                    continue  # 没有 Map= 字段，跳过

                # 大小写不敏感比较
                if file_map.lower() != current_map.lower():
                    results.append({
                        "script": str(script_path.relative_to(resources_root)),
                        "line": lineno,
                        "cmd": cmd,
                        "file": ref_file,
                        "script_map": current_map,
                        "npc_map": file_map,
                    })
    return results


def print_table(rows: list[dict]) -> None:
    if not rows:
        return

    headers = ["脚本文件", "行", "命令", "加载文件", "脚本当前地图", "文件内Map="]
    col_keys = ["script", "line", "cmd", "file", "script_map", "npc_map"]

    widths = [len(h) for h in headers]
    for row in rows:
        for i, k in enumerate(col_keys):
            widths[i] = max(widths[i], len(str(row[k])))

    sep = "+-" + "-+-".join("-" * w for w in widths) + "-+"
    fmt = "| " + " | ".join(f"{{:<{w}}}" for w in widths) + " |"

    print(sep)
    print(fmt.format(*headers))
    print(sep)
    for row in rows:
        print(fmt.format(*[str(row[k]) for k in col_keys]))
    print(sep)


def main() -> None:
    parser = argparse.ArgumentParser(description="找出 NPC 文件存在但Map字段与脚本不匹配的情况")
    parser.add_argument("--resources", nargs="+", default=DEFAULT_RESOURCES)
    args = parser.parse_args()

    any_found = False
    for res_name in args.resources:
        resources_root = REPO_ROOT / res_name
        if not resources_root.is_dir():
            continue

        file_index = build_file_index(resources_root)
        rows = scan(resources_root, file_index)

        if not rows:
            print(f"[{res_name}] ✓ 无 Map 不匹配")
            continue

        any_found = True
        print(f"\n[{res_name}] 共 {len(rows)} 处 Map 不匹配：\n")
        print_table(rows)

    sys.exit(1 if any_found else 0)


if __name__ == "__main__":
    main()
