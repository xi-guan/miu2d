# 交接文档 — sword2(剑侠情缘2) 上线进度

日期: 2026-06-19

## 一句话现状
sword2 的**资源已就绪**(`resources/sword2/`)、**game 行已建且 slug 已对齐**，但**库里的游戏数据(npc/magic/goods/scene)还是空的**，所以还不能真正玩。下一步卡在"如何把 ini 数据导入库"——这个源头还没找到。

## 三个游戏的命名映射(口语序号易混,务必先看这个)
```
原始目录                        真实游戏          resources 目录   状态
(无原始,已在库)                月影传说          resources/yuying  ✓ 完整可玩
games-raw/jxqy2-assets        sword2(剑侠情缘2)  resources/sword2  资源好,数据空
games-raw/xinjianxiaqingyuan  sword1(新剑侠情缘) (未转)            素材锁在.pak,打不开
```
注意: 目录历史命名错位过,以本表为准。

## 库现状 (postgres: docker miu2d-postgres, 端口5533:5432, 库 miu2d_db, postgres/postgres)
```
slug        name        npc  magic scene   说明
yuying      月影传说    256   54    68     ← 完整,可玩,是"标准答案"
sword2      剑侠情缘贰   0    0     0      ← 资源好但数据空壳(本次重点)
admin-game  Admin的游戏  0    0     0      ← seed兜底,保留勿删
user-game   User的游戏   0    0     0      ← seed兜底,保留勿删
```

## 本会话已完成
1. 厘清三游戏映射(见上表)
2. 确认 sword2 资源转换完成: 剑侠2无asf格式,2616个mpc→msf即100%; map 58→mmf
3. 整理资源到 `resources/sword2/`: 布局对齐引擎(asf/ + mpc/map/ + content/),含全部 2616 msf + 58 mmf + content媒体(music14/sound131/video21含webm)
   - 做法: 以原 sword2 目录为主体,从已转好的 jxqy2 副本 rsync 进 2616 个 .msf(抽样 shasum 同源校验通过)
4. 修大小写: `Content/` → `content/` (引擎代码 resource-paths.ts 用小写 content/music 等; Linux/S3 大小写敏感会404)
5. 删冗余 ~2.1G: 删 `resources/jxqy2/`(旧布局产物) + `resources/sword2/.git`(Upwinded克隆)
6. **game.slug: jxqy2 → sword2** (一条 UPDATE; 与资源目录对齐; 代码无硬编码jxqy2,gameMember/gameConfig走game_id外键不受影响)

## 关键技术事实(下个session别重复踩)
- 引擎按 `resources/<game.slug>/` 读资源 (`packages/server/src/routes/file.routes.ts:127`)
- 引擎期望布局 (`packages/engine/src/resource/resource-paths.ts`):
  ```
  map/*.mmf
  asf/{character,object,effect,magic}/*.msf   ← 精灵动画
  mpc/{map,character,object}/*.msf            ← map tile 在 mpc/map/
  ini/...  script/...
  content/{music,sound,ui,video}              ← 媒体(小写!)
  ```
- npcs 表结构: `(game_id, key) 唯一`; 列 key/name/kind/relation; 其余全进 `data jsonb`
  - 月影 npc 样例: key=ini文件名, name=中文名, kind=Fighter/Normal, relation=Friend/Enemy
  - data jsonb 含 life/mana/attack/bodyIni/deathScript/... + resources{walk,attack,...}{image,sound}
  - **注意**: 月影 data 里 resources.*.image/sound 全是 null → 资源绑定是导入后的另一步,不是ini直接给

## ★ ini→DB 数据导入 (已完成 2026-06-19)
sword2 已导入,库数据与月影同构、可玩。导入产物(全模块零失败):
```
magic 48  npc 176(+200 npcres)  obj 149(+140 objres)  goods 117  shop 34
player 2  level 3  talk 1  talkPortrait 1(头像116)  scene 58(NPC实例3316/OBJ781)
initialMap=沙漠之战 已设
```

### 月影当初怎么进库的(谜底)
- **不是 CLI 脚本,是前端 UI**: dashboard `ImportAllModal` 把整个 resources/<game> 文件夹拖进去,
  浏览器端 `parseResourcesFolder` 解析全部 ini → 逐模块调 tRPC `xxx.batchImportFromIni` 写库。
  所以 git 里找不到脚本。各 service(npc/magic/goods/scene...)的 `batchImportFromIni` 自含 ini 解析。

