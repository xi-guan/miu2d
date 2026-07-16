import { describe, expect, it } from "vitest";
import { splitDialogPages } from "../../src/script/api/system-api";

describe("splitDialogPages", () => {
  it("splits on <enter> case-insensitively, trims and drops empty pages", () => {
    expect(splitDialogPages("第一页<enter> 第二页 <Enter><ENTER>第三页")).toEqual([
      "第一页",
      "第二页",
      "第三页",
    ]);
  });

  it("returns single page unchanged", () => {
    expect(splitDialogPages("你好")).toEqual(["你好"]);
  });

  it("carries an open color across the page break", () => {
    expect(
      splitDialogPages("<color=Red>伍子胥财宝丢光，孙仲谋痛失江山；<enter>两个人结成伴当，猜一字。")
    ).toEqual([
      "<color=Red>伍子胥财宝丢光，孙仲谋痛失江山；",
      "<color=Red>两个人结成伴当，猜一字。",
    ]);
  });

  it("does not carry color after a Black/Default reset", () => {
    expect(splitDialogPages("<color=Red>红字<color=Black>黑字<enter>下一页")).toEqual([
      "<color=Red>红字<color=Black>黑字",
      "下一页",
    ]);
    expect(splitDialogPages("<color=Yellow>黄<color=Default>白<enter>下一页")).toEqual([
      "<color=Yellow>黄<color=Default>白",
      "下一页",
    ]);
  });

  it("keeps carrying across multiple pages until reset", () => {
    expect(splitDialogPages("<color=Red>一<enter>二<enter>三<color=Black><enter>四")).toEqual([
      "<color=Red>一",
      "<color=Red>二",
      "<color=Red>三<color=Black>",
      "四",
    ]);
  });

  it("uses the last color tag on a page as the carried state", () => {
    expect(splitDialogPages("<color=Red>红<color=Yellow>黄<enter>下一页")).toEqual([
      "<color=Red>红<color=Yellow>黄",
      "<color=Yellow>下一页",
    ]);
  });
});
