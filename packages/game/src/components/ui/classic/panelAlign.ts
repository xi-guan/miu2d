/**
 * 经典面板的屏幕锚点解析
 *
 * 月影一代把面板挂在屏幕中线上（equip/state 在左半, goods/magic 在右半），
 * 各组件各写各的公式；sword2 的 window.ini 则用 align=alltcorner 这类角锚点。
 * 有 align 就按角/边算，没有就原样退回组件自己的公式。
 */

import type { PanelAlign, PanelConfig } from "@miu2d/engine/gui/ui-settings";

interface Box {
  left: number;
  top: number;
}

/** align 的水平/垂直分量：l|c|r × t|c|b */
const AXES: Record<PanelAlign, [x: "l" | "c" | "r", y: "t" | "c" | "b"]> = {
  lt: ["l", "t"],
  rt: ["r", "t"],
  lb: ["l", "b"],
  rb: ["r", "b"],
  center: ["c", "c"],
  bc: ["c", "b"],
};

export function resolvePanelPosition(
  panel: PanelConfig,
  panelWidth: number,
  panelHeight: number,
  screenWidth: number,
  screenHeight: number,
  fallback: Box
): Box {
  const axes = panel.align ? AXES[panel.align] : undefined;
  if (!axes) return fallback;

  const [ax, ay] = axes;
  const left =
    ax === "l" ? 0 : ax === "r" ? screenWidth - panelWidth : (screenWidth - panelWidth) / 2;
  const top =
    ay === "t" ? 0 : ay === "b" ? screenHeight - panelHeight : (screenHeight - panelHeight) / 2;

  return { left: left + panel.leftAdjust, top: top + panel.topAdjust };
}
