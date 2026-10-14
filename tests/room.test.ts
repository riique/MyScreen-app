import { describe, expect, it } from "vitest";
import { compareVersions, inviteUrl, normalizeRoomId, parseDeepLink, parseRoomInput } from "@shared/room";

describe("parseRoomInput", () => {
  it("aceita código puro e normaliza", () => {
    expect(parseRoomInput("  AbcDefGhi ")).toBe("abcdefghi");
    expect(parseRoomInput("minha-sala_1")).toBe("minha-sala_1");
  });
  it("extrai o código de um link colado, cortando ? e #", () => {
    expect(parseRoomInput("https://myscreen.haumea.fun/room/xyzabc?foo=1")).toBe("xyzabc");
    expect(parseRoomInput("https://x/room/ABC#frag")).toBe("abc");
    expect(parseRoomInput("http://localhost:3000/room/sala-1/")).toBe("sala-1");
  });
  it("recusa vazio e lixo", () => {
    expect(parseRoomInput("")).toBeNull();
    expect(parseRoomInput("   ")).toBeNull();
    expect(parseRoomInput("../etc/passwd")).toBeNull();
    expect(parseRoomInput("https://x/room/")).toBeNull();
    expect(parseRoomInput("tem espaço")).toBeNull();
  });
  it("respeita o teto de 64", () => {
    expect(normalizeRoomId("a".repeat(100))).toHaveLength(64);
  });
});

describe("parseDeepLink", () => {
  it("lê myscreen://room/<id>", () => {
    expect(parseDeepLink("myscreen://room/abcdef")).toBe("abcdef");
    expect(parseDeepLink("myscreen://room/ABC/")).toBe("abc");
    expect(parseDeepLink("MYSCREEN://room/abc")).toBe("abc");
  });
  it("ignora o resto", () => {
    expect(parseDeepLink("https://myscreen.haumea.fun/room/abc")).toBeNull();
    expect(parseDeepLink("myscreen://settings")).toBeNull();
    expect(parseDeepLink("myscreen://room/abc/extra")).toBeNull();
    expect(parseDeepLink("--flag")).toBeNull();
    expect(parseDeepLink("myscreen://room/a%20b")).toBeNull();
  });
});

describe("inviteUrl", () => {
  it("é sempre a URL web", () => {
    expect(inviteUrl("https://myscreen.haumea.fun", "abc")).toBe("https://myscreen.haumea.fun/room/abc");
    expect(inviteUrl("https://x.com/", "a b")).toBe("https://x.com/room/a%20b");
  });
});

describe("compareVersions", () => {
  it("compara x.y.z", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
  });
});
