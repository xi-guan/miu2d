#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

RESOURCE_EXTS = {
    "asf",
    "dll",
    "exe",
    "ini",
    "jpg",
    "jpeg",
    "map",
    "mmf",
    "mp3",
    "mpc",
    "mpi",
    "msf",
    "npc",
    "obj",
    "ogg",
    "png",
    "scc",
    "txt",
    "wav",
    "webm",
    "wma",
    "wmv",
    "xnb",
}
TEXT_EXTS = {"ini", "npc", "obj", "scc", "txt"}
ROOTS = {"asf", "content", "ini", "map", "mpc", "save", "script"}
REF_RE = re.compile(
    r"(?i)(?<![a-z0-9_./\\-])([a-z0-9_\-./\\\u4e00-\u9fff]+"
    r"\.(?:asf|ini|jpg|jpeg|map|mmf|mp3|mpc|mpi|msf|npc|obj|ogg|png|scc|txt|wav|webm|wma|wmv))"
)
REPORT_LIMIT = 100


def normalize_path(value: str) -> str:
    value = value.strip().strip("\"'")
    value = value.replace("\\", "/")
    value = re.sub(r"/+", "/", value)
    while value.startswith("./"):
        value = value[2:]
    value = value.lstrip("/")
    if value.lower().startswith("resources/"):
        value = value[len("resources/") :]
    return value


def file_ext(path: Path | str) -> str:
    suffix = Path(path).suffix.lower()
    return suffix[1:] if suffix else "[noext]"


