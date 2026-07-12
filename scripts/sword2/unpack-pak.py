#!/usr/bin/env python3
"""unpack PACKAGE .pak files from The Legend Of Swordman / Sword2.

usage:
    python3 scripts/unpack-pak.py <pak_file> <out_dir>
    python3 scripts/unpack-pak.py data/ini.pak out/ini/

the pak format:
    header: "PACKAGE\x00" (8 bytes)
    count:  uint32 LE
    unk:    uint32 LE (always 2)
    index:  count * 12 bytes each:
              checksum uint32  (Adler-32 of compressed data)
              offset   uint32  (absolute offset in file)
              size     uint32  (compressed size)
    name table: immediately after index, null-terminated GBK strings, one per entry
    data blocks: at their respective offsets, LZSS-compressed
"""

import os
import struct
import sys


def lzss_decompress(data: bytes) -> bytes:
    """decompress LZSS variant used in TLOS pak files.

    format: stream of control groups
      - 1 byte flags: bit 7..0, high bit first
      - for each bit (high to low):
        - bit=1: literal byte follows
        - bit=0: back-reference: 2 bytes (offset_hi|len_lo, offset_lo)
                 offset = 12 bits, len = 4 bits + 3 (min match = 3)
    ring buffer size = 4096, initial fill = 0x20 (space)
    """
    out = bytearray()
    ring = bytearray(b"\x20" * 4096)
    ring_pos = 4078  # standard LZSS initial position

    i = 0
    while i < len(data):
        flags = data[i]
        i += 1
        for bit in range(8):
            if i >= len(data):
                break
            if flags & (1 << (7 - bit)):
                # literal
                b = data[i]
                i += 1
                out.append(b)
                ring[ring_pos] = b
                ring_pos = (ring_pos + 1) & 0xFFF
            else:
                # back-reference
                if i + 1 >= len(data):
                    break
                b0, b1 = data[i], data[i + 1]
                i += 2
                ref_offset = ((b0 & 0xF0) << 4) | b1
                ref_len = (b0 & 0x0F) + 3
                for _ in range(ref_len):
                    b = ring[ref_offset & 0xFFF]
                    ref_offset += 1
                    out.append(b)
                    ring[ring_pos] = b
                    ring_pos = (ring_pos + 1) & 0xFFF
    return bytes(out)


def unpack(pak_path: str, out_dir: str) -> None:
    with open(pak_path, "rb") as f:
        magic = f.read(8)
        if magic != b"PACKAGE\x00":
            raise ValueError(f"not a PACKAGE file: {magic!r}")

        count = struct.unpack_from("<I", f.read(4))[0]
        f.read(4)  # unk

        entries = []
        for _ in range(count):
            checksum, offset, size = struct.unpack_from("<III", f.read(12))
            entries.append((checksum, offset, size))

        # name table follows index
        names = []
        for _ in range(count):
            name = bytearray()
            while True:
                b = f.read(1)
                if not b or b == b"\x00":
                    break
                name += b
            names.append(name.decode("gbk", errors="replace"))

        ok = err = 0
        for (checksum, offset, size), name in zip(entries, names):
            out_path = os.path.join(out_dir, name.replace("\\", os.sep))
            parent = os.path.dirname(out_path)
            if not parent or parent == out_dir:
                out_path = os.path.join(out_dir, os.path.basename(name))
                parent = out_dir
            os.makedirs(parent, exist_ok=True)

            f.seek(offset)
            compressed = f.read(size)

            try:
                decompressed = lzss_decompress(compressed)
            except Exception as e:
                print(f"  ERR decompress {name}: {e}")
                err += 1
                continue

            with open(out_path, "wb") as wf:
                wf.write(decompressed)
            ok += 1

        print(f"{pak_path}: {ok} ok, {err} errors → {out_dir}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: unpack-pak.py <pak_file> <out_dir>")
        sys.exit(1)
    unpack(sys.argv[1], sys.argv[2])
