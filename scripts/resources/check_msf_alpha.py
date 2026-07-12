#!/usr/bin/env python3
import struct, sys

path = sys.argv[1] if len(sys.argv) > 1 else "resources-sword2-new/asf/magic/白虹贯日.msf"
d = open(path, "rb").read()
print(f"file: {path}  size: {len(d)} bytes")
version = struct.unpack_from("<H", d, 4)[0]
flags   = struct.unpack_from("<H", d, 6)[0]
cw      = struct.unpack_from("<H", d, 8)[0]
ch      = struct.unpack_from("<H", d, 10)[0]
fc      = struct.unpack_from("<H", d, 12)[0]
pf      = d[24]
pal_sz  = struct.unpack_from("<H", d, 25)[0]
pf_name = {0: "Rgba8", 1: "Indexed8", 2: "Indexed8Alpha8"}.get(pf, f"?{pf}")
print(f"v={version} flags={flags:#x} canvas={cw}x{ch} frames={fc} pf={pf_name} pal={pal_sz}")
pal_start = 28
palette = [(d[pal_start+i*4],d[pal_start+i*4+1],d[pal_start+i*4+2],d[pal_start+i*4+3]) for i in range(pal_sz)]
ft_start = pal_start + pal_sz * 4
frames = []
for i in range(fc):
    fo = ft_start + i * 16
    ox,oy = struct.unpack_from("<hh",d,fo)
    fw,fh = struct.unpack_from("<HH",d,fo+4)
    do,dl = struct.unpack_from("<II",d,fo+8)
    frames.append((ox,oy,fw,fh,do,dl))
ext_off = ft_start + fc * 16
while ext_off + 8 <= len(d):
    cid = d[ext_off:ext_off+4]
    cl = struct.unpack_from("<I",d,ext_off+4)[0]
    ext_off += 8
    if cid == b"END\x00": break
    ext_off += cl
blob_raw = d[ext_off:]
if flags & 1:
    try:
        import zstd; blob = bytes(zstd.decompress(blob_raw))
        print(f"zstd: {len(blob_raw)} -> {len(blob)} bytes")
    except ImportError:
        print("need: pip install zstd"); sys.exit(1)
else:
    blob = blob_raw
for i,(ox,oy,fw,fh,do,dl) in enumerate(frames):
    raw = blob[do:do+dl]
    if pf == 0:
        if len(raw) < fw*fh*4: print(f"Frame[{i}]: too short"); continue
        ua = sorted(set(raw[j*4+3] for j in range(fw*fh)))
        semi = sum(1 for j in range(fw*fh) if 0 < raw[j*4+3] < 255)
        op   = sum(1 for j in range(fw*fh) if raw[j*4+3]==255)
        tr   = sum(1 for j in range(fw*fh) if raw[j*4+3]==0)
        ok = " *** SEMI-TRANSPARENT OK ***" if semi > 0 else ""
        print(f"Frame[{i}]: {fw}x{fh} alpha={ua[:15]} semi={semi} opaque={op} transp={tr}{ok}")
    elif pf == 1:
        ui = sorted(set(raw[:fw*fh]))
        print(f"Frame[{i}]: {fw}x{fh} palette_indices={ui[:20]}")
