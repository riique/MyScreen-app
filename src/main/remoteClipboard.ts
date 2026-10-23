import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, clipboard, ClipboardItem, nativeImage } from "electron";
import type { RichClipboard } from "../shared/ipc";
import { MAX_CLIP_BYTES, MAX_CLIP_FILES, MAX_CLIP_FILES_BYTES } from "../shared/remote/protocol";
import { safeFileName } from "../shared/recording";

/**
 * Área de transferência rica do controle remoto: texto, imagem e arquivos.
 *
 * Quem controla: lê o que copiou aqui (`readRichClipboard`). A chave de cada
 * conteúdo deixa o renderer pular o envio quando nada mudou — sem ler de novo
 * 100 MB de arquivos a cada vez que a tela remota ganha o foco.
 *
 * Quem é controlado: grava a imagem como PNG, ou salva os arquivos numa pasta
 * temporária e põe a lista na área de transferência (CF_HDROP), para o Ctrl+V
 * do Explorer, do e-mail ou do WhatsApp colar como se tivessem sido copiados aqui.
 */

function sha1(data: string | Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

async function clipboardTypes(): Promise<{ types: Set<string>; items: Electron.ClipboardItem[] }> {
  const items = await clipboard.read();
  return { types: new Set(items.flatMap((i) => i.types)), items };
}

async function readType(items: Electron.ClipboardItem[], type: string): Promise<Blob | null> {
  const item = items.find((i) => i.types.includes(type));
  if (!item) return null;
  const v = await item.getType(type);
  return v instanceof Blob ? v : null;
}

/** Caminhos dos arquivos copiados no Explorer (vêm como `file:///` no uri-list). */
function filePaths(uriList: string): string[] {
  return uriList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("file:"))
    .flatMap((l) => {
      try {
        return [fileURLToPath(l)];
      } catch {
        return [];
      }
    });
}

export async function readRichClipboard(lastKey: string | null): Promise<RichClipboard> {
  const { types, items } = await clipboardTypes();

  // Arquivos copiados no Explorer.
  const uri = types.has("text/uri-list") ? await readType(items, "text/uri-list") : null;
  const paths = uri ? filePaths(await uri.text()) : [];
  if (paths.length > 0) {
    const stats = await Promise.all(paths.map(async (p) => ({ p, st: await fs.stat(p).catch(() => null) })));
    const files = stats.filter((f) => f.st?.isFile());
    const folders = stats.length - files.length;
    const key = "f:" + sha1(files.map((f) => `${f.p}|${f.st!.size}|${f.st!.mtimeMs}`).join("\n"));
    if (key === lastKey) return { kind: "same" };
    if (files.length === 0) {
      return { kind: "unsupported", key, message: "Pastas não vão pela área de transferência: copie os arquivos de dentro delas." };
    }
    const total = files.reduce((n, f) => n + f.st!.size, 0);
    if (files.length > MAX_CLIP_FILES || total > MAX_CLIP_FILES_BYTES) {
      return {
        kind: "unsupported",
        key,
        message: `Arquivos demais para colar no outro PC (no máximo ${MAX_CLIP_FILES} arquivos e ${MAX_CLIP_FILES_BYTES / 1024 / 1024} MB).`,
      };
    }
    const read = await Promise.all(
      files.map(async (f) => ({ name: path.basename(f.p), bytes: new Uint8Array(await fs.readFile(f.p)) })),
    );
    return { kind: "files", key, files: read, skippedFolders: folders };
  }

  // Imagem (print, "Copiar imagem" do navegador...).
  const imageType = [...types].find((t) => t.startsWith("image/"));
  if (imageType) {
    const blob = await readType(items, imageType);
    if (blob) {
      const raw = new Uint8Array(await blob.arrayBuffer());
      const key = "i:" + sha1(raw);
      if (key === lastKey) return { kind: "same" };
      // PNG sempre: é o que todo programa do Windows entende ao colar.
      const png = imageType === "image/png" ? raw : new Uint8Array(nativeImage.createFromBuffer(Buffer.from(raw)).toPNG());
      if (png.byteLength === 0) return { kind: "empty" };
      if (png.byteLength > MAX_CLIP_FILES_BYTES) {
        return { kind: "unsupported", key, message: "A imagem copiada é grande demais para colar no outro PC." };
      }
      return { kind: "image", key, name: "imagem.png", bytes: png };
    }
  }

  const text = await clipboard.readText();
  if (!text) return { kind: "empty" };
  const key = "t:" + sha1(text);
  if (key === lastKey) return { kind: "same" };
  if (new TextEncoder().encode(text).byteLength > MAX_CLIP_BYTES) {
    return { kind: "unsupported", key, message: "O texto copiado é longo demais para colar no outro PC (até 128 KB)." };
  }
  return { kind: "text", key, text };
}

// ---------------------------------------------------------------- lado controlado

export async function writeClipboardImage(bytes: Uint8Array): Promise<void> {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) throw new Error("imagem inválida");
  const png = image.toPNG();
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) })]);
}

/** Pasta dos arquivos recebidos: some com o resto do %TEMP%; as de mais de um dia são limpas aqui. */
function receivedRoot(): string {
  return path.join(app.getPath("temp"), "MyScreen", "Recebidos");
}

async function pruneOld(root: string): Promise<void> {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(root, e.name);
    const st = await fs.stat(full).catch(() => null);
    if (st && st.mtimeMs < dayAgo) await fs.rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

export async function writeClipboardFiles(files: { name: string; bytes: Uint8Array }[]): Promise<string[]> {
  const root = receivedRoot();
  await fs.mkdir(root, { recursive: true });
  void pruneOld(root);
  const dir = await fs.mkdtemp(path.join(root, `${new Date().toISOString().slice(0, 10)}-`));
  const used = new Set<string>();
  const paths: string[] = [];
  for (const f of files) {
    let name = safeFileName(f.name);
    const dot = name.lastIndexOf(".");
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      name = dot > 0 ? `${safeFileName(f.name).slice(0, dot)} (${n})${safeFileName(f.name).slice(dot)}` : `${name} (${n})`;
    }
    used.add(name.toLowerCase());
    const full = path.join(dir, name);
    await fs.writeFile(full, f.bytes, { flag: "wx" });
    paths.push(full);
  }
  await setFileDropList(paths);
  return paths;
}

/**
 * O Electron não escreve CF_HDROP; o `Set-Clipboard -LiteralPath` do PowerShell
 * escreve. Os caminhos são todos nossos, dentro de %TEMP%, e vão entre aspas
 * simples escapadas, no comando codificado (nada passa por um shell).
 */
function setFileDropList(paths: string[]): Promise<void> {
  // Sem o "Stop", um caminho recusado é erro não fatal e o PowerShell sai com 0.
  const script = "param([string[]]$p) Set-Clipboard -LiteralPath $p";
  const encoded = Buffer.from(
    `$ErrorActionPreference = 'Stop'; & { ${script} } @(${paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",")})`,
    "utf16le",
  ).toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 15_000 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}
