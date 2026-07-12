#!/usr/bin/env python3
"""
扫描所有剧情脚本，找出 LoadNpc / LoadObj 引用了但实际找不到文件的场景。

查找路径（模拟原引擎行为）：
  1. <resources>/save/game/<file>          （C++/C# 主路径）
  2. <resources>/ini/save/<file>           （C# fallback）

用法：
  python scripts/find-missing-npc-obj.py
  python scripts/find-missing-npc-obj.py --resources resources-sword2-new
"""

import argparse
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent

# 默认扫描的资源目录列表
DEFAULT_RESOURCES = [
    "resources-sword2-new",
    "resources-sword2",
    "resources-xin",
    "resources",
]

# 匹配 LoadNpc("xxx") / LoadObj("xxx.obj") 等，忽略大小写
LOAD_PATTERN = re.compile(
    r'\b(LoadNpc|LoadObj)\s*\(\s*"([^"]+)"\s*\)',
    re.IGNORECASE,
)
LOAD_MAP_PATTERN = re.compile(
    r'\bLoadMap\s*\(\s*"([^"]+)"\s*\)',
    re.IGNORECASE,
)


def build_file_index(root: Path) -> dict[str, Path]:
    """构建大小写不敏感的文件索引，key 为小写文件名，value 为实际路径。"""
    index: dict[str, Path] = {}
    for search_dir in ["save/game", "ini/save"]:
        d = root / search_dir
        if d.is_dir():
            for f in d.iterdir():
                if f.is_file():
                    index[f.name.lower()] = f
    return index


def scan_scripts(resources_root: Path, file_index: dict[str, Path]) -> list[dict]:
    """扫描脚本目录，返回所有找不到对应文件的引用。"""
    script_dir = resources_root / "script"
    if not script_dir.is_dir():
        return []

    missing = []
    for script_path in sorted(script_dir.rglob("*.txt")):
        try:
            content = script_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        current_map: str | None = None
        for lineno, line in enumerate(content.splitlines(), 1):
            map_match = LOAD_MAP_PATTERN.search(line)
            if map_match:
                current_map = map_match.group(1)

            for m in LOAD_PATTERN.finditer(line):
                cmd, ref_file = m.group(1), m.group(2)
                if ref_file.lower() not in file_index:
                    missing.append(
                        {
                            "script": script_path.relative_to(resources_root),
                            "line": lineno,
                            "cmd": cmd,
                            "file": ref_file,
                            "map": current_map,
                        }
                    )

    return missing


def main() -> None:
    parser = argparse.ArgumentParser(description="找出脚本中引用但找不到的 NPC/OBJ 文件")
    parser.add_argument(
        "--resources",
        nargs="+",
        default=DEFAULT_RESOURCES,
        help="要扫描的资源目录名（相对于仓库根目录）",
    )
    args = parser.parse_args()

    any_found = False
    for res_name in args.resources:
        resources_root = REPO_ROOT / res_name
        if not resources_root.is_dir():
            continue

        file_index = build_file_index(resources_root)
        missing = scan_scripts(resources_root, file_index)

        if not missing:
            print(f"[{res_name}] ✓ 无缺失文件")
            continue

        any_found = True
        print(f"\n{'=' * 60}")
        print(f"[{res_name}] 共 {len(missing)} 处引用找不到文件：")
        print(f"{'=' * 60}")

        # 按缺失文件名分组输出
        by_file: dict[str, list[dict]] = {}
        for item in missing:
            key = item["file"].lower()
            by_file.setdefault(key, []).append(item)

        for ref_key in sorted(by_file):
            items = by_file[ref_key]
            ref_file = items[0]["file"]
            print(f"\n  缺失文件: {ref_file}  ({len(items)} 处引用)")
            for item in items:
                map_str = f"  [当前地图: {item['map']}]" if item["map"] else ""
                print(f"    {item['script']}:{item['line']}  {item['cmd']}(\"{item['file']}\"){map_str}")

    if not any_found:
        print("\n✓ 所有 LoadNpc/LoadObj 引用均能找到对应文件")

    sys.exit(1 if any_found else 0)


if __name__ == "__main__":
    main()
