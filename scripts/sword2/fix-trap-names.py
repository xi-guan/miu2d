#!/usr/bin/env python3
"""
修复场景陷阱文件名大小写问题

从 scenes.mmf_data (base64 binary) 解析每个地图的 trapTable，
以 trapTable.scriptPath 作为权威名称，将 scene.data.scripts/traps 中的
对应条目重命名（仅大小写修正），并将所有 MMF 中定义的陷阱脚本移入 data.traps。

使用方式：
    python3 scripts/fix-trap-names.py [--dry-run] [--game SLUG]

参数：
    --dry-run   只打印变更，不写库
    --game SLUG 只处理指定游戏（默认处理所有游戏）

通过 docker exec 操作 miu2d-postgres 容器中的数据库，无需额外 Python 依赖。
"""

import argparse
import base64
import json
import struct
import subprocess
import sys


# ─── MMF 解析 ────────────────────────────────────────────────────────────────

def parse_mmf_trap_table(mmf_b64: str) -> dict[int, str]:
    """
    解析 MMF base64 数据，返回 {trapIndex: scriptPath} 映射。
    只读取 TrapTable，不解压 tile 数据。
    """
    try:
        data = base64.b64decode(mmf_b64)
    except Exception:
        return {}

    if len(data) < 20 or data[0:4] != b"MMF1":
        return {}

    flags = struct.unpack_from("<H", data, 6)[0]
    offset = 8

    # Map Header
    msf_count = struct.unpack_from("<H", data, offset + 4)[0]
    trap_count = struct.unpack_from("<H", data, offset + 6)[0]
    offset += 12  # cols(2) + rows(2) + msfCount(2) + trapCount(2) + reserved(4)

    # Skip MSF Table
    for _ in range(msf_count):
        if offset >= len(data):
            return {}
        name_len = data[offset]
        offset += 1 + name_len + 1  # nameLen + name + flags

    traps: dict[int, str] = {}
    if flags & 0x02:  # HAS_TRAPS
        for _ in range(trap_count):
            if offset >= len(data):
                break
            trap_idx = data[offset]
            offset += 1
            path_len = struct.unpack_from("<H", data, offset)[0]
            offset += 2
            script_path = data[offset : offset + path_len].decode("utf-8")
            offset += path_len
            traps[trap_idx] = script_path

    return traps


# ─── 核心修复逻辑 ─────────────────────────────────────────────────────────────

def fix_scene_data(
    scene_key: str,
    mmf_b64: str,
    data_json: dict,
) -> tuple[dict | None, list[str]]:
    """
    根据 MMF trapTable 修正 scene.data。

    返回 (new_data, changes) 其中：
    - new_data: 修改后的 data dict（未变化则返回 None）
    - changes: 描述变更的字符串列表
    """
    mmf_traps = parse_mmf_trap_table(mmf_b64)
    if not mmf_traps:
        return None, []

    scripts: dict[str, str] = data_json.get("scripts") or {}
    traps: dict[str, str] = data_json.get("traps") or {}

    # 构建小写索引，方便大小写不敏感查找
    scripts_lower = {k.lower(): k for k in scripts}
    traps_lower = {k.lower(): k for k in traps}

    new_scripts = dict(scripts)
    new_traps = dict(traps)
    changes: list[str] = []

    for trap_idx, mmf_name in mmf_traps.items():
        mmf_lower = mmf_name.lower()

        # 当前位置（优先在 traps 里找，再在 scripts 里找）
        current_key: str | None = None
        current_section: str | None = None

        if mmf_lower in traps_lower:
            current_key = traps_lower[mmf_lower]
            current_section = "traps"
        elif mmf_lower in scripts_lower:
            current_key = scripts_lower[mmf_lower]
            current_section = "scripts"

        if current_key is None:
            # MMF 引用的脚本在 DB 中不存在（可能未上传）—— 保留警告，跳过
            changes.append(f"  WARN trap[{trap_idx}] {repr(mmf_name)}: not found in DB (skip)")
            continue

        if current_section == "traps" and current_key == mmf_name:
            # 已经正确
            continue

        content = (new_traps if current_section == "traps" else new_scripts)[current_key]

        # 从原位置删除旧 key
        if current_section == "traps":
            del new_traps[current_key]
        else:
            del new_scripts[current_key]

        # 写入 traps，key = MMF 权威名称
        new_traps[mmf_name] = content

        if current_section == "scripts":
            changes.append(
                f"  mv scripts[{repr(current_key)}] -> traps[{repr(mmf_name)}]"
            )
        else:
            changes.append(
                f"  rename traps[{repr(current_key)}] -> traps[{repr(mmf_name)}]"
            )

    if not changes or all(c.startswith("  WARN") for c in changes):
        return None, changes

    new_data = dict(data_json)
    new_data["scripts"] = new_scripts
    new_data["traps"] = new_traps
    return new_data, changes


