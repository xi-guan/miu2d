/**
 * 资源文件夹解析器
 *
 * 把一个 resources/<game> 目录树(已读成 DroppedFileEntry[])解析为
 * ParsedModuleData —— 各模块(武功/NPC/物体/物品/商店/玩家/等级/对话/头像/场景)
 * 的导入项,供 server 各 service 的 batchImportFromIni 直接消费。
 *
 * 与运行环境无关:只用 File 的 name/text()/arrayBuffer(),浏览器与 Node 通用。
 * 浏览器侧(ImportAllModal)与 Node 导入脚本共用本模块,保证解析行为一致。
 */

import {
  classifyScriptFile,
  parseIniContent,
  parseMapFileName,
  parseNpcEntries,
  parseObjEntries,
} from "./scene.js";
import type { SceneData } from "./scene.js";

// btoa 是 WHATWG 标准全局，浏览器与 Node 18+ 均实现；types 包 tsconfig 不含 DOM lib，故声明
declare function btoa(data: string): string;

// ============= 类型定义 =============

/** 每个模块解析出的文件数据 */
export interface ParsedModuleData {
  magic: {
    fileName: string;
    iniContent: string;
    attackFileContent?: string;
    userType?: "player" | "npc";
  }[];
  npc: {
    fileName: string;
    type: "npc" | "resource";
    iniContent?: string;
    npcResContent?: string;
  }[];
  obj: {
    fileName: string;
    type?: "obj" | "resource";
    iniContent?: string;
    objResContent?: string;
  }[];
  goods: { fileName: string; iniContent: string }[];
  shop: { fileName: string; iniContent: string }[];
  player: {
    fileName: string;
    iniContent: string;
    magicIniContent?: string;
    goodsIniContent?: string;
  }[];
  level: { fileName: string; userType: "player" | "npc"; iniContent: string }[];
  talk: string | null;
  talkPortrait: string | null;
  uiTheme: unknown;
  scene: ParsedScene[];
}

export interface ParsedScene {
  key: string;
  name: string;
  mapFileName: string;
  mmfBase64: string;
  data: SceneData;
  trapOverrides?: Record<string, string>;
}

/** 解析所需的最小文件抽象:浏览器 File 与 Node 垫片均满足 */
export interface ResourceFile {
  name: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DroppedFileEntry {
  relativePath: string;
  file: ResourceFile;
}

/** 解析选项 */
export interface ParseResourcesOptions {
  /**
   * UI 主题转换器。仅 dashboard 需要(把旧 ui_settings.ini 转紧凑 JSON 主题),
   * 不提供时 uiTheme 保持 null。types 包不依赖 dashboard 的转换实现。
   */
  convertUiTheme?: (iniText: string) => unknown;
}

// ============= 路径/编码工具 =============

/**
 * 规范化路径：剥离用户拖入的根文件夹名
 */
function normalize(path: string): string {
  let p = path.replace(/^\//, "");
  const firstSlash = p.indexOf("/");
  if (firstSlash > 0) {
    const rest = p.substring(firstSlash + 1);
    const secondDir = rest.split("/")[0]?.toLowerCase();
    const knownSubDirs = new Set([
      "map",
      "script",
      "save",
      "ini",
      "mpc",
      "asf",
      "content",
      "music",
      "sound",
    ]);
    if (knownSubDirs.has(secondDir)) {
      p = rest;
    }
  }
  return p;
}

async function fileToBase64(file: ResourceFile): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ============= 解析逻辑 =============

/** 从 npc ini 内容中解析 NpcIni 字段值 */
function parseNpcIniField(content: string): string | null {
  const match = content.match(/^\s*NpcIni\s*=\s*(.+?)\s*$/im);
  return match ? match[1].toLowerCase() : null;
}

/** 从 obj ini 内容中解析 ObjFile 字段值 */
function parseObjFileField(content: string): string | null {
  const match = content.match(/^\s*ObjFile\s*=\s*(.+?)\s*$/im);
  return match ? match[1].toLowerCase() : null;
}

/** 从 magic ini 查找 AttackFile 引用 */
function parseAttackFileField(content: string): string | null {
  const match = content.match(/^\s*AttackFile\s*=\s*(.+?)\s*$/im);
  return match ? match[1].trim() : null;
}

/** 检测武功类型：player 或 npc */
function detectMagicUserType(content: string, filePath: string): "player" | "npc" {
  if (filePath.toLowerCase().includes("player")) return "player";
  if (/^\[Level\d+\]/im.test(content)) return "player";
  return "npc";
}

/**
 * 扫描所有脚本内容，提取 LoadMap + LoadNpc/LoadObj 调用链，
 * 返回 fileName.lower() → Set<sceneKey.lower()> 映射。
 *
 * 原理：脚本中调用 LoadMap("X.map") 后跟 LoadNpc("Y.npc") 或 LoadObj("Z.obj")，
 * 说明该文件应存入 X 这个 scene，而非文件 [Head] Map= 字段中的地图。
 */
function buildSaveFileScriptMapping(
  scriptContents: Array<{ scriptSceneKey: string; content: string }>
): Map<string, Set<string>> {
  const mapping = new Map<string, Set<string>>();
  const loadMapRe = /LoadMap\s*\(\s*"([^"]+\.map)"\s*\)/gi;
  const loadSaveRe = /Load(?:Npc|Obj)\s*\(\s*"([^"]+\.(?:npc|obj))"\s*\)/gi;

