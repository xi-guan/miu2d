#!/usr/bin/env python3
"""batch-upload converted resources (.msf/.mmf/.ogg/.webm) into MinIO via the
server's tRPC upload API, mirroring what the dashboard drag-drop does.

stdlib only. presigned PUT needs no MinIO creds. usage:
  python3 scripts/upload-resources.py <gameSlug> <dir1> [dir2 ...]
"""
import base64
import binascii
import json
import os
import struct
import sys
import http.cookiejar
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

API = "http://localhost:4100"
EMAIL = "admin@example.com"
PASSWORD = "password"
RESOURCES_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "resources"))
BATCH = 50          # files per prepare call
PUT_WORKERS = 8     # concurrent PUTs

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def trpc(proc, payload):
    """call a tRPC mutation (batch=1 envelope), return the inner data."""
    url = f"{API}/trpc/{proc}?batch=1"
    body = json.dumps({"0": payload}).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    with opener.open(req) as r:
        resp = json.loads(r.read())
    item = resp[0]
    if "error" in item:
        raise RuntimeError(f"{proc}: {item['error']['message'][:200]}")
    return item["result"]["data"]


def login():
    trpc("auth.login", {"email": EMAIL, "password": PASSWORD})
    print(f"  login ok ({EMAIL})")


def ensure_folder(game_id, parts):
    return trpc("file.ensureFolderPath",
                {"gameId": game_id, "parentId": None, "pathParts": parts})["folderId"]


def put_file(upload_url, path):
    with open(path, "rb") as f:
        data = f.read()
    # presigned URL signs an x-amz-checksum-crc32 header — must send the real crc32
    crc = binascii.crc32(data) & 0xFFFFFFFF
    crc_b64 = base64.b64encode(struct.pack(">I", crc)).decode()
    req = urllib.request.Request(upload_url, data=data, method="PUT", headers={
        "x-amz-checksum-crc32": crc_b64,
        "x-amz-sdk-checksum-algorithm": "CRC32",
    })
    with urllib.request.urlopen(req) as r:
        return r.status


def main():
    if len(sys.argv) < 3:
        print("usage: upload-resources.py <gameSlug> <dir1> [dir2 ...]")
        sys.exit(1)
    slug = sys.argv[1]
    dirs = sys.argv[2:]

    login()
    # gameId comes from db; fetch via games list is not exposed, so read from arg env
    game_id = os.environ.get("GAME_ID")
    if not game_id:
        print("  ERROR: set GAME_ID env to the game uuid")
        sys.exit(1)
    print(f"  game={slug} id={game_id}")

    # 1. collect all files grouped by their relative folder
    by_folder = {}  # rel_folder tuple -> [(abs_path, name), ...]
    total = 0
    for d in dirs:
        base = os.path.abspath(d)
        top = os.path.basename(base)
        for root, _, files in os.walk(base):
            for fn in files:
                if fn.startswith("."):
                    continue
                ap = os.path.join(root, fn)
                rel = os.path.relpath(root, base)
                parts = [top] if rel == "." else [top] + rel.split(os.sep)
                by_folder.setdefault(tuple(parts), []).append((ap, fn))
                total += 1
    print(f"  found {total} files in {len(by_folder)} folders")

    # 2. ensure folders, then prepare+PUT+confirm per folder
    done = 0
    failed = 0
    for parts, items in sorted(by_folder.items()):
        folder_id = ensure_folder(game_id, list(parts))
        for i in range(0, len(items), BATCH):
            chunk = items[i:i + BATCH]
            files_input = [{
                "clientId": f"c{j}",
                "parentId": folder_id,
                "name": name,
                "size": os.path.getsize(ap),
                "mimeType": "application/octet-stream",
            } for j, (ap, name) in enumerate(chunk)]
            res = trpc("file.batchPrepareUpload",
                       {"gameId": game_id, "files": files_input, "skipExisting": True})
            results = res["results"]
            # map clientId -> (uploadUrl, fileId, abs_path)
            cid_to_path = {f"c{j}": ap for j, (ap, _) in enumerate(chunk)}
            puts = []
            confirm_ids = []
            with ThreadPoolExecutor(max_workers=PUT_WORKERS) as ex:
                futs = {}
                for r in results:
                    if not r.get("uploadUrl"):   # skipExisting → already there
                        continue
                    ap = cid_to_path[r["clientId"]]
                    futs[ex.submit(put_file, r["uploadUrl"], ap)] = r["fileId"]
                for fut in as_completed(futs):
                    fid = futs[fut]
                    try:
                        if fut.result() in (200, 204):
                            confirm_ids.append(fid)
                        else:
                            failed += 1
                    except Exception:
                        failed += 1
            if confirm_ids:
                trpc("file.batchConfirmUpload", {"fileIds": confirm_ids})
            done += len(chunk)
            print(f"  {done}/{total}  (/{'/'.join(parts)})", flush=True)
    print(f"\nDONE: {done} processed, {failed} failed")


if __name__ == "__main__":
    main()