### 本次做法 (复用生产解析器,脱浏览器)
1. 把 `parseResourcesFolder`(+file-only helper) 从 `ImportAllModal.tsx` 抽到
   `packages/types/src/resource-import.ts`(可被 server 和 dashboard 共用,带 `ResourceFile`/
   `ParseResourcesOptions` 抽象;dashboard 改为从 @miu2d/types import,行为不变)。
2. 写 `packages/server/scripts/import-game-data.ts`: fs 遍历 resources/<slug> → File 垫片
   → 真实 parseResourcesFolder → 按 ImportAllModal 顺序逐模块调 server service。
   跑法: `cd packages/server && node_modules/.bin/tsx --tsconfig tsconfig.dev.json \
          scripts/import-game-data.ts sword2`  (可加 `--only npc,magic` / `--no-clear`)

### 关键坑 (下个游戏/重导必看)
- **ini 大小写**: sword2 ini 全小写(`name=`/`[init]`),但各 service parser 多为 PascalCase 敏感
  (`case "Name"` / `=== "Init"`)。直接喂会导入空壳。
  解法: 脚本 File 垫片的 text() 对 ini/npc/obj 做 key 规范化,词表
  `packages/server/scripts/canonical-keys.json`(月影 ini ∪ parser case 标签 派生 lower→Pascal,
  375 键);section 仅归一 Init/LevelN/Header。月影本身已 Pascal,规范化对其幂等。
  再生成词表的脚本逻辑见 git 提交说明。
- **存档目录差异**: sword2 场景 NPC/OBJ 存档在 `save/rpg0/`(剑侠存档槽),月影在 `ini/save/`。
  parseResourcesFolder 只扫 ini/save 与 save/game。脚本 `remapSaveDir()` 把 `save/<非game槽>/`
  重写为 `ini/save/` 喂入(只改导入路径,不动磁盘),否则地图无 NPC(scene.data.npc 全空)。
- **initialMap 必须手设**: gameConfig 的 initialMap/newGameScript 不在 parseResourcesFolder 产出里
  (UI 单独配的)。sword2 初始图来自 `save/rpg0/game.ini` 的 `[state] map=沙漠之战.map` → 设
  initialMap="沙漠之战"(=scene key=mmf 文件名去后缀)。空则引擎回退 "map002"→黑屏(见 memory newgame-flow)。

### 遗留小瑕疵
- player 重复: `player.ini` 与 `player0.ini` 同为主角(index 都=0)。因 sword2 同时有 Player.ini
  (剑侠标准)和 rpg0 存档 Player0.ini,parseResourcesFolder 的 `Player(\d*)` 当两角色。
  非阻塞(引擎按 playerKey="player.ini" 精确取)。如要干净可删 player0 那条或改解析去重。
- shop section 大小写(`[header]`/`[1]`)下游消费未深验;商店非可玩核心,34 条已入库。

### 验证现状
- 数据层全绿: `GET /game/sword2/api/config`(initialMap=沙漠之战) + `/api/data`(各模块计数对) +
  tile 路径 http=200。引擎能读数据、跑脚本、加载主角(满血)、放音乐。
- 浏览器实测: **新游戏能进(New game started)、主角/UI/音乐正常,但地图地面 tile 大面积黑屏**。
  (server :4100 + web :5274 dev;MinIO :9110 资源回退,postgres miu2d-postgres :5533)

## ★★ 黑屏排查 (两层根因均已定位; 第一层已修, 第二层未修)
新游戏进沙漠之战,主角/技能栏/音乐/脚本都正常,**唯独地图地面 tile 渲染不出来(黑)**,只有零星元素。
换图实测: 沙漠之战 + 临安城 都全黑 → **sword2 所有地图都黑, 不是某张图特有**, 是普遍问题。

### 已修复的一层 (确证有效)
- **mmf tile 名 GBK 乱码**: `map2mmf.rs` 的 `read_gbk_string` 强制 GBK 解码,但 sword2 的 .map
  已是 UTF-8(jxqy2-assets 源转过码) → tile 名被当 GBK 解成乱码(沙漠→娌欐紶)写进 mmf →
  引擎请求乱码路径 404。月影 .map 是 GBK 所以正常,差异在此(已实测: sword2 .map 31 UTF-8/27 ascii,
  月影 24 GBK)。
  修复: `packages/converter/src/bin/map2mmf.rs` read_gbk_string + `scripts/convert-sword2.py`
  step_map_tiles(第~2119行)都改"先试 UTF-8 再回退 GBK"(与同文件 Traps.ini 一致)。
  重编译 → 重跑 map2mmf(58 mmf,tile 名已正确 UTF-8) → step_map_tiles(复制 tile 到
  msf/map/<场景>/, 3382个) → 重导 scene 入库。tile 路径 curl 全 200。

