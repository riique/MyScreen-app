import { describe, expect, it } from "vitest";
import { contentRect, contains, toNormalized, toPhysical } from "@shared/remote/geometry";
import { KEYMAP, isExtended, scancodeFor } from "@shared/remote/keymap";
import { chunkText } from "@/components/conference/remote/ControlToolbar";

describe("contentRect", () => {
  it("tarja horizontal (vídeo mais largo que o elemento)", () => {
    const r = contentRect(1000, 1000, 1920, 1080);
    expect(r.x).toBeCloseTo(0);
    expect(r.w).toBeCloseTo(1000);
    expect(r.y).toBeCloseTo(218.75);
    expect(r.h).toBeCloseTo(562.5);
  });
  it("tarja vertical", () => {
    expect(contentRect(2000, 1080, 1920, 1080)).toEqual({ x: 40, y: 0, w: 1920, h: 1080 });
  });
  it("sem vídeo ainda: retângulo vazio", () => {
    expect(contentRect(100, 100, 0, 0).w).toBe(0);
  });
});

describe("toNormalized", () => {
  const r = { x: 40, y: 0, w: 1920, h: 1080 };
  it("cantos exatos", () => {
    expect(toNormalized(40, 0, r)).toEqual([0, 0]);
    expect(toNormalized(1960, 1080, r)).toEqual([65535, 65535]);
  });
  it("clique na tarja não sai, a não ser preso à borda", () => {
    expect(toNormalized(10, 500, r)).toBeNull();
    expect(toNormalized(10, 2000, r, true)).toEqual([0, 65535]);
  });
});

describe("toPhysical", () => {
  it("0 e 65535 caem no primeiro e no último pixel", () => {
    const d = { x: 0, y: 0, w: 2560, h: 1440 };
    expect(toPhysical(0, 0, d)).toEqual([0, 0]);
    expect(toPhysical(65535, 65535, d)).toEqual([2559, 1439]);
  });
  it("monitor à esquerda do principal (origem negativa)", () => {
    const d = { x: -1920, y: -200, w: 1920, h: 1080 };
    expect(toPhysical(0, 0, d)).toEqual([-1920, -200]);
    expect(toPhysical(65535, 65535, d)).toEqual([-1, 879]);
  });
  it("4K a 200%: coordenadas em pixels físicos", () => {
    expect(toPhysical(32768, 32768, { x: 1920, y: 0, w: 3840, h: 2160 })).toEqual([1920 + 1920, 1080]);
  });
  it("contains é meio aberto", () => {
    const r = { x: 0, y: 0, w: 10, h: 10 };
    expect(contains(r, 0, 0)).toBe(true);
    expect(contains(r, 10, 5)).toBe(false);
  });
});

describe("keymap", () => {
  it("teclas comuns", () => {
    expect(scancodeFor("KeyA")).toBe(0x1e);
    expect(scancodeFor("Enter")).toBe(0x1c);
    expect(scancodeFor("Space")).toBe(0x39);
    expect(scancodeFor("constructor")).toBeNull();
    expect(scancodeFor("Fn")).toBeNull();
  });
  it("estendidas", () => {
    for (const code of ["ArrowLeft", "Delete", "Home", "ControlRight", "AltRight", "NumpadEnter", "MetaLeft", "ContextMenu"]) {
      expect(isExtended(scancodeFor(code)!), code).toBe(true);
    }
    expect(isExtended(scancodeFor("ControlLeft")!)).toBe(false);
  });
  it("ABNT2", () => {
    expect(scancodeFor("IntlRo")).toBe(0x73);
    expect(scancodeFor("NumpadComma")).toBe(0x7e);
    expect(scancodeFor("Semicolon")).toBe(0x27); // ç
  });
  it("sem scancode repetido", () => {
    const values = Object.values(KEYMAP);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("chunkText", () => {
  it("corta em pedaços de até 1 KiB sem partir caractere", () => {
    const chunks = chunkText("é".repeat(1000));
    expect(chunks.join("")).toBe("é".repeat(1000));
    for (const c of chunks) expect(new TextEncoder().encode(c).byteLength).toBeLessThanOrEqual(1024);
    expect(chunkText("")).toEqual([]);
  });
});