DOCKER_CONTAINER = "miu2d-postgres"
PSQL_BASE = ["docker", "exec", "-i", DOCKER_CONTAINER,
             "psql", "-U", "postgres", "-d", "miu2d_db"]


def psql_query(sql: str) -> str:
    """执行查询，返回原始标准输出（-t -A 模式，字段用 TAB 分隔）。"""
    result = subprocess.run(
        PSQL_BASE + ["-t", "-A", "-F", "\t", "-c", sql],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"psql error: {result.stderr.strip()}")
    return result.stdout


def psql_update(sql: str) -> None:
    """通过 stdin 执行 UPDATE/INSERT（支持含特殊字符的大 JSON 字符串）。"""
    result = subprocess.run(
        PSQL_BASE,
        input=sql,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"psql error: {result.stderr.strip()}")


# ─── 主程序 ──────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="只打印变更，不写库")
    parser.add_argument("--game", metavar="SLUG", help="只处理指定游戏")
    args = parser.parse_args()

    # ── 查询目标场景 ──────────────────────────────────────────────────────────
    game_filter = f"AND g.slug = '{args.game}'" if args.game else ""
    raw = psql_query(f"""
        SELECT s.id, g.slug, s.key, s.mmf_data, s.data::text
        FROM scenes s
        JOIN games g ON g.id = s.game_id
        WHERE s.mmf_data IS NOT NULL
          AND s.data IS NOT NULL
          {game_filter}
        ORDER BY g.slug, s.key
    """)

    rows = []
    for line in raw.strip().splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 4)
        if len(parts) < 5:
            continue
        rows.append({
            "id": parts[0],
            "slug": parts[1],
            "key": parts[2],
            "mmf_data": parts[3],
            "data": json.loads(parts[4]),
        })

    print(f"==> Scanning {len(rows)} scenes ...")

    updated = 0
    warnings = 0

    for row in rows:
        scene_id = row["id"]
        slug = row["slug"]
        key = row["key"]
        mmf_b64 = row["mmf_data"]
        data_json = row["data"]

        if not mmf_b64 or not data_json:
            continue

        new_data, changes = fix_scene_data(key, mmf_b64, data_json)

        for c in changes:
            if c.startswith("  WARN"):
                print(f"[{slug}/{key}]{c}")
                warnings += 1

        if new_data is None:
            continue

        real_changes = [c for c in changes if not c.startswith("  WARN")]
        print(f"[{slug}/{key}] {len(real_changes)} change(s):")
        for c in real_changes:
            print(c)

        updated += 1
        if not args.dry_run:
            # 转义单引号后作为字面字符串传入（无参数化，但所有内容来自 DB 本身，无外部输入）
            data_sql = json.dumps(new_data, ensure_ascii=False).replace("'", "''")
            psql_update(f"UPDATE scenes SET data = '{data_sql}'::jsonb WHERE id = '{scene_id}';")

    if args.dry_run:
        print(f"\n==> DRY RUN — {updated} scenes would be updated, {warnings} warnings")
    else:
        print(f"\n==> Done — {updated} scenes updated, {warnings} warnings")


if __name__ == "__main__":
    main()
