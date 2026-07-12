#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

REPORT_LIMIT = 100
AI_BATCH_SIZE = 40


def file_ext(path: str | Path) -> str:
    suffix = Path(path).suffix.lower()
    return suffix[1:] if suffix else "[noext]"


def normalize_text(value: str) -> str:
    value = value.lower().replace("\\", "/")
    value = re.sub(r"\.(asf|mpc|msf)$", "", value)
    value = re.sub(r"[_\-\s()/（）]+", "", value)
    return value


def category_for(path: str) -> str:
    parts = path.replace("\\", "/").split("/")
    lower = [part.lower() for part in parts]
    ext = file_ext(path)
    if lower[0] == "content":
        if len(lower) > 1 and lower[1] in {"music", "sound", "video", "font", "ui", "effect"}:
            return f"content:{lower[1]}"
        return "content:other"
    if lower[0] == "asf":
        if len(lower) > 1 and lower[1] in {
            "character",
            "effect",
            "goods",
            "interlude",
            "magic",
            "object",
            "portrait",
            "ui",
        }:
            return f"sprite:{lower[1]}"
        if "未找到" in path:
            return "sprite:unknown"
        return "sprite:other"
    if lower[0] == "mpc":
        if len(lower) > 1 and lower[1] == "map":
            return "map:tile"
        if "未找到" in path:
            return "map:unknown"
        return "map:mpc"
    if lower[0] == "map":
        if len(lower) > 1 and lower[1] == "littlemap":
            return "map:minimap"
        return "map:data"
    if lower[0] == "ini":
        return f"config:{lower[1]}" if len(lower) > 1 else "config:root"
    if lower[0] == "script":
        return f"script:{lower[1]}" if len(lower) > 1 else "script:root"
    if lower[0] == "save":
        return "save"
    if ext in {"exe", "dll"}:
        return "legacy-binary"
    return "other"


