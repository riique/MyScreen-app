import { describe, expect, it } from "vitest";
import { bestGridTile, bestSplitColumns, hwndFromSourceId, screenBitrate } from "@shared/media";

describe("screenBitrate", () => {
  it("segue o orçamento do site", () => {
    expect(screenBitrate("720p", 30)).toBe(3_500_000);
    expect(screenBitrate("1080p", 60)).toBe(9_000_000);
    expect(screenBitrate("1440p", 30)).toBe(9_000_000);
    expect(screenBitrate("1440p", 60)).toBe(13_500_000);
  });
});

describe("bestGridTile", () => {
  it("um participante ocupa o palco 16:9", () => {
    const t = bestGridTile(1, 1600, 900);
    expect(t.cols).toBe(1);
    expect(Math.round(t.w)).toBe(1600);
  });
  it("quatro num palco 16:9 viram 2×2", () => {
    expect(bestGridTile(4, 1600, 900).cols).toBe(2);
  });
  it("dois num palco muito largo ficam lado a lado", () => {
    expect(bestGridTile(2, 2000, 500).cols).toBe(2);
  });
});

describe("bestSplitColumns", () => {
  it("duas telas: lado a lado no largo, empilhadas no estreito", () => {
    expect(bestSplitColumns(2, 2400, 800)).toBe(2);
    expect(bestSplitColumns(2, 800, 1400)).toBe(1);
  });
});

describe("hwndFromSourceId", () => {
  it("extrai o HWND de janelas e ignora telas", () => {
    expect(hwndFromSourceId("window:197346:0")).toBe(197346n);
    expect(hwndFromSourceId("screen:0:0")).toBeNull();
    expect(hwndFromSourceId("window:abc:0")).toBeNull();
  });
});
