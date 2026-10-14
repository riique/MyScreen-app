import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTURE, DEFAULT_SYSTEM_AUDIO, parseCapture, parseSystemAudio } from "@/components/capture/capturePrefs";
import { parseRecent } from "@/lib/storage";

describe("parseCapture", () => {
  it("valida campo a campo", () => {
    const ok = parseCapture(
      JSON.stringify({ resolution: "1440p", frameRate: "30", hideSelf: false, lastSourceId: "window:12:0" }),
    );
    expect(ok).toEqual({ resolution: "1440p", frameRate: "30", hideSelf: false, lastSourceId: "window:12:0" });
  });
  it("valor antigo ou fora do conjunto cai no padrão", () => {
    const v = parseCapture(JSON.stringify({ resolution: "4k", frameRate: "15", lastSourceId: "javascript:1" }));
    expect(v).toEqual({ ...DEFAULT_CAPTURE, lastSourceId: null });
    expect(parseCapture("lixo")).toBeNull();
    expect(parseCapture(null)).toBeNull();
  });
});

describe("parseSystemAudio", () => {
  it("limita o volume a 0–400", () => {
    expect(parseSystemAudio(JSON.stringify({ gainPct: 900 })).gainPct).toBe(100);
    expect(parseSystemAudio(JSON.stringify({ gainPct: 250, normalize: false })).normalize).toBe(false);
    expect(parseSystemAudio("{")).toEqual(DEFAULT_SYSTEM_AUDIO);
  });
});

describe("parseRecent", () => {
  it("guarda só id e título válidos, nunca senha", () => {
    const list = parseRecent(
      JSON.stringify([
        { id: "abc", title: "A", at: 1, password: "segredo" },
        { id: "../x", title: "B", at: 2 },
        { id: "def", title: 3, at: 3 },
      ]),
    );
    expect(list).toEqual([{ id: "abc", title: "A", at: 1 }]);
  });
});
