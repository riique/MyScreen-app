import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
const { resolveInside, isSpaRoute, mimeFor } = await import("../src/main/paths");
const { asNumber, asString, isAppUrl, normalizeServerUrl } = await import("../src/main/security");

const root = path.resolve("C:/app/dist/renderer");

describe("resolveInside (protocolo app://)", () => {
  it("resolve arquivos de dentro da raiz", () => {
    expect(resolveInside(root, "/index.html")).toBe(path.join(root, "index.html"));
    expect(resolveInside(root, "/assets/a%20b.js")).toBe(path.join(root, "assets", "a b.js"));
  });
  it("bloqueia path traversal", () => {
    expect(resolveInside(root, "/../secret.txt")).toBeNull();
    expect(resolveInside(root, "/assets/../../x")).toBeNull();
    expect(resolveInside(root, "/%2e%2e/%2e%2e/x")).toBeNull();
    expect(resolveInside(root, "/..%5c..%5cwindows")).toBeNull();
    expect(resolveInside(root, "/C:/Windows/win.ini")).toBeNull();
    expect(resolveInside(root, "/a%00b")).toBeNull();
    expect(resolveInside(root, "/%E0%A4%A")).toBeNull();
  });
  it("rota sem extensão cai na SPA", () => {
    expect(isSpaRoute("/room/abc")).toBe(true);
    expect(isSpaRoute("/assets/x.js")).toBe(false);
    expect(mimeFor("x.woff2")).toBe("font/woff2");
  });
});

describe("isAppUrl", () => {
  it("só aceita a origem do app", () => {
    expect(isAppUrl("app://myscreen/index.html")).toBe(true);
    expect(isAppUrl("app://myscreen")).toBe(true);
    expect(isAppUrl("app://myscreen.evil/x")).toBe(false);
    expect(isAppUrl("https://myscreen.haumea.fun/")).toBe(false);
    expect(isAppUrl("about:blank")).toBe(false);
    expect(isAppUrl(undefined)).toBe(false);
  });
});

describe("validação de IPC", () => {
  it("confere tipo e tamanho", () => {
    expect(asString("abc", "x", 5)).toBe("abc");
    expect(() => asString(1, "x", 5)).toThrow(TypeError);
    expect(() => asString("abcdef", "x", 5)).toThrow(RangeError);
    expect(asNumber(100, "g", 0, 400)).toBe(100);
    expect(() => asNumber(Number.NaN, "g", 0, 400)).toThrow();
    expect(() => asNumber(401, "g", 0, 400)).toThrow();
  });
});

describe("normalizeServerUrl", () => {
  it("aceita https e http local", () => {
    expect(normalizeServerUrl("https://myscreen.haumea.fun/")).toBe("https://myscreen.haumea.fun");
    expect(normalizeServerUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeServerUrl("http://127.0.0.1:3000/x")).toBe("http://127.0.0.1:3000");
  });
  it("recusa http remoto, credenciais e lixo", () => {
    expect(normalizeServerUrl("http://exemplo.com")).toBeNull();
    expect(normalizeServerUrl("https://user:pw@exemplo.com")).toBeNull();
    expect(normalizeServerUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeServerUrl("ftp://x")).toBeNull();
    expect(normalizeServerUrl("não é url")).toBeNull();
  });
});
