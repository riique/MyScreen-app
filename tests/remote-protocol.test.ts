import { describe, expect, it } from "vitest";
import {
  HEADER_BYTES,
  IN,
  MAX_TEXT_BYTES,
  WheelAccumulator,
  decodeInput,
  encodeCtl,
  encodeInput,
  isId,
  parseCtl,
  randomId,
  seqNewer,
  sessionTag,
  type InputEvent,
} from "@shared/remote/protocol";

const ID = "AAECAwQFBgcICQoLDA0ODw"; // bytes 0..15

describe("ids", () => {
  it("randomId tem 22 caracteres base64url e é único", () => {
    const a = randomId();
    expect(isId(a)).toBe(true);
    expect(a).not.toBe(randomId());
  });
  it("sessionTag são os 4 primeiros bytes", () => {
    expect(sessionTag(ID)).toBe(0x00010203);
    expect(sessionTag("_____________________w")).toBe(0xffffffff);
  });
});

describe("rc.ctl", () => {
  it("ida e volta de cada tipo", () => {
    const msgs = [
      { t: "request", v: 1, reqId: ID },
      { t: "cancel", reqId: ID },
      { t: "grant", reqId: ID, sessionId: ID, trackSid: "TR_abc123", width: 2560, height: 1440 },
      { t: "deny", reqId: ID, reason: "refused" },
      { t: "revoke", sessionId: ID, reason: "panic" },
      { t: "state", sessionId: ID, paused: true, why: "elevated" },
      { t: "state", sessionId: ID, paused: false },
      { t: "blocked", sessionId: ID },
      { t: "ping", sessionId: ID, n: 7 },
      { t: "pong", sessionId: ID, n: 7 },
    ] as const;
    for (const m of msgs) expect(parseCtl(encodeCtl(m))).toEqual(m);
  });
  it("recusa esquema errado", () => {
    expect(parseCtl({ t: "request", v: 1, reqId: "curto" })).toBeNull();
    expect(parseCtl({ t: "deny", reqId: ID, reason: "porque sim" })).toBeNull();
    expect(parseCtl({ t: "state", sessionId: ID, paused: "sim" })).toBeNull();
    expect(parseCtl({ t: "grant", reqId: ID, sessionId: ID, trackSid: "x y", width: 1, height: 1 })).toBeNull();
    expect(parseCtl({ t: "nada" })).toBeNull();
    expect(parseCtl([1, 2])).toBeNull();
    expect(parseCtl(new TextEncoder().encode("{não é json"))).toBeNull();
    expect(parseCtl(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(parseCtl(new Uint8Array(2000).fill(0x20))).toBeNull();
  });
});

describe("rc.in", () => {
  const events: InputEvent[] = [
    { t: "move", x: 0, y: 65535 },
    { t: "button", button: 4, down: true, x: 100, y: 200 },
    { t: "wheel", dx: -120, dy: 240, x: 1, y: 2 },
    { t: "key", scancode: 0x14b, down: false },
    { t: "text", text: "olá 😀\n" },
    { t: "release" },
  ];
  it("ida e volta de cada tipo, com tag e seq", () => {
    for (const ev of events) {
      expect(decodeInput(encodeInput(0xdeadbeef, 65535, ev))).toEqual({ tag: 0xdeadbeef, seq: 65535, ev });
    }
  });
  it("tamanhos exatos", () => {
    expect(encodeInput(1, 1, { t: "move", x: 1, y: 1 }).byteLength).toBe(HEADER_BYTES + 4);
    expect(encodeInput(1, 1, { t: "release" }).byteLength).toBe(HEADER_BYTES);
  });
  it("recusa tamanho errado, tipo desconhecido e valores fora de faixa", () => {
    const move = encodeInput(1, 1, { t: "move", x: 1, y: 1 });
    expect(decodeInput(move.subarray(0, move.byteLength - 1))).toBeNull();
    expect(decodeInput(new Uint8Array([...move, 0]))).toBeNull();
    const unknown = move.slice();
    unknown[0] = 0x7f;
    expect(decodeInput(unknown)).toBeNull();
    const badButton = encodeInput(1, 1, { t: "button", button: 0, down: true, x: 0, y: 0 });
    badButton[HEADER_BYTES] = 9;
    expect(decodeInput(badButton)).toBeNull();
    const badKey = encodeInput(1, 1, { t: "key", scancode: 0x1e, down: true });
    badKey[HEADER_BYTES + 2] = 2;
    expect(decodeInput(badKey)).toBeNull();
    expect(decodeInput(new Uint8Array(3))).toBeNull();
  });
  it("texto: limite de 1 KiB e UTF-8 válido", () => {
    expect(() => encodeInput(1, 1, { t: "text", text: "a".repeat(MAX_TEXT_BYTES + 1) })).toThrow();
    const bad = new Uint8Array(HEADER_BYTES + 2);
    bad[0] = IN.TEXT;
    bad.set([0xc3, 0x28], HEADER_BYTES);
    expect(decodeInput(bad)).toBeNull();
    const empty = new Uint8Array(HEADER_BYTES);
    empty[0] = IN.TEXT;
    expect(decodeInput(empty)).toBeNull();
  });
  it("fuzz: bytes aleatórios nunca lançam", () => {
    for (let i = 0; i < 5000; i++) {
      const bytes = new Uint8Array(Math.floor(Math.random() * 40));
      crypto.getRandomValues(bytes);
      if (bytes.byteLength > 0) bytes[0] = (bytes[0] % 8) as number;
      expect(() => decodeInput(bytes)).not.toThrow();
      expect(() => parseCtl(bytes)).not.toThrow();
    }
  });
});

describe("seqNewer", () => {
  it("compara com a volta de 16 bits", () => {
    expect(seqNewer(2, 1)).toBe(true);
    expect(seqNewer(1, 2)).toBe(false);
    expect(seqNewer(1, 1)).toBe(false);
    expect(seqNewer(0, 65535)).toBe(true);
    expect(seqNewer(65535, 0)).toBe(false);
  });
});

describe("WheelAccumulator", () => {
  it("100 px para baixo = um dente para baixo (−120)", () => {
    expect(new WheelAccumulator().add(0, 100, 0)).toEqual({ dx: 0, dy: -120 });
  });
  it("linhas e páginas", () => {
    expect(new WheelAccumulator().add(0, 3, 1)).toEqual({ dx: 0, dy: -120 });
    expect(new WheelAccumulator().add(1, 0, 2)).toEqual({ dx: 360, dy: 0 });
  });
  it("acumula frações do touchpad", () => {
    const w = new WheelAccumulator();
    expect(w.add(0, 0.4, 0)).toEqual({ dx: 0, dy: 0 });
    expect(w.add(0, 0.5, 0)).toEqual({ dx: 0, dy: -1 });
  });
});