def decode_text(data: bytes) -> str | None:
    if b"\x00" in data[:4096]:
        return None
    for encoding in ("utf-8-sig", "gb18030", "latin1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            pass
    return None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def candidate_keys(ref: str) -> list[str]:
    p = Path(ref)
    lower = ref.lower()
    keys = [lower]
    if p.suffix.lower() in {".asf", ".mpc"}:
        keys.append(f"{lower[: -len(p.suffix)]}.msf")
    if p.suffix.lower() == ".msf":
        keys.append(f"{lower[: -len(p.suffix)]}.asf")
        keys.append(f"{lower[: -len(p.suffix)]}.mpc")
    return list(dict.fromkeys(keys))


def exists_ref(ref: str, index: dict[str, list[str]]) -> bool:
    return any(key in index for key in candidate_keys(ref))


def top_part(ref: str) -> str:
    return ref.split("/", 1)[0].lower()


def bucket_rows(counter: Counter[str], sizes: Counter[str]) -> list[dict[str, Any]]:
    return [
        {"key": key, "files": count, "bytes": sizes[key]}
        for key, count in counter.most_common()
    ]


def add_ref(target: dict[str, dict[str, Any]], ref: str, source: str) -> None:
    item = target.setdefault(ref, {"count": 0, "sources": Counter()})
    item["count"] += 1
    item["sources"][source] += 1


def ref_rows(items: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for ref, item in items.items():
        rows.append(
            {
                "ref": ref,
                "count": item["count"],
                "sources": [source for source, _ in item["sources"].most_common(10)],
            }
        )
    rows.sort(key=lambda row: (-row["count"], row["ref"]))
    return rows[:REPORT_LIMIT]


def audit(resources_root: Path, output: Path, with_hashes: bool) -> dict[str, Any]:
    started = time.time()
    files: list[dict[str, Any]] = []
    normalized_index: dict[str, list[str]] = defaultdict(list)
    basename_index: dict[str, list[str]] = defaultdict(list)
    by_ext = Counter()
    by_ext_bytes = Counter()
    by_top = Counter()
    by_top_bytes = Counter()
    unknown_bucket = Counter()
    unknown_bucket_bytes = Counter()
    noise_files: list[str] = []
    legacy_binaries: list[str] = []
    size_groups: dict[int, list[Path]] = defaultdict(list)

    for path in resources_root.rglob("*"):
        if not path.is_file():
            continue
        stat = path.stat()
        rel = path.relative_to(resources_root).as_posix()
        ext = file_ext(rel)
        top = rel.split("/", 1)[0]
        lower = rel.lower()
        files.append({"path": rel, "bytes": stat.st_size, "ext": ext, "top": top})
        normalized_index[lower].append(rel)
        basename_index[Path(rel).name.lower()].append(rel)
        by_ext[ext] += 1
        by_ext_bytes[ext] += stat.st_size
        by_top[top] += 1
        by_top_bytes[top] += stat.st_size
        size_groups[stat.st_size].append(path)
        if "\u672a\u627e\u5230" in rel:
            bucket = rel.split("\u672a\u627e\u5230", 1)[0] + "\u672a\u627e\u5230"
            unknown_bucket[bucket] += 1
            unknown_bucket_bytes[bucket] += stat.st_size
        if Path(rel).name.lower() == ".ds_store":
            noise_files.append(rel)
        if ext in {"dll", "exe"}:
            legacy_binaries.append(rel)

    duplicate_files: list[dict[str, Any]] = []
    if with_hashes:
        hash_groups: dict[str, list[Path]] = defaultdict(list)
        for size, paths in size_groups.items():
            if len(paths) < 2:
                continue
            for path in paths:
                hash_groups[sha256_file(path)].append(path)
        for digest, paths in hash_groups.items():
            if len(paths) < 2:
                continue
            rels = sorted(path.relative_to(resources_root).as_posix() for path in paths)
            duplicate_files.append(
                {
                    "sha256": digest,
                    "bytes": paths[0].stat().st_size,
                    "count": len(paths),
                    "files": rels[:20],
                }
            )
        duplicate_files.sort(key=lambda row: (-row["bytes"] * row["count"], row["files"][0]))

    missing_direct_refs: dict[str, dict[str, Any]] = {}
    unrooted_missing_refs: dict[str, dict[str, Any]] = {}
    ambiguous_unrooted_refs: dict[str, dict[str, Any]] = {}
    references_found = 0
    text_files_scanned = 0

    for file in files:
        if file["ext"] not in TEXT_EXTS:
            continue
        path = resources_root / file["path"]
        try:
            text = decode_text(path.read_bytes())
        except OSError:
            continue
        if text is None:
            continue
        text_files_scanned += 1
        for line_no, line in enumerate(text.splitlines(), 1):
            for match in REF_RE.finditer(line):
                ref = normalize_path(match.group(1))
                if not ref:
                    continue
                references_found += 1
                source = f"{file['path']}:{line_no}"
                if top_part(ref) in ROOTS:
                    if not exists_ref(ref, normalized_index):
                        add_ref(missing_direct_refs, ref, source)
                    continue
                basename = Path(ref).name.lower()
                matches = basename_index.get(basename, [])
                if not matches:
                    add_ref(unrooted_missing_refs, ref, source)
                elif len(matches) > 1:
                    add_ref(ambiguous_unrooted_refs, ref, source)

    output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "resourcesRoot": resources_root.as_posix(),
        "scanSeconds": round(time.time() - started, 3),
        "summary": {
            "totalFiles": len(files),
            "totalBytes": sum(file["bytes"] for file in files),
            "textFilesScanned": text_files_scanned,
            "referencesFound": references_found,
            "missingDirectReferences": len(missing_direct_refs),
            "unrootedMissingCandidates": len(unrooted_missing_refs),
            "ambiguousUnrootedReferences": len(ambiguous_unrooted_refs),
            "duplicateGroups": len(duplicate_files),
            "unknownBucketFiles": sum(unknown_bucket.values()),
            "noiseFiles": len(noise_files),
            "legacyBinaries": len(legacy_binaries),
        },
        "byExtension": bucket_rows(by_ext, by_ext_bytes),
        "byTopDirectory": bucket_rows(by_top, by_top_bytes),
        "largestFiles": sorted(files, key=lambda item: item["bytes"], reverse=True)[:REPORT_LIMIT],
        "unknownBuckets": bucket_rows(unknown_bucket, unknown_bucket_bytes),
        "noiseFiles": sorted(noise_files),
        "legacyBinaries": sorted(legacy_binaries),
        "duplicateFiles": duplicate_files[:REPORT_LIMIT],
        "missingDirectReferences": ref_rows(missing_direct_refs),
        "unrootedMissingCandidates": ref_rows(unrooted_missing_refs),
        "ambiguousUnrootedReferences": ref_rows(ambiguous_unrooted_refs),
    }
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resources", default="resources")
    parser.add_argument("--output", default=".data/resource-audit.json")
    parser.add_argument("--no-hashes", action="store_true")
    args = parser.parse_args()

    resources_root = Path(args.resources)
    if not resources_root.is_dir():
        raise SystemExit(f"resources directory not found: {resources_root}")

    report = audit(resources_root, Path(args.output), not args.no_hashes)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    print(f"report: {args.output}")


if __name__ == "__main__":
    main()
