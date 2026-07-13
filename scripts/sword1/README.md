# sword1 (新剑侠情缘) 素材提取

原始素材锁在 `games-raw/xinjianxiaqingyuan/data/*.pak`。格式 (对照 GitHub `Upwinded/JXQY-all-in-one`
的 `src/File/PakFile.cpp`, 与本地 pak 逐字节吻合):

```
header    "PACKAGE\0" + fileCount(u32) + compressType(u32, 本地=2)
index     (fileId, offset, 解压后大小) x N, 按 fileId 升序, 无名表
fileId    文件名 hash (小写化, / → \, GBK 字节按 signed char 参与运算)
data      按 64KB 分块; blockCount 个 u16 压缩长 (0=未压缩), 块用 LZO1X 压缩
```

**index 只存 hash, 不存文件名** — 只能拿候选名正向 hash 对撞恢复。

## 复现步骤

```sh
cargo build --release --manifest-path packages/converter/Cargo.toml

# 1. 无名解包 (产物落 _unnamed/<pak>/<hash>.<ext>), 供第 2 步扫描引用
for p in ini script map; do
  ./packages/converter/target/release/unpack-pak \
    games-raw/xinjianxiaqingyuan/data/$p.pak /tmp/sword1-raw
done

# 2. 候选名对撞 (已产出 names-*.txt, 一般无需重跑)
python3 scripts/sword1/harvest_names.py

# 3. 带名解包
for p in asf font img ini map mpc script sound; do
  ./packages/converter/target/release/unpack-pak \
    games-raw/xinjianxiaqingyuan/data/$p.pak resources/sword1 \
    --names scripts/sword1/names-$p.txt
done

# 4. 转换 (ASF/MPC→MSF, MAP→MMF, GBK→UTF-8)
./packages/converter/target/release/convert-all resources/sword1
```

## 名称恢复率

```
asf     1733/1798  96%
script   914/977   93%
map      214/221   96%
ini     1636/2015  81%
sound    154/229   67%
mpc      928/1487  62%   ← 剩余多为地图 tile, 编号规律待补
font       5/7
img        0/8           ← 8 个 JPEG, 引用方未知
```

未命中的落 `_unnamed/<pak>/<hash>.<ext>`, 数据不丢, 只是路径不可被引用。

`brute-hash` 用于反推未知的路径形状 (已用它确定 tile 路径是 `mpc\map\<地图名>\<序号>.mpc`):

```sh
./packages/converter/target/release/brute-hash games-raw/xinjianxiaqingyuan/data/mpc.pak \
  --head 'mpc\map\map063_华山派大厅\' --tail '.mpc' --maxlen 4
```

固定的部分越多越好 — 中段每多一位, 假阳性率涨 42 倍。

## 踩过的坑

- **hash 必须 32-bit 回绕**: C++ 里 `u*(cnt+1)+result` 先在 u32 溢出回绕, 再取模 `0x8000000B`。
  Python 用大整数直接算会得到不同的 hash, 全盘对不上。
- **GBK 高字节走 signed char**: `ch[i]` 是 `char`, 高位字节符号扩展成巨大的 u32。
- **候选名必须按 pak 根目录过滤**: 生成的候选量大 (~270 万), 不过滤会有跨 pak 的 hash 假阳性。
- **`save/game/traps.ini` 是 PACK 压缩的存档残留, 不是 INI**。转换器要的完整 trap 表在
  `ini/save/traps.ini`, 需复制到 `save/game/Traps.ini` 才能烘进 mmf。
- **`save/rpg0/` 出厂是空的**, 而 `NewGame.txt` 走 `LoadGame(0)`。初始存档在 `ini/save/`
  (game.ini / player0.ini / goods0.ini / Magic0.ini / traps.ini ...), 需按 yueying 的大小写
  拷进 `save/rpg0/`。