  for (const { scriptSceneKey, content } of scriptContents) {
    const tokens: Array<{ type: "map" | "save"; value: string; index: number }> = [];

    loadMapRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = loadMapRe.exec(content)) !== null) {
      tokens.push({
        type: "map",
        value: m[1].replace(/\.map$/i, "").toLowerCase(),
        index: m.index,
      });
    }
    loadSaveRe.lastIndex = 0;
    while ((m = loadSaveRe.exec(content)) !== null) {
      tokens.push({ type: "save", value: m[1].toLowerCase(), index: m.index });
    }

    tokens.sort((a, b) => a.index - b.index);

    // 默认 context = 脚本自身所属地图
    let currentMap = scriptSceneKey;
    for (const token of tokens) {
      if (token.type === "map") {
        currentMap = token.value;
      } else {
        if (!mapping.has(token.value)) mapping.set(token.value, new Set());
        mapping.get(token.value)!.add(currentMap);
      }
    }
  }

  return mapping;
}

/**
 * 解析 Traps.ini 内容
 */
function parseTrapsIni(content: string): Map<string, Map<number, string>> {
  const result = new Map<string, Map<number, string>>();
  let section: string | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      section = trimmed.slice(1, -1).toLowerCase();
      continue;
    }
    if (section) {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const idx = parseInt(trimmed.slice(0, eqIdx).trim(), 10);
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!Number.isNaN(idx)) {
          if (!result.has(section)) result.set(section, new Map());
          result.get(section)!.set(idx, val);
        }
      }
    }
  }
  return result;
}

/**
 * 解析整个 resources 文件夹，提取所有模块的数据
 */
