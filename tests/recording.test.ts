import { describe, expect, it } from "vitest";
import { formatElapsed, recordingBaseName, safeFileLabel, safeFileName } from "@shared/recording";

describe("safeFileLabel", () => {
  it("tira caracteres que o Windows não aceita", () => {
    expect(safeFileLabel('Tela de A<n>a: "1/2"?*|')).toBe("Tela de Ana 12");
  });
  it("não termina em ponto nem espaço e nunca fica vazio", () => {
    expect(safeFileLabel("Câmera de Zé...  ")).toBe("Câmera de Zé");
    expect(safeFileLabel("///")).toBe("Gravação");
    expect(safeFileLabel("a\\b")).toBe("ab");
  });
  it("corta rótulos enormes", () => {
    expect(safeFileLabel("x".repeat(300))).toHaveLength(80);
  });
});

describe("recordingBaseName", () => {
  it("põe data e hora ordenáveis antes do rótulo", () => {
    expect(recordingBaseName("Tela de Ana", new Date(2026, 9, 3, 7, 5, 9))).toBe(
      "MyScreen 2026-10-03 07-05-09 - Tela de Ana",
    );
  });
});

describe("formatElapsed", () => {
  it("formata minutos e horas", () => {
    expect(formatElapsed(7_000)).toBe("0:07");
    expect(formatElapsed(750_000)).toBe("12:30");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("safeFileName", () => {
  it("tira pastas e mantém a extensão", () => {
    expect(safeFileName("..\\..\\Windows\\evil.exe")).toBe("evil.exe");
    expect(safeFileName("relatório: final?.pdf")).toBe("relatório final.pdf");
    expect(safeFileName("CON.txt")).toBe("_CON.txt");
    expect(safeFileName("")).toBe("Gravação");
  });
});