### ★ 第二层 root cause (已定位, 未修): 地图 tile msf 像素全透明
**sword2 的地图 tile msf 解码出来 0% 非透明像素(全透明)** → 贴图加载成功、atlas 也建好,
但画上去是透明的 → 地面什么都看不到 → 黑。这才是修完贴图名乱码后仍黑的真因。

实测(WASM 解码器 `parse_msf_header` + `decode_msf_individual_frames`, Node 跑, 月影做基准):
```
yuying  tile (mpc/map/.../地面01.msf): canvas=64x160 dir=8 frames=30 nonTransp=100% ✓ 正常
sword2  tile (msf/map/沙漠之战/ground-沙漠.msf): canvas=8x100 dir=0 frames=66 nonTransp=0% ✗ 全透明
```
- 同一 WASM 解码器、同一函数,月影 tile 出满像素,sword2 tile 出 0 像素。头部也异常
  (sword2 canvas=8x100 dir=0 vs 月影 64x160 dir=8)。多个 sword2 tile 抽样都 0%。
- **根因 = mpc→msf 转换器(mpc2msf.rs)把 sword2 的地图 tile 转坏了**。sword2 源 mpc 的 magic
  是 `IMG `(195KB)。转换器对这个 mpc 子格式的像素/透明度处理有 bug,产出全透明 msf。
  注意: 这与第一层(贴图名乱码)是**两个独立的转换器 bug**,都在 sword2 资源转换链。
- 排坑记录(避免重走): sword2 **角色** msf 在 Node 里用 `decode_msf_individual_frames` 也测出 0%,
  但角色实际能渲染 —— 因为角色走 **ASF 解码路径**(`loadAsf`→`decode_asf_frames`),不是 tile 的
  MSF-as-MPC 路径(`loadMpc`→`decodeMsfAsMpc`→`decode_msf_individual_frames`)。别拿角色当反例。

### ★ 第二层下一步 (修复方向)
1) 定位 mpc2msf.rs 对 `IMG ` 格式 mpc 的解码/透明度处理 bug(为何产出全透明)。可对比月影 mpc
   (能转对)与 sword2 mpc(`IMG `)的格式差异。Rust 入口: `packages/converter/src/bin/mpc2msf.rs`
   的 `decode_mpc_rle_to_rgba`(~166行)、`convert_all.rs`。
2) 修好后需**重转 sword2 全部 2616 个 msf**(不只地图 tile,角色/物件可能也受影响——但角色走 asf
   解码看似正常,重点是 map tile)→ 重跑 map2mmf → step_map_tiles → 重导 scene。
- 注: sword2 的 tile 实际在 `mpc/map/<tile包名>/`(如 mpc/map/狂沙镇/),场景名≠tile包名
  (沙漠之战↔狂沙镇,从 .map offset 0x20 读)。step_map_tiles 已据此复制到 msf/map/<场景名>/。

### 遗留小问题(非黑屏关键)
- 404: `asf/ui/littlehead/主角.msf`/`南宫飞云.msf`(对话头像小图)。
- 404: `content/sound/行-00.xnb`/`.wav`(单个脚步音效)。
- map2mmf 的 `--traps` 参数没生效(仍找 save/game/Traps.ini,sword2 traps 在 save/rpg0/)→ 陷阱缺。
- step_map_tiles 检查时提到大写 `Content/`(引擎要小写 content/) — 需确认未破坏之前的小写修复。

## 遗留项2: sword1(新剑侠情缘)
- 素材锁在 8 个 .pak 里 (`games-raw/xinjianxiaqingyuan/data/*.pak`: asf.pak 312M 等)
- `scripts/unpack-pak.py` 解不了它: sword1 的 pak 格式与脚本假设不同
  (dump 显示无独立名表, offset 直指数据, 数据块前有4字节长度头)
- 用户决定: 找"不解pak的方法"(如GitHub现成已解包素材仓,类比sword2来自Upwinded/jxqy2-assets) — 未开始

## 注意事项
- postgres 容器本会话期间已 `docker start`,在运行
- 删除/覆盖前务必先验证目标内容(本会话曾因没查库就删 resources/jxqy2 导致slug断链,后用改slug修复)