export async function parseResourcesFolder(
  files: DroppedFileEntry[],
  onProgress: (text: string) => void,
  options: ParseResourcesOptions = {}
): Promise<ParsedModuleData> {
  const data: ParsedModuleData = {
    magic: [],
    npc: [],
    obj: [],
    goods: [],
    shop: [],
    player: [],
    level: [],
    talk: null,
    talkPortrait: null,
    uiTheme: null,
    scene: [],
  };

  // 按路径分类文件
  const byNorm = files.map((f) => ({
    ...f,
    norm: normalize(f.relativePath).toLowerCase(),
    normOrigCase: normalize(f.relativePath),
  }));

  onProgress("分类文件...");

  // ===== 1. 武功 (ini/magic/) =====
  const magicFiles = new Map<string, { file: ResourceFile; norm: string }>();
  for (const f of byNorm) {
    if (f.norm.startsWith("ini/magic/") && f.file.name.toLowerCase().endsWith(".ini")) {
      magicFiles.set(f.file.name.toLowerCase(), { file: f.file, norm: f.normOrigCase });
    }
  }

  if (magicFiles.size > 0) {
    onProgress(`解析武功... (${magicFiles.size} 个文件)`);
    // 读取所有内容
    const contentMap = new Map<string, string>();
    for (const [key, { file }] of magicFiles) {
      contentMap.set(key, await file.text());
    }
    // 识别 AttackFile 引用
    const attackFileKeys = new Set<string>();
    for (const [, content] of contentMap) {
      const ref = parseAttackFileField(content);
      if (ref) attackFileKeys.add(ref.toLowerCase());
    }
    // 构建导入项
    for (const [key, { norm }] of magicFiles) {
      const content = contentMap.get(key)!;
      const attackRef = parseAttackFileField(content);
      const attackContent = attackRef ? contentMap.get(attackRef.toLowerCase()) : undefined;
      // 跳过纯 AttackFile（被其他武功引用的飞行文件）
      if (attackFileKeys.has(key)) continue;
      data.magic.push({
        fileName: key,
        iniContent: content,
        attackFileContent: attackContent,
        userType: detectMagicUserType(content, norm),
      });
    }
  }

  // ===== 2. NPC (ini/npc/ + ini/npcres/) =====
  const npcFiles = new Map<string, { content: string; fileName: string }>();
  const npcResFiles = new Map<string, { content: string; fileName: string }>();

  for (const f of byNorm) {
    if (!f.file.name.toLowerCase().endsWith(".ini")) continue;
    if (f.norm.startsWith("ini/npcres/")) {
      const content = await f.file.text();
      npcResFiles.set(f.file.name.toLowerCase(), { content, fileName: f.file.name });
    } else if (f.norm.startsWith("ini/npc/")) {
      const content = await f.file.text();
      npcFiles.set(f.file.name.toLowerCase(), { content, fileName: f.file.name });
    }
  }

  if (npcFiles.size > 0 || npcResFiles.size > 0) {
    onProgress(`解析 NPC... (${npcFiles.size} NPC + ${npcResFiles.size} 资源)`);
    // NPC 文件 — 自动关联同名外观
    for (const [, info] of npcFiles) {
      const ref = parseNpcIniField(info.content);
      const resInfo = ref ? npcResFiles.get(ref) : null;
      data.npc.push({
        fileName: info.fileName,
        type: "npc",
        iniContent: info.content,
        npcResContent: resInfo?.content,
      });
    }
    // 所有 npcres 文件也作为独立资源导入
    for (const [, info] of npcResFiles) {
      data.npc.push({ fileName: info.fileName, type: "resource", npcResContent: info.content });
    }
  }

  // ===== 3. Object (ini/obj/ + ini/objres/) =====
  const objFiles = new Map<string, { content: string; fileName: string }>();
  const objResFiles = new Map<string, { content: string; fileName: string }>();

  for (const f of byNorm) {
    if (!f.file.name.toLowerCase().endsWith(".ini")) continue;
    if (f.norm.startsWith("ini/objres/")) {
      const content = await f.file.text();
      objResFiles.set(f.file.name.toLowerCase(), { content, fileName: f.file.name });
    } else if (f.norm.startsWith("ini/obj/")) {
      const content = await f.file.text();
      objFiles.set(f.file.name.toLowerCase(), { content, fileName: f.file.name });
    }
  }

  if (objFiles.size > 0 || objResFiles.size > 0) {
    onProgress(`解析 Object... (${objFiles.size} OBJ + ${objResFiles.size} 资源)`);
    const usedObjResKeys = new Set<string>();
    for (const [, info] of objFiles) {
      const ref = parseObjFileField(info.content);
      const resInfo = ref ? objResFiles.get(ref) : null;
      if (ref && resInfo) usedObjResKeys.add(ref);
      data.obj.push({
        fileName: info.fileName,
        iniContent: info.content,
        objResContent: resInfo?.content,
      });
    }
    // 添加独立的 objres 文件（没有被任何 obj 的 ObjFile= 引用的）
    for (const [key, info] of objResFiles) {
      if (!usedObjResKeys.has(key)) {
        data.obj.push({ fileName: info.fileName, type: "resource", objResContent: info.content });
      }
    }
  }

  // ===== 4. 物品 (ini/goods/) =====
  for (const f of byNorm) {
    if (f.norm.startsWith("ini/goods/") && f.file.name.toLowerCase().endsWith(".ini")) {
      const content = await f.file.text();
      data.goods.push({ fileName: f.file.name, iniContent: content });
    }
  }
  if (data.goods.length > 0) {
    onProgress(`解析物品... (${data.goods.length} 个文件)`);
  }

  // ===== 5. 商店 (ini/buy/) =====
  for (const f of byNorm) {
    if (f.norm.startsWith("ini/buy/") && f.file.name.toLowerCase().endsWith(".ini")) {
      const content = await f.file.text();
      data.shop.push({ fileName: f.file.name, iniContent: content });
    }
  }
  if (data.shop.length > 0) {
    onProgress(`解析商店... (${data.shop.length} 个文件)`);
  }

  // ===== 6. 玩家 (save/game/PlayerX.ini + MagicX.ini + GoodsX.ini 或 ini/save/) =====
  // 优先级：ini/save/ > save/game/
  // ini/save/ 存储的是设计时初始数据（如 Level=3），save/game/ 是运行时存档状态（如 Level=20）
  // 导入时应以设计时数据为准，save/game/ 仅作为回退
  type PlayerSrc = "ini/save" | "save/game";
  const playerMap = new Map<
    number,
    {
      player?: string;
      playerSrc?: PlayerSrc;
      magic?: string;
      magicSrc?: PlayerSrc;
      goods?: string;
      goodsSrc?: PlayerSrc;
      fileName?: string;
    }
  >();

  for (const f of byNorm) {
    if (!f.file.name.toLowerCase().endsWith(".ini")) continue;
    const isIniSave = f.norm.startsWith("ini/save/");
    const isSaveGame = f.norm.startsWith("save/game/");
    if (!isIniSave && !isSaveGame) continue;
    const src: PlayerSrc = isIniSave ? "ini/save" : "save/game";

    const fileName = f.file.name;
    // \d* — number is optional: supports both Player.ini (sword2) and Player1.ini (xin)
    const playerMatch = fileName.match(/^Player(\d*)\.ini$/i);
    const magicMatch = fileName.match(/^Magic(\d*)\.ini$/i);
    const goodsMatch = fileName.match(/^Goods(\d*)\.ini$/i);

    if (playerMatch) {
      const idx = playerMatch[1] ? parseInt(playerMatch[1], 10) : 1;
      const existing = playerMap.get(idx) ?? {};
      // 已有来自 ini/save 的数据，则不被 save/game 覆盖
      if (!(existing.playerSrc === "ini/save" && src === "save/game")) {
        const content = await f.file.text();
        existing.player = content;
        existing.fileName = fileName;
        existing.playerSrc = src;
      }
      playerMap.set(idx, existing);
    } else if (magicMatch) {
      const idx = magicMatch[1] ? parseInt(magicMatch[1], 10) : 1;
      const existing = playerMap.get(idx) ?? {};
      if (!(existing.magicSrc === "ini/save" && src === "save/game")) {
        const content = await f.file.text();
        existing.magic = content;
        existing.magicSrc = src;
      }
      playerMap.set(idx, existing);
    } else if (goodsMatch) {
      const idx = goodsMatch[1] ? parseInt(goodsMatch[1], 10) : 1;
      const existing = playerMap.get(idx) ?? {};
      if (!(existing.goodsSrc === "ini/save" && src === "save/game")) {
        const content = await f.file.text();
        existing.goods = content;
        existing.goodsSrc = src;
      }
      playerMap.set(idx, existing);
    }
  }

  // 按玩家索引排序
  const sortedPlayerEntries = Array.from(playerMap.entries()).sort((a, b) => a[0] - b[0]);
  for (const [, entry] of sortedPlayerEntries) {
    if (entry.player && entry.fileName) {
      data.player.push({
        fileName: entry.fileName,
        iniContent: entry.player,
        magicIniContent: entry.magic,
        goodsIniContent: entry.goods,
      });
    }
  }
  if (data.player.length > 0) {
    onProgress(`解析玩家... (${data.player.length} 个角色)`);
  }

  // ===== 7. 等级配置 =====
  // 先从 ini/level/ 读取，回退到 save/game/ 中的 Level-*.ini 或其他目录
  for (const f of byNorm) {
    if (!f.file.name.toLowerCase().endsWith(".ini")) continue;
    const isLevel =
      f.norm.startsWith("ini/level/") ||
      (f.norm.startsWith("save/game/") && f.file.name.toLowerCase().includes("level"));
    if (!isLevel) continue;
    // 跳过 MagicExp.ini
    if (f.file.name.toLowerCase().includes("magicexp")) continue;

    const content = await f.file.text();
    const isNpc = f.file.name.toLowerCase().includes("npc");
    data.level.push({
      fileName: f.file.name,
      userType: isNpc ? "npc" : "player",
      iniContent: content,
    });
  }
  if (data.level.length > 0) {
    onProgress(`解析等级配置... (${data.level.length} 个文件)`);
  }

  // ===== 8. 对话 TalkIndex.txt =====
  for (const f of byNorm) {
    if (f.norm === "content/talkindex.txt" || f.file.name.toLowerCase() === "talkindex.txt") {
      data.talk = await f.file.text();
      onProgress("找到对话数据 TalkIndex.txt");
      break;
    }
  }

  // ===== 9. 头像映射 HeadFile.ini =====
  for (const f of byNorm) {
    if (f.norm === "ini/ui/dialog/headfile.ini" || f.file.name.toLowerCase() === "headfile.ini") {
      data.talkPortrait = await f.file.text();
      onProgress("找到头像映射 HeadFile.ini");
      break;
    }
  }

  // ===== 9b. UI 配置 content/ui/ui_settings.ini =====
  if (options.convertUiTheme) {
    for (const f of byNorm) {
      if (f.norm === "content/ui/ui_settings.ini") {
        const iniText = await f.file.text();
        try {
          data.uiTheme = options.convertUiTheme(iniText);
          onProgress("找到 UI 配置 ui_settings.ini（已转换为紧凑 JSON 主题）");
        } catch {
          onProgress("找到 UI 配置 ui_settings.ini（JSON 转换失败）");
        }
        break;
      }
    }
  }

  // ===== 10. 场景 (map/*.mmf + script/map/ + save/game/*.npc/*.obj + Traps.ini) =====
  // 先读取 Traps.ini
  let allTraps = new Map<string, Map<number, string>>();
  const trapsFile = byNorm.find(
    (f) => f.norm === "save/game/traps.ini" || f.norm === "ini/save/traps.ini"
  );
  if (trapsFile) {
    const content = await trapsFile.file.text();
    allTraps = parseTrapsIni(content);
  }

  const sceneMap = new Map<string, ParsedScene>();

  // MMF 文件
  const mmfFiles = byNorm.filter(
    (f) => f.norm.startsWith("map/") && f.file.name.toLowerCase().endsWith(".mmf")
  );

  for (const mmfFile of mmfFiles) {
    const { key, name } = parseMapFileName(mmfFile.file.name);
    const mmfBase64 = await fileToBase64(mmfFile.file);

    const trapsForScene = allTraps.get(key.toLowerCase());
    const trapOverrides: Record<string, string> | undefined =
      trapsForScene && trapsForScene.size > 0
        ? Object.fromEntries(
            Array.from(trapsForScene.entries()).map(([idx, path]) => [String(idx), path])
          )
        : undefined;

    sceneMap.set(key.toLowerCase(), {
      key,
      name,
      mapFileName: mmfFile.file.name,
      mmfBase64,
      data: {},
      trapOverrides,
    });
  }

  // 脚本文件
  const scriptFiles = byNorm.filter(
    (f) => f.norm.startsWith("script/map/") && f.file.name.toLowerCase().endsWith(".txt")
  );
  // 收集脚本内容用于 NPC/OBJ 跨场景映射分析
  const allScriptContents: Array<{ scriptSceneKey: string; content: string }> = [];
  for (const sf of scriptFiles) {
    const parts = sf.normOrigCase.split("/");
    if (parts.length < 4) continue;
    const sceneKey = parts[2].toLowerCase();
    const fileName = parts[parts.length - 1];
    const content = await sf.file.text();
    allScriptContents.push({ scriptSceneKey: sceneKey, content });
    const scene = sceneMap.get(sceneKey);
    if (!scene) continue;
    // A file is a trap if its name matches Trap\d+ OR if it appears as a value
    // in this scene's trapOverrides (referenced by Traps.ini / MMF trapTable).
    // Sword2 trap scripts often have arbitrary names like "地图切换.txt".
    const trapOverrideKey =
      scene.trapOverrides != null
        ? Object.values(scene.trapOverrides).find((v) => v.toLowerCase() === fileName.toLowerCase())
        : undefined;
    const isTrapFile = classifyScriptFile(fileName) === "trap" || trapOverrideKey != null;
    if (isTrapFile) {
      if (!scene.data.traps) scene.data.traps = {};
      // Use the canonical name from trapOverrides (matches MMF), fallback to fileName
      scene.data.traps[trapOverrideKey ?? fileName] = content;
    } else {
      if (!scene.data.scripts) scene.data.scripts = {};
      scene.data.scripts[fileName] = content;
    }
  }

  // NPC/OBJ 存档文件
  // 引擎只从 ini/save/ 读取设计时数据，save/game/ 是运行时存档状态。
  // 优先使用 ini/save/ 的文件；仅当 ini/save/ 中不存在时才回退到 save/game/。
  const saveFiles = byNorm.filter((f) => {
    const inSaveDir = f.norm.startsWith("save/game/") || f.norm.startsWith("ini/save/");
    return (
      inSaveDir &&
      (f.file.name.toLowerCase().endsWith(".npc") || f.file.name.toLowerCase().endsWith(".obj"))
    );
  });

  // 从脚本中分析 LoadMap + LoadNpc/LoadObj 调用链，确定 NPC/OBJ 文件应存入哪个 scene
  // 例如：脚本中 LoadMap("凤池山庄.map") 后调用 LoadNpc("Fengci1.npc")，
  // 则 Fengci1.npc 应存入 凤池山庄 scene，而非 [Head] Map= 字段中的地图
  const saveFileScriptMapping = buildSaveFileScriptMapping(allScriptContents);

  const saveFileSourceMap = new Map<string, "ini/save" | "save/game">();

  for (const sf of saveFiles) {
    const fromIniSave = /^ini\/save\//i.test(sf.norm);
    const content = await sf.file.text();
    const sections = parseIniContent(content);
    const fileName = sf.file.name;
    const fileNameLower = fileName.toLowerCase();

    // 优先使用脚本分析得到的 scene key 集合；无匹配时回退到 [Head] Map= 字段
    const scriptSceneKeys =
      fileNameLower.endsWith(".npc") || fileNameLower.endsWith(".obj")
        ? saveFileScriptMapping.get(fileNameLower)
        : undefined;

    let targetSceneKeys: string[];
    if (scriptSceneKeys && scriptSceneKeys.size > 0) {
      targetSceneKeys = Array.from(scriptSceneKeys);
    } else {
      const headSection = sections.Head || sections.head;
      if (!headSection) continue;
      const mapValue = headSection.Map || headSection.map;
      if (!mapValue) continue;
      targetSceneKeys = [mapValue.replace(/\.(map|mmf)$/i, "").toLowerCase()];
    }

    for (const mapKey of targetSceneKeys) {
      const scene = sceneMap.get(mapKey);
      if (!scene) continue;

      const dedupeKey = `${mapKey}::${fileNameLower}`;
      const prevSource = saveFileSourceMap.get(dedupeKey);

      // 如果已有 ini/save 版本，跳过 save/game 的同名文件
      if (prevSource === "ini/save" && !fromIniSave) continue;
      saveFileSourceMap.set(dedupeKey, fromIniSave ? "ini/save" : "save/game");

      if (fileNameLower.endsWith(".npc")) {
        const entries = parseNpcEntries(sections);
        if (!scene.data.npc) scene.data.npc = {};
        const npcKey = fileNameLower;
        scene.data.npc[npcKey] = { key: npcKey, entries };
      } else if (fileNameLower.endsWith(".obj")) {
        const entries = parseObjEntries(sections);
        if (!scene.data.obj) scene.data.obj = {};
        const objKey = fileNameLower;
        scene.data.obj[objKey] = { key: objKey, entries };
      }
    }
  }

  data.scene = Array.from(sceneMap.values());
  if (data.scene.length > 0) {
    onProgress(`解析场景... (${data.scene.length} 个地图)`);
  }

  onProgress("解析完成");
  return data;
}
