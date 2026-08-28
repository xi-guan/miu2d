#!/usr/bin/env python3
"""Generate resources/yueying/content/ui/ui_settings.ini from yueying's ini/ui/ tree.

月影传说是月影世代的布局约定, 与 sword2 (老引擎) 是两套坐标系:
  - 绝对坐标, 640x480 设计画布, window.ini 无 align 字段
  - 面板图基本是 319/320 宽(正好半屏), 引擎的「贴中线」公式即由此反推

引擎渲染面板于其 MSF 原始尺寸, 用各自公式定位。本脚本把 window.ini 声明的
绝对 Left/Top 反解成引擎公式所需的 LeftAdjust/TopAdjust —— 读 MSF 头取真实
宽高代入, 无魔法常数。sword1 与 yueying 同代, 可复用本脚本(见 __main__)。

用法:
  python3 scripts/yueying/build-ui-settings.py <game-root>   # 默认 resources/yueying
"""
import os
import struct
import sys

CANVAS_W, CANVAS_H = 640, 480


def build_ui_settings(root: str) -> str:
    ui_base = os.path.join(root, "ini", "ui")

    def _rini(section: str, filename: str) -> dict:
        sec_dir = os.path.join(ui_base, section)
        if not os.path.isdir(sec_dir):
            sec_dir = os.path.join(ui_base, section.lower())
        path = ""
        if os.path.isdir(sec_dir):
            for f in os.listdir(sec_dir):
                if f.lower() == filename.lower():
                    path = os.path.join(sec_dir, f)
                    break
        if not path or not os.path.exists(path):
            return {}
        try:
            content = open(path, encoding="utf-8").read()
        except Exception:
            content = open(path, encoding="gbk", errors="replace").read()
        result: dict = {}
        in_section = ""
        items: dict = {}
        for line in content.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("//") or stripped.startswith(";"):
                continue
            if stripped.startswith("["):
                in_section = stripped[1:].rstrip("]").lower()
            elif "=" in stripped:
                k, _, v = stripped.partition("=")
                k, v = k.strip(), v.strip().rstrip(";")
                if in_section == "init":
                    result[k.lower()] = v
                elif in_section == "items":
                    items[k.strip()] = v.strip()
        if items:
            result["_items"] = items
        return result

    def _img(raw: str) -> str:
        if not raw:
            return ""
        p = raw.replace("\\", "/").lstrip("/")
        if p.lower().startswith("mpc/"):
            p = "asf/" + p[4:]
        base, ext = os.path.splitext(p)
        if ext.lower() in (".mpc", ".asf"):
            p = base + ".msf"
        return p.lower()

    def _snd(raw: str) -> str:
        return os.path.basename(raw.replace("\\", "/")) if raw else ""

    def _dims(img_rel: str) -> tuple[int, int]:
        """read MSF canvas w/h; 0,0 if absent."""
        if not img_rel:
            return 0, 0
        path = os.path.join(root, img_rel)
        if not os.path.exists(path):
            return 0, 0
        with open(path, "rb") as fh:
            head = fh.read(12)
        if len(head) < 12 or head[0:4] != b"MSF2":
            return 0, 0
        w, h = struct.unpack("<HH", head[8:12])
        return w, h

    def _panel_img(section: str, *filenames: str) -> str:
        """按序取各 ini 的 image=, 返回第一个磁盘存在的; 都不存在则返回第一个非空。

        月影底图在 Image01/Image.ini(Window.ini 空), sword1 各面板则自带
        window-<x>.msf 写在 Window.ini —— 以「文件是否存在」择路, 一套逻辑吃两代。
        """
        first = ""
        for fname in filenames:
            img = _img(_rini(section, fname).get("image", ""))
            if not img:
                continue
            if not first:
                first = img
            if os.path.exists(os.path.join(root, img)):
                return img
        return first

    lines: list[str] = []
    w = lines.append

    def _kv(k: str, v: str) -> None:
        if v != "" and v is not None:
            w(f"{k}={v}")

    def _adjust(win: dict, img_rel: str, family: str) -> tuple[int, int]:
        """反解 LeftAdjust/TopAdjust, 使引擎公式在 640x480 复现 window.ini 的绝对 Left/Top。

        family 对应各面板组件的定位公式:
          rightHalf  left = W/2 - panelW + LA   (state/equip/xiulian/npcequip/buysell)
          leftHalf   left = W/2 + LA            (goods/magic/memo)
          center     left = (W - panelW)/2 + LA (system)
          bottomBar  同 center, 但 top 贴屏底 → TA=0 (bottom/column/top)
          message    left 同 center; top = H - panelH + TA
          dialog     left 同 center; top = H + TA
        """
        try:
            left = int(win.get("left", "0") or "0")
            top = int(win.get("top", "0") or "0")
        except ValueError:
            left, top = 0, 0
        pw, ph = _dims(img_rel)
        if family == "rightHalf":
            la = left - (CANVAS_W // 2 - pw)
            ta = top
        elif family == "leftHalf":
            la = left - CANVAS_W // 2
            ta = top
        elif family in ("center", "bottomBar", "message", "dialog"):
            la = left - (CANVAS_W - pw) // 2
            if family == "bottomBar":
                ta = 0
            elif family == "message":
                ta = top - (CANVAS_H - ph)
            elif family == "dialog":
                ta = top - CANVAS_H
            else:
                ta = top
        else:
            la, ta = 0, 0
        return la, ta

    def _panel(section: str, win: dict, img_rel: str, family: str, anchor: str = "") -> None:
        la, ta = _adjust(win, img_rel, family)
        w(f"[{section}]")
        _kv("Image", img_rel)
        w(f"LeftAdjust={la}")
        w(f"TopAdjust={ta}")
        if anchor:
            w(f"Anchor={anchor}")

    # ── GoodsInit / MagicInit (index ranges — 月影与 sword2 同套) ──
    w("[GoodsInit]")
    w("GoodsListType=0")
    w("StoreIndexBegin=1")
    w("StoreIndexEnd=198")
    w("EquipIndexBegin=201")
    w("EquipIndexEnd=207")
    w("BottomIndexBegin=221")
    w("BottomIndexEnd=223")
    w("")
    w("[MagicInit]")
    w("StoreIndexBegin=1")
    w("StoreIndexEnd=36")
    w("BottomIndexBegin=40")
    w("BottomIndexEnd=44")
    w("XiuLianIndex=49")
    w("HideStartIndex=1000")
    w("")

    # ── Title ── (背景与画布同为 640x480, 无缩略图错位)
    tw = _rini("title", "Window.ini")
    ini_btn = _rini("title", "InitBtn.ini")
    title_bg = _img(ini_btn.get("bitmap", "")) or "asf/ui/title/title.jpg"
    # InitBtn.Bitmap 指向 title 背景图(.jpg 保持原样, 不转 .msf)
    raw_bmp = ini_btn.get("bitmap", "")
    if raw_bmp:
        title_bg = raw_bmp.replace("\\", "/").lstrip("/").lower()
    w("[Title]")
    _kv("BackgroundImage", title_bg)
    _kv("Width", tw.get("width", "640"))
    _kv("Height", tw.get("height", "480"))
    w("")

    for btn_file, key in [
        ("InitBtn.ini", "Title_Btn_Begin"),
        ("LoadBtn.ini", "Title_Btn_Load"),
        ("TeamBtn.ini", "Title_Btn_Team"),
        ("ExitBtn.ini", "Title_Btn_Exit"),
    ]:
        d = _rini("title", btn_file)
        if not d:
            continue
        w(f"[{key}]")
        _kv("Left", d.get("left", ""))
        _kv("Top", d.get("top", ""))
        _kv("Width", d.get("width", ""))
        _kv("Height", d.get("height", ""))
        _kv("Image", _img(d.get("image", "")))
        _kv("Sound", _snd(d.get("sound", "")))
        w("")

    # ── SaveLoad ──
    sw = _rini("saveload", "Window.ini")
    save_img = _img(sw.get("image", ""))
    _panel("SaveLoad", sw, save_img, "center")
    w("")

    snap = _rini("saveload", "SnapBmp.ini")
    w("[Save_Snapshot]")
    _kv("Left", snap.get("left", ""))
    _kv("Top", snap.get("top", ""))
    _kv("Width", snap.get("width", ""))
    _kv("Height", snap.get("height", ""))
    w("")

    lb = _rini("saveload", "ListBox.ini")
    items_d = lb.get("_items", {})
    items_text = "/".join(v for k, v in sorted(items_d.items()) if k.isdigit())
    w("[SaveLoad_Text_List]")
    _kv("Text", items_text)
    _kv("Left", lb.get("left", ""))
    _kv("Top", lb.get("top", ""))
    _kv("Width", lb.get("width", ""))
    _kv("Height", lb.get("height", ""))
    w("CharSpace=2")
    w("LineSpace=0")
    _kv("ItemHeight", lb.get("itemheight", ""))
    _kv("Color", lb.get("color", ""))
    _kv("SelectedColor", lb.get("selcolor", ""))
    _kv("Sound", _snd(lb.get("sound", "")))
    w("")

    for btn_file, key in [
        ("LoadBtn.ini", "SaveLoad_Load_Btn"),
        ("SaveBtn.ini", "SaveLoad_Save_Btn"),
        ("ExitBtn.ini", "SaveLoad_Exit_Btn"),
    ]:
        d = _rini("saveload", btn_file)
        if not d:
            continue
        w(f"[{key}]")
        _kv("Left", d.get("left", ""))
        _kv("Top", d.get("top", ""))
        _kv("Width", d.get("width", ""))
        _kv("Height", d.get("height", ""))
        _kv("Image", _img(d.get("image", "")))
        _kv("Sound", _snd(d.get("sound", "")))
        w("")

    st = _rini("saveload", "savetime.ini")
    w("[SaveLoad_Save_Time_Text]")
    _kv("Left", st.get("left", "272"))
    _kv("Top", st.get("top", "124"))
    _kv("Width", st.get("width", "350"))
    _kv("Height", st.get("height", "30"))
    w("CharSpace=1")
    w("LineSpace=0")
    _kv("Color", st.get("color", "136,12,2,178"))
    w("")
    w("[SaveLoad_Message_Line_Text]")
    w("Left=0")
    w("Top=440")
    w("Width=640")
    w("Height=40")
    w("Align=1")
    w("Color=255,215,0,204")
    w("")

    # ── System ──
    sysw = _rini("system", "Window.ini")
    _panel("System", sysw, _img(sysw.get("image", "")), "center")
    w("")

    for btn_file, key in [
        ("SaveLoad.ini", "System_SaveLoad_Btn"),
        ("Option.ini", "System_Option_Btn"),
        ("Quit.ini", "System_Exit_Btn"),
        ("Return.ini", "System_Return_Btn"),
    ]:
        d = _rini("system", btn_file)
        if not d:
            continue
        w(f"[{key}]")
        _kv("Left", d.get("left", ""))
        _kv("Top", d.get("top", ""))
        _kv("Width", d.get("width", ""))
        _kv("Height", d.get("height", ""))
        _kv("Image", _img(d.get("image", "")))
        _kv("Sound", _snd(d.get("sound", "")))
        w("")

    # ── BottomState (column / status bars) — 贴屏底左侧 ──
    cw = _rini("column", "Window.ini")
    col_img = _img(cw.get("image", ""))
    cpw, _ = _dims(col_img)
    cla, _ = _adjust(cw, col_img, "bottomBar")
    w("[BottomState]")
    _kv("Image", col_img)
    _kv("Width", str(cpw) if cpw else cw.get("width", ""))
    _kv("Height", cw.get("height", ""))
    w(f"LeftAdjust={cla}")
    w("TopAdjust=0")
    w("")

    for col_file, key in [
        ("ColLife.ini", "BottomState_Life"),
        ("ColThew.ini", "BottomState_Thew"),
        ("ColMana.ini", "BottomState_Mana"),
    ]:
        d = _rini("column", col_file)
        if not d:
            continue
        w(f"[{key}]")
        _kv("Left", d.get("left", ""))
        _kv("Top", d.get("top", ""))
        _kv("Width", d.get("width", ""))
        _kv("Height", d.get("height", ""))
        _kv("Image", _img(d.get("image", "")))
        w("")

    # ── Top (button bar — 月影在屏幕顶部, 独立 top/window.asf) ──
    topw = _rini("top", "Window.ini")
    top_img = _img(topw.get("image", ""))
    tla, _ = _adjust(topw, top_img, "center")
    w("[Top]")
    _kv("Image", top_img)
    w(f"LeftAdjust={tla}")
    _kv("TopAdjust", topw.get("top", "0"))
    w("")

    for btn_file, key in [
        ("BtnState.ini", "Top_State_Btn"),
        ("BtnEquip.ini", "Top_Equip_Btn"),
        ("BtnXiuLian.ini", "Top_XiuLian_Btn"),
        ("BtnGoods.ini", "Top_Goods_Btn"),
        ("BtnMagic.ini", "Top_Magic_Btn"),
        ("BtnNotes.ini", "Top_Memo_Btn"),
        ("BtnOption.ini", "Top_System_Btn"),
    ]:
        d = _rini("top", btn_file)
        if not d:
            continue
        w(f"[{key}]")
        _kv("Left", d.get("left", ""))
        _kv("Top", d.get("top", ""))
        _kv("Width", d.get("width", ""))
        _kv("Height", d.get("height", ""))
        _kv("Image", _img(d.get("image", "")))
        _kv("Sound", _snd(d.get("sound", "")))
        w("")

    # ── Bottom (quickbar) — 贴屏底 ──
    bw = _rini("bottom", "Window.ini")
    bot_img = _img(bw.get("image", ""))
    bla, _ = _adjust(bw, bot_img, "bottomBar")
    w("[Bottom]")
    _kv("Image", bot_img)
    w(f"LeftAdjust={bla}")
    w("TopAdjust=0")
    w("")

    w("[Bottom_Items]")
    for i in range(1, 9):
        d = _rini("bottom", f"Item{i}.ini")
        if not d:
            continue
        w(f"Item_Left_{i}={d.get('left', '')}")
        w(f"Item_Top_{i}={d.get('top', '')}")
        w(f"Item_Width_{i}={d.get('width', '')}")
        w(f"Item_Height_{i}={d.get('height', '')}")
    w("")

    # ── Dialog ──
    dw = _rini("dialog", "Window.ini")
    dlg_img = _img(dw.get("image", ""))
    _panel("Dialog", dw, dlg_img, "dialog")
    w("")

    dtxt = _rini("dialog", "Text.ini")
    w("[Dialog_Txt]")
    _kv("Left", dtxt.get("left", "80"))
    _kv("Top", dtxt.get("top", "15"))
    _kv("Width", dtxt.get("width", "400"))
    _kv("Height", dtxt.get("height", "60"))
    w("CharSpace=0")
    w("LineSpace=0")
    _kv("Color", dtxt.get("color", "255,255,255,204"))
    w("")

    sa = _rini("dialog", "SelectA.ini")
    w("[Dialog_SelA]")
    _kv("Left", sa.get("left", "90"))
    _kv("Top", sa.get("top", "30"))
    _kv("Width", sa.get("width", "380"))
    _kv("Height", sa.get("height", "20"))
    w("CharSpace=1")
    w("LineSpace=0")
    _kv("Color", sa.get("color", "0,0,255,204"))
    w("")

    sb = _rini("dialog", "SelectB.ini")
    w("[Dialog_SelB]")
    _kv("Left", sb.get("left", "90"))
    _kv("Top", sb.get("top", "52"))
    _kv("Width", sb.get("width", "380"))
    _kv("Height", sb.get("height", "20"))
    w("CharSpace=1")
    w("LineSpace=0")
    _kv("Color", sb.get("color", "0,0,255,204"))
    w("")

    dh = _rini("dialog", "Head.ini")
    w("[Dialog_Portrait]")
    _kv("Left", dh.get("left", "0"))
    w("Top=-200")
    _kv("Width", dh.get("width", "200"))
    _kv("Height", dh.get("height", "160"))
    w("")

    # ── State panel (月影底图在 Image01.ini; sword1 无独立图, 回退共享 panel5b) ──
    stw = _rini("state", "Window.ini")
    state_img = _panel_img("state", "Window.ini", "Image01.ini")
    _panel("State", stw, state_img, "rightHalf")
    w("")

    for ini_file, key in [
        ("Lab等级.ini", "State_Level"),
        ("lab经验.ini", "State_Exp"),
        ("lab升级.ini", "State_LevelUp"),
        ("Lab生命.ini", "State_Life"),
        ("lab体力.ini", "State_Thew"),
        ("Lab内力.ini", "State_Mana"),
        ("Lab攻击.ini", "State_Attack"),
        ("Lab防御.ini", "State_Defend"),
        ("Lab闪避.ini", "State_Evade"),
    ]:
        d = _rini("state", ini_file)
        if not d:
            continue
        w(f"[{key}]")
        _kv("Left", d.get("left", ""))
        _kv("Top", d.get("top", ""))
        _kv("Width", d.get("width", ""))
        _kv("Height", d.get("height", ""))
        w("CharSpace=0")
        w("LineSpace=0")
        _kv("Color", d.get("color", ""))
        w("")

    # ── Equip (月影用 Image01.ini; sword1 自带 window-equip.msf 在 Window.ini) ──
    ew = _rini("equip", "Window.ini")
    equip_img = _panel_img("equip", "Window.ini", "Image01.ini", "Image.ini")
    _panel("Equip", ew, equip_img, "rightHalf")
    w("")

    equip_slots = ["Equip_Head", "Equip_Neck", "Equip_Wrist",
                   "Equip_Body", "Equip_Hand", "Equip_Foot", "Equip_Back"]
    equip_data: list[dict] = []
    for i, slot in enumerate(equip_slots, 1):
        d = _rini("equip", f"Item{i}.ini")
        equip_data.append(d)
        if not d:
            continue
        w(f"[{slot}]")
        _kv("Left", d.get("left", ""))
        _kv("Top", d.get("top", ""))
        _kv("Width", d.get("width", ""))
        _kv("Height", d.get("height", ""))
        w("")

    # ── NpcEquip (复用 Equip 布局) ──
    _panel("NpcEquip", ew, equip_img, "rightHalf")
    w("")
    npc_slots = ["NpcEquip_Head", "NpcEquip_Neck", "NpcEquip_Wrist",
                 "NpcEquip_Body", "NpcEquip_Hand", "NpcEquip_Foot", "NpcEquip_Back"]
    for slot, d in zip(npc_slots, equip_data):
        if not d:
            continue
        w(f"[{slot}]")
        _kv("Left", d.get("left", ""))
        _kv("Top", d.get("top", ""))
        _kv("Width", d.get("width", ""))
        _kv("Height", d.get("height", ""))
        w("")

    # ── XiuLian (月影底图在 Image.ini; sword1 无独立图, 回退共享 panel6) ──
    xw = _rini("xiulian", "Window.ini")
    xiulian_img = _panel_img("xiulian", "Window.ini", "Image.ini")
    _panel("XiuLian", xw, xiulian_img, "rightHalf")
    w("")

    xm = _rini("xiulian", "Magic.ini")
    w("[XiuLian_Magic_Image]")
    _kv("Left", xm.get("left", "10"))
    _kv("Top", xm.get("top", "9"))
    _kv("Width", xm.get("width", "30"))
    _kv("Height", xm.get("height", "38"))
    w("")

    for src, key, defs in [
        ("Level.ini", "XiuLian_Level_Text", ("142", "52", "80", "12", "255,255,255")),
        ("Exp.ini", "XiuLian_Exp_Text", ("142", "79", "80", "12", "255,255,255")),
        ("Name.ini", "XiuLian_Name_Text", ("40", "106", "200", "20", "250,220,200")),
        ("Intro.ini", "XiuLian_Intro_Text", ("40", "133", "160", "120", "220,180,130")),
    ]:
        d = _rini("xiulian", src)
        w(f"[{key}]")
        _kv("Left", d.get("left", defs[0]))
        _kv("Top", d.get("top", defs[1]))
        _kv("Width", d.get("width", defs[2]))
        _kv("Height", d.get("height", defs[3]))
        w("CharSpace=0")
        w("LineSpace=0")
        _kv("Color", d.get("color", defs[4]))
        w("")

    # ── Goods ──
    gw = _rini("goods", "Window.ini")
    gsb = _rini("goods", "ScrollBar.ini")
    gslide = _rini("goods", "SlideBtn.ini")
    _panel("Goods", gw, _img(gw.get("image", "")), "leftHalf")
    _kv("ScrollBarLeft", gsb.get("left", "178"))
    _kv("ScrollBarRight", gsb.get("top", "40"))
    _kv("ScrollBarWidth", gsb.get("width", "28"))
    _kv("ScrollBarHeight", gsb.get("height", "180"))
    _kv("ScrollBarButton", _img(gslide.get("image", "")) or "asf/ui/goods/slidebtn.msf")
    w("")

    w("[Goods_List_Items]")
    for i in range(1, 10):
        d = _rini("goods", f"Item{i}.ini")
        if not d:
            continue
        w(f"Item_Left_{i}={d.get('left', '')}")
        w(f"Item_Top_{i}={d.get('top', '')}")
        w(f"Item_Width_{i}={d.get('width', '')}")
        w(f"Item_Height_{i}={d.get('height', '')}")
    w("")

    gm = _rini("goods", "money.ini")
    w("[Goods_Money]")
    _kv("Left", gm.get("left", "100"))
    _kv("Top", gm.get("top", "230"))
    _kv("Width", gm.get("width", "100"))
    _kv("Height", gm.get("height", "12"))
    _kv("Color", gm.get("color", "250,250,250"))
    w("")

    # ── Magics ──
    mw = _rini("magic", "Window.ini")
    msb = _rini("magic", "ScrollBar.ini")
    mslide = _rini("magic", "SlideBtn.ini")
    _panel("Magics", mw, _img(mw.get("image", "")), "leftHalf")
    _kv("ScrollBarLeft", msb.get("left", "178"))
    _kv("ScrollBarRight", msb.get("top", "40"))
    _kv("ScrollBarWidth", msb.get("width", "28"))
    _kv("ScrollBarHeight", msb.get("height", "180"))
    _kv("ScrollBarButton", _img(mslide.get("image", "")) or "asf/ui/goods/slidebtn.msf")
    w("")

    w("[Magics_List_Items]")
    for i in range(1, 10):
        d = _rini("magic", f"Item{i}.ini") or _rini("goods", f"Item{i}.ini")
        if not d:
            continue
        w(f"Item_Left_{i}={d.get('left', '')}")
        w(f"Item_Top_{i}={d.get('top', '')}")
        w(f"Item_Width_{i}={d.get('width', '')}")
        w(f"Item_Height_{i}={d.get('height', '')}")
    w("")

    # ── Memo ──
    memow = _rini("memo", "Window.ini")
    _panel("Memo", memow, _img(memow.get("image", "")), "leftHalf")
    w("")

    mt = _rini("memo", "memo.ini")
    w("[Memo_Text]")
    _kv("Left", mt.get("left", "12"))
    _kv("Top", mt.get("top", "18"))
    _kv("Width", mt.get("width", "132"))
    _kv("Height", mt.get("height", "160"))
    w("CharSpace=0")
    w("LineSpace=0")
    _kv("Color", mt.get("color", "250,200,150"))
    w("")

    memo_sb = _rini("memo", "ScrollBar.ini")
    memo_slide = _rini("memo", "SlideBtn.ini")
    w("[Memo_Slider]")
    _kv("Left", memo_sb.get("left", "158"))
    _kv("Top", memo_sb.get("top", "0"))
    _kv("Width", memo_slide.get("width", "18"))
    _kv("Height", memo_slide.get("height", "30"))
    _kv("Image_Btn", _img(memo_slide.get("image", "")) or "asf/ui/goods/slidebtn.msf")
    w("")

    # ── Message ──
    msgw = _rini("message", "Window.ini")
    _panel("Message", msgw, _img(msgw.get("image", "")), "message")
    w("")

    msgl = _rini("message", "Label.ini")
    w("[Message_Text]")
    _kv("Left", msgl.get("left", "30"))
    _kv("Top", msgl.get("top", "20"))
    _kv("Width", msgl.get("width", "220"))
    _kv("Height", msgl.get("height", "40"))
    _kv("Color", msgl.get("color", "241,241,241,204"))
    _kv("CharSpace", msgl.get("charspace", "0"))
    w("LineSpace=1")
    w("")

    # ── ToolTip (月影用 Type1: tipbox 图 + 分区文字) ──
    ttw = _rini("tooltip", "Window.ini")
    ttimg = _rini("tooltip", "Image.ini")
    ttname = _rini("tooltip", "Name.ini")
    ttcost = _rini("tooltip", "Cost.ini")
    tti1 = _rini("tooltip", "Intro1.ini")
    tti2 = _rini("tooltip", "Intro2.ini")
    w("[ToolTip_Use_Type]")
    w("UseType=1")
    w("")
    w("[ToolTip_Type1]")
    _kv("Image", _img(ttw.get("image", "")) or "asf/ui/common/tipbox.msf")
    _kv("ItemImage_Left", ttimg.get("left", "132"))
    _kv("ItemImage_Top", ttimg.get("top", "47"))
    _kv("ItemImage_Width", ttimg.get("width", "60"))
    _kv("ItemImage_Height", ttimg.get("height", "75"))
    _kv("Name_Left", ttname.get("left", "67"))
    _kv("Name_Top", ttname.get("top", "191"))
    _kv("Name_Width", ttname.get("width", "90"))
    _kv("Name_Height", ttname.get("height", "20"))
    _kv("Name_Color", ttname.get("color", "102,73,212"))
    _kv("PriceOrLevel_Left", ttcost.get("left", "160"))
    _kv("PriceOrLevel_Top", ttcost.get("top", "191"))
    _kv("PriceOrLevel_Width", ttcost.get("width", "88"))
    _kv("PriceOrLevel_Height", ttcost.get("height", "20"))
    _kv("PriceOrLevel_Color", ttcost.get("color", "91,31,27"))
    _kv("Effect_Left", tti1.get("left", "67"))
    _kv("Effect_Top", tti1.get("top", "210"))
    _kv("Effect_Width", tti1.get("width", "196"))
    _kv("Effect_Height", tti1.get("height", "40"))
    _kv("Effect_Color", tti1.get("color", "52,21,14"))
    _kv("Intro_Left", tti2.get("left", "67"))
    _kv("Intro_Top", tti2.get("top", "255"))
    _kv("Intro_Width", tti2.get("width", "196"))
    _kv("Intro_Height", tti2.get("height", "80"))
    _kv("Intro_Color", tti2.get("color", "52,21,14"))
    w("")

    # ── BuySell ──
    bsw = _rini("buysell", "Window.ini")
    bssb = _rini("buysell", "ScrollBar.ini")
    bsslide = _rini("buysell", "SlideBtn.ini")
    bsclose = _rini("buysell", "CloseBtn.ini")
    _panel("BuySell", bsw, _img(bsw.get("image", "")), "rightHalf")
    _kv("ScrollBarLeft", bssb.get("left", "178"))
    _kv("ScrollBarRight", bssb.get("top", "40"))
    _kv("ScrollBarWidth", bssb.get("width", "28"))
    _kv("ScrollBarHeight", bssb.get("height", "180"))
    _kv("ScrollBarButton", _img(bsslide.get("image", "")) or "asf/ui/goods/slidebtn.msf")
    _kv("CloseImage", _img(bsclose.get("image", "")))
    _kv("CloseSound", _snd(bsclose.get("sound", "")))
    _kv("CloseLeft", bsclose.get("left", "203"))
    _kv("CloseTop", bsclose.get("top", "225"))
    w("")

    w("[BuySell_List_Items]")
    for i in range(1, 10):
        d = _rini("buysell", f"Item{i}.ini")
        if not d:
            continue
        w(f"Item_Left_{i}={d.get('left', '')}")
        w(f"Item_Top_{i}={d.get('top', '')}")
        w(f"Item_Width_{i}={d.get('width', '')}")
        w(f"Item_Height_{i}={d.get('height', '')}")
    w("")

    # ── YesNo ──
    ynw = _rini("yesno", "Window.ini")
    _panel("YesNo", ynw, _img(ynw.get("image", "")), "center")
    w("")

    for btn, key in [("BtnYes.ini", "YesNo_Yes_Btn"), ("BtnNo.ini", "YesNo_No_Btn")]:
        d = _rini("yesno", btn)
        w(f"[{key}]")
        _kv("Left", d.get("left", ""))
        _kv("Top", d.get("top", ""))
        _kv("Width", d.get("width", ""))
        _kv("Height", d.get("height", ""))
        _kv("Image", _img(d.get("image", "")))
        w("")

    # ── NpcInfoShow / Mouse ──
    w("[NpcInfoShow]")
    w("Width=300")
    w("Height=25")
    w("LeftAdjust=0")
    w("TopAdjust=50")
    w("")

    w("[Mouse]")
    w("Image=asf/ui/common/mouse.msf")
    w("")

    return "\n".join(lines)


def main() -> None:
    root = sys.argv[1] if len(sys.argv) > 1 else "resources/yueying"
    out_dir = os.path.join(root, "content", "ui")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "ui_settings.ini")
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(build_ui_settings(root))
    print(f"✓ wrote {out_path}")


if __name__ == "__main__":
    main()