def rel_path(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def build_assets(resources_root: Path) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    assets = []
    by_path = {}
    for path in resources_root.rglob("*"):
        if not path.is_file():
            continue
        stat = path.stat()
        rel = rel_path(path, resources_root)
        asset = {
            "path": rel,
            "name": path.name,
            "stem": path.stem,
            "dir": Path(rel).parent.as_posix(),
            "ext": file_ext(rel),
            "bytes": stat.st_size,
            "category": category_for(rel),
            "unknownBucket": "未找到" in rel,
        }
        assets.append(asset)
        by_path[rel] = asset
    assets.sort(key=lambda item: item["path"].lower())
    return assets, by_path


def duplicate_groups(resources_root: Path) -> list[dict[str, Any]]:
    size_groups: dict[int, list[Path]] = defaultdict(list)
    for path in resources_root.rglob("*"):
        if path.is_file():
            size_groups[path.stat().st_size].append(path)

    hash_groups: dict[str, list[Path]] = defaultdict(list)
    for paths in size_groups.values():
        if len(paths) < 2:
            continue
        for path in paths:
            hash_groups[sha256_file(path)].append(path)

    groups = []
    for digest, paths in hash_groups.items():
        if len(paths) < 2:
            continue
        rels = sorted(rel_path(path, resources_root) for path in paths)
        groups.append(
            {
                "sha256": digest,
                "bytes": paths[0].stat().st_size,
                "count": len(paths),
                "files": rels,
            }
        )
    groups.sort(key=lambda item: (-(item["bytes"] * item["count"]), item["files"][0].lower()))
    return groups


def category_summary(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts = Counter(asset["category"] for asset in assets)
    sizes = Counter()
    for asset in assets:
        sizes[asset["category"]] += asset["bytes"]
    return [
        {"category": category, "files": count, "bytes": sizes[category]}
        for category, count in counts.most_common()
    ]


def extension_summary(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts = Counter(asset["ext"] for asset in assets)
    sizes = Counter()
    for asset in assets:
        sizes[asset["ext"]] += asset["bytes"]
    return [{"ext": ext, "files": count, "bytes": sizes[ext]} for ext, count in counts.most_common()]


def best_file_suggestions(ref: str, assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ref_path = Path(ref)
    ref_dir = ref_path.parent.as_posix()
    ref_norm = normalize_text(ref_path.stem)
    ref_category = category_for(ref)
    scored = []
    for asset in assets:
        if asset["ext"] not in {"asf", "msf", "mpc", "png", "jpg", "jpeg"}:
            continue
        asset_norm = normalize_text(asset["stem"])
        name_score = SequenceMatcher(None, ref_norm, asset_norm).ratio()
        contains = len(ref_norm) >= 3 and (ref_norm in asset_norm or asset_norm in ref_norm)
        if name_score < 0.42 and not contains:
            continue
        score = name_score
        if asset["dir"].lower() == ref_dir.lower():
            score += 0.2
        if asset["category"] == ref_category:
            score += 0.12
        if asset["ext"] == file_ext(ref):
            score += 0.05
        if score < 0.58:
            continue
        scored.append((score, asset))
    scored.sort(key=lambda item: (-item[0], item[1]["bytes"], item[1]["path"].lower()))
    return [
        {
            "path": asset["path"],
            "score": round(min(score, 1.0), 3),
            "bytes": asset["bytes"],
            "category": asset["category"],
        }
        for score, asset in scored[:10]
    ]


def duplicate_insights(groups: list[dict[str, Any]], by_path: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, list[str]]]:
    insights = []
    unknown_to_known: dict[str, list[str]] = defaultdict(list)
    for group in groups:
        unknown = [path for path in group["files"] if "未找到" in path]
        known = [path for path in group["files"] if "未找到" not in path]
        if not unknown or not known:
            continue
        known_sorted = sorted(known, key=lambda path: (by_path[path]["category"], path.lower()))
        for path in unknown:
            unknown_to_known[path].extend(known_sorted)
        insights.append(
            {
                "bytes": group["bytes"],
                "unknownFiles": unknown[:20],
                "knownFiles": known_sorted[:20],
                "suggestedCategory": by_path[known_sorted[0]]["category"] if known_sorted else "unknown",
            }
        )
    insights.sort(key=lambda item: (-item["bytes"], item["unknownFiles"][0].lower()))
    return insights[:REPORT_LIMIT], unknown_to_known


def missing_ref_tasks(audit: dict[str, Any], assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    tasks = []
    for item in audit.get("missingDirectReferences", []):
        ref = item["ref"]
        tasks.append(
            {
                "ref": ref,
                "count": item["count"],
                "sources": item["sources"],
                "expectedCategory": category_for(ref),
                "suggestions": best_file_suggestions(ref, assets),
            }
        )
    return tasks


def unknown_asset_tasks(
    assets: list[dict[str, Any]],
    unknown_to_known: dict[str, list[str]],
    by_path: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    tasks = []
    for asset in assets:
        if not asset["unknownBucket"]:
            continue
        known = unknown_to_known.get(asset["path"], [])
        if known:
            matched = [by_path[path] for path in known[:5]]
            suggested = matched[0]["category"]
            confidence = "high"
        else:
            matched = []
            suggested = asset["category"]
            confidence = "low"
        tasks.append(
            {
                "path": asset["path"],
                "bytes": asset["bytes"],
                "ext": asset["ext"],
                "suggestedCategory": suggested,
                "confidence": confidence,
                "duplicateOf": [
                    {"path": item["path"], "category": item["category"], "bytes": item["bytes"]}
                    for item in matched
                ],
            }
        )
    tasks.sort(key=lambda item: (item["confidence"] != "high", -item["bytes"], item["path"].lower()))
    return tasks


def ai_batches(tasks: list[dict[str, Any]], batch_size: int = AI_BATCH_SIZE) -> list[dict[str, Any]]:
    batches = []
    for index in range(0, len(tasks), batch_size):
        rows = tasks[index : index + batch_size]
        batches.append(
            {
                "id": f"unknown-assets-{len(batches) + 1:03d}",
                "count": len(rows),
                "assets": rows,
            }
        )
    return batches


def build_catalog(resources_root: Path, audit_path: Path, output: Path) -> dict[str, Any]:
    started = time.time()
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    assets, by_path = build_assets(resources_root)
    groups = duplicate_groups(resources_root)
    duplicate_matches, unknown_to_known = duplicate_insights(groups, by_path)
    missing_tasks = missing_ref_tasks(audit, assets)
    unknown_tasks = unknown_asset_tasks(assets, unknown_to_known, by_path)
    high_confidence_unknown = [task for task in unknown_tasks if task["confidence"] == "high"]

    catalog = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "resourcesRoot": resources_root.as_posix(),
        "auditReport": audit_path.as_posix(),
        "scanSeconds": round(time.time() - started, 3),
        "summary": {
            "totalFiles": len(assets),
            "totalBytes": sum(asset["bytes"] for asset in assets),
            "categories": len({asset["category"] for asset in assets}),
            "duplicateGroups": len(groups),
            "unknownAssets": len(unknown_tasks),
            "highConfidenceUnknownAssets": len(high_confidence_unknown),
            "missingDirectReferences": len(missing_tasks),
        },
        "byCategory": category_summary(assets),
        "byExtension": extension_summary(assets),
        "largestAssets": sorted(assets, key=lambda item: item["bytes"], reverse=True)[:REPORT_LIMIT],
        "aiTasks": {
            "missingDirectReferences": missing_tasks,
            "unknownAssets": unknown_tasks,
            "highConfidenceUnknownAssets": high_confidence_unknown,
            "duplicateUnknownMatches": duplicate_matches,
            "unknownAssetBatches": ai_batches(unknown_tasks),
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return catalog


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resources", default="resources")
    parser.add_argument("--audit", default=".data/resource-audit.json")
    parser.add_argument("--output", default=".data/resource-catalog.json")
    args = parser.parse_args()

    resources_root = Path(args.resources)
    audit_path = Path(args.audit)
    if not resources_root.is_dir():
        raise SystemExit(f"resources directory not found: {resources_root}")
    if not audit_path.is_file():
        raise SystemExit(f"audit report not found: {audit_path}")

    catalog = build_catalog(resources_root, audit_path, Path(args.output))
    print(json.dumps(catalog["summary"], ensure_ascii=False, indent=2))
    print(f"report: {args.output}")


if __name__ == "__main__":
    main()
