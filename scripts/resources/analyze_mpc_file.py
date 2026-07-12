#!/usr/bin/env python3
"""Analyze MPC file palette and frame RLE encoding."""
import struct
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "resources-sword2/Mpc/magic/白虹贯日.mpc"
d = open(path, "rb").read()

off = 64
w = struct.unpack_from("<I", d, off + 4)[0]
h = struct.unpack_from("<I", d, off + 8)[0]
fc = struct.unpack_from("<I", d, off + 12)[0]
cc = struct.unpack_from("<I", d, off + 20)[0]
print(f"w={w} h={h} frames={fc} colors={cc}")

ps = 128
print("Palette (BGRA in file → RGBA):")
for i in range(cc):
    po = ps + i * 4
    b, g, r, a = d[po], d[po + 1], d[po + 2], d[po + 3]
    if a != 0:  # only show non-zero alpha entries
        print(f"  [{i:3d}] file_BGRA=({b},{g},{r},{a}) -> RGBA=({r},{g},{b},{a})")

# Check for palette entries with non-255 alpha
nonopaque = [(i, *( lambda po: (d[po+2],d[po+1],d[po],d[po+3]) )(ps+i*4)) for i in range(cc) if d[ps+i*4+3] not in (0, 255)]
if nonopaque:
    print(f"\n>>> Semi-transparent palette entries: {len(nonopaque)}")
    for idx, r, g, b, a in nonopaque[:20]:
        print(f"  [{idx:3d}] RGBA=({r},{g},{b},{a})")
else:
    print("\n>>> No semi-transparent palette entries (all alpha=0 or 255)")

# Check alpha=0 entries that ARE used in frames
print("\nPalette entries with alpha=0:")
for i in range(cc):
    po = ps + i * 4
    b, g, r, a = d[po], d[po + 1], d[po + 2], d[po + 3]
    if a == 0:
        print(f"  [{i:3d}] BGRA=({b},{g},{r},{a})")

os2 = ps + cc * 4
offs = [struct.unpack_from("<I", d, os2 + i * 4)[0] for i in range(fc)]
fds = os2 + fc * 4

print(f"\nScanning ALL frames for used palette indices...")
all_used = set()
last_frame_used = {}
for j in range(fc):
    ds = fds + offs[j]
    dl = struct.unpack_from("<I", d, ds)[0]
    fw = struct.unpack_from("<I", d, ds + 4)[0]
    fh = struct.unpack_from("<I", d, ds + 8)[0]
    rs = ds + 20
    re = ds + dl
    pos = rs
    frame_idxs = set()
    while pos < re:
        b = d[pos]; pos += 1
        if b > 0x80:
            pass
        else:
            for _ in range(b):
                if pos < re:
                    idx = d[pos]; pos += 1
                    all_used.add(idx)
                    frame_idxs.add(idx)
    last_frame_used[j] = frame_idxs

# Show last 5 frames with their used palette
for j in range(max(0, fc - 5), fc):
    ds = fds + offs[j]
    dl = struct.unpack_from("<I", d, ds)[0]
    fw = struct.unpack_from("<I", d, ds + 4)[0]
    fh = struct.unpack_from("<I", d, ds + 8)[0]
    used = last_frame_used[j]
    print(f"\nFrame[{j}]: {fw}x{fh} datalen={dl}")
    for idx in sorted(used)[:16]:
        po = ps + idx * 4
        b2, g2, r2, a2 = d[po], d[po + 1], d[po + 2], d[po + 3]
        print(f"  palette[{idx:3d}] file_BGRA=({b2},{g2},{r2},{a2}) -> RGBA=({r2},{g2},{b2},{a2})")

# Alpha=0 palette entries that are used in pixel runs (not skip!)
used_zero_alpha = [i for i in all_used if d[ps+i*4+3] == 0]
if used_zero_alpha:
    print(f"\n>>> CRITICAL: {len(used_zero_alpha)} palette entries with alpha=0 are used as COLOR pixels:")
    for idx in used_zero_alpha:
        po = ps + idx * 4
        b2, g2, r2, a2 = d[po], d[po + 1], d[po + 2], d[po + 3]
        print(f"  [{idx:3d}] BGRA=({b2},{g2},{r2},{a2})")
