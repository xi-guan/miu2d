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

# 3b. tile 名藏在 .map 里 (见「踩过的坑」), 要等 map.pak 落地后才读得到 →
#     再跑一遍 harvest 补全 names-mpc.txt, 然后重解 mpc.pak
python3 scripts/sword1/harvest_names.py
./packages/converter/target/release/unpack-pak \
  games-raw/xinjianxiaqingyuan/data/mpc.pak resources/sword1 \
  --names scripts/sword1/names-mpc.txt

# 4. 转换 (ASF/MPC→MSF, MAP→MMF, GBK→UTF-8)
./packages/converter/target/release/convert-all resources/sword1

# 5. 变体图目录别名 (见「踩过的坑」末条: -1 变体图的 tile 存在基础图目录下)
ln -s map113_五剑堂正厅 resources/sword1/mpc/map/map113_五剑堂正厅-1
ln -s map120-1 resources/sword1/mpc/map/map120-1_风波亭
```

## 名称恢复率

```
asf     1733/1798  96%
script   917/977   94%
map      214/221   96%
ini     1641/2015  81%
sound    154/229   67%
mpc     1361/1487  91%
font       5/7
img        0/8           ← 8 个 JPEG, 引用方未知
```

## 验证:引用完整性

恢复率是错的验收指标(缺的那几个恰是被引用的)。改用引用完整性核对:

```sh
node scripts/check-game-refs.ts sword1   # 遍历每处引用, 按引擎规则解析; exit 1 = 有可恢复的断裂
```

它枚举 tile / DeathScript / ScriptFile / NpcIni / AddGoods / LoadMap 等全部引用, 逐个解析,
把断裂项分成「可恢复(名字在 pak, 补名即可)」与「原版固有缺口」。跨游戏通用(sword2/yueying
同一套逻辑, 各自的路径规则按需微调; 某类型解析率 ~0% 即该规则不适配, 非真 bug)。
黑块 / 令牌 / 本轮 5 个 npcres 都是它挖出来的。

未命中的落 `_unnamed/<pak>/<hash>.<ext>`, 数据不丢, 只是路径不可被引用。

tile 引用 1317 个, 尚缺 8 个 (0.6%), 涉 3 张图 — pak 里确实没有, 任何路径形状都不命中,
原始数据即缺:

```
map036_渔夫家 3    map071_朱仙镇 1    map077_岳飞主帐营 4
```

map113_五剑堂正厅-1 / map120-1_风波亭 曾各缺 10/6 个: blob 在基础图目录下
(`mpc\map\map113_五剑堂正厅\` 与 `mpc\map\map120-1\`), 而引擎按 .map 名拼
`msf/map/<图名>/` → 找不到。已用复现步骤第 5 步的目录别名解决 (2026-07-16)。

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
- **tile 名别猜, 它明写在 .map 里**: 每张 .map 的 mpc 表 (偏移 `192 + k*64`, 32 字节 GBK,
  NUL 结尾) 逐条列出该图用的 tile 文件名。名字是任意的 (`dt-1` `zz-3` `nnn` `t-33`),
  早期只按 `<序号>.mpc` 枚举, 34% 的 tile 引用从没被还原出名字 → blob 滞留 `_unnamed/` →
  引擎 404 → 地面全黑 (11 张整图全黑, 48 张有黑块)。`tile_names_from_maps()` 直接读该表,
  零假阳性。代价: 它依赖 map.pak 已解包, 所以 harvest 要跑两遍 (见复现步骤 3b)。
- **tile 目录名须与 .map 文件名逐字符一致 (含大小写)**: hash 先小写化, 故 `Map086_天山` 与
  `map086_天山` 都能命中索引, 但解包按名单原样建目录, 而引擎按 .map 名拼路径。
  macOS 大小写不敏感, 看不出问题; 换到大小写敏感的 FS 该图直接全黑。
- **脚本名同样别猜, 引用方白纸黑字写着**: .npc/.obj 的 `DeathScript=`/`ScriptFile=` 与脚本里
  `SetMapTrap()`/`RunScript()` 逐字给出被引用的脚本名。两个坑让通用 token 扫描漏掉它们:
  (a) 个别脚本是 `.ini` 扩展名却住在 `script\map\` 目录 (如 `吕文才与宋兵死亡.ini`);
  (b) 文件名含 `+` (如 `妓女+嫖客1对话.txt`), 被 TOKEN_RE 的字符类切断。漏掉的后果是
  运行时 DeathScript 404 → 剧情死结 (map027 赌坊打赢吕文才拿不到令牌, 卡在原地)。
  `script_names_from_refs()` 直接读引用, 按 `script\map\<地图>\` 补 .ini/.txt 两形状。
- **`save/game/traps.ini` 是 PACK 压缩的存档残留, 不是 INI**。转换器要的完整 trap 表在
  `ini/save/traps.ini`, 需复制到 `save/game/Traps.ini` 才能烘进 mmf。
- **`save/rpg0/` 出厂是空的**, 而 `NewGame.txt` 走 `LoadGame(0)`。初始存档在 `ini/save/`
  (game.ini / player0.ini / goods0.ini / Magic0.ini / traps.ini ...), 需按 yueying 的大小写
  拷进 `save/rpg0/`。
