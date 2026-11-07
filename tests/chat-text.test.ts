import { describe, expect, it } from "vitest";
import { formatBytes, isEmojiOnly, linkHref, parseChatText } from "@shared/chatText";

const inline = (text: string) => {
  const [block] = parseChatText(text);
  return block?.kind === "paragraph" ? block.children : [];
};

describe("parseChatText", () => {
  it("transforma links em links e tira a pontuação da frase", () => {
    expect(inline("veja https://exemplo.com/a_b?x=1. ok")).toEqual([
      { kind: "text", text: "veja " },
      { kind: "link", text: "https://exemplo.com/a_b?x=1", href: "https://exemplo.com/a_b?x=1" },
      { kind: "text", text: ". ok" },
    ]);
  });
  it("www. vira https", () => {
    expect(inline("www.site.com.br")).toEqual([
      { kind: "link", text: "www.site.com.br", href: "https://www.site.com.br/" },
    ]);
  });
  it("parêntese em volta do link fica de fora", () => {
    const parts = inline("(https://a.com/x)");
    expect(parts[1]).toEqual({ kind: "link", text: "https://a.com/x", href: "https://a.com/x" });
  });
  it("entende negrito, itálico, riscado e código", () => {
    expect(inline("**forte** _leve_ ~~não~~ `x*y`")).toEqual([
      { kind: "bold", children: [{ kind: "text", text: "forte" }] },
      { kind: "text", text: " " },
      { kind: "italic", children: [{ kind: "text", text: "leve" }] },
      { kind: "text", text: " " },
      { kind: "strike", children: [{ kind: "text", text: "não" }] },
      { kind: "text", text: " " },
      { kind: "code", text: "x*y" },
    ]);
  });
  it("conta com asterisco solto e nome_de_arquivo ficam literais", () => {
    expect(inline("2 * 3 * 4 e meu_arquivo_novo.txt")).toEqual([
      { kind: "text", text: "2 * 3 * 4 e meu_arquivo_novo.txt" },
    ]);
  });
  it("sublinhado dentro de link não vira itálico", () => {
    expect(inline("https://a.com/_x_")).toEqual([{ kind: "link", text: "https://a.com/_x_", href: "https://a.com/_x_" }]);
  });
  it("quebra de linha e bloco de código", () => {
    expect(parseChatText("oi\ntudo\n```ts\nconst a = 1;\n```\nfim")).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: "oi" }, { kind: "break" }, { kind: "text", text: "tudo" }] },
      { kind: "codeblock", text: "const a = 1;" },
      { kind: "paragraph", children: [{ kind: "text", text: "fim" }] },
    ]);
  });
  it("``` sem par fica como texto", () => {
    expect(parseChatText("a ``` b")).toEqual([{ kind: "paragraph", children: [{ kind: "text", text: "a ``` b" }] }]);
  });
});

describe("linkHref", () => {
  it("só aceita http e https", () => {
    expect(linkHref("javascript:alert(1)")).toBeNull();
    expect(linkHref("http://x.com")).toBe("http://x.com/");
  });
});

describe("isEmojiOnly / formatBytes", () => {
  it("detecta mensagem só de emoji", () => {
    expect(isEmojiOnly("😂")).toBe(true);
    expect(isEmojiOnly("👍🏽 🎉")).toBe(true);
    expect(isEmojiOnly("oi 😂")).toBe(false);
    expect(isEmojiOnly("123")).toBe(false);
  });
  it("formata tamanhos", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1,5 MB");
  });
});
