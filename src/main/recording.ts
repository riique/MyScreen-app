import { app, shell, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordingBaseName } from "../shared/recording";

/**
 * Gravação da sala: o renderer grava (MediaRecorder) e manda os pedaços para
 * cá a cada segundo; aqui eles vão direto para o disco. Nada fica acumulado na
 * memória, então uma reunião de horas não pesa mais do que uma de minutos.
 *
 * O arquivo é aberto aqui, com nome escolhido aqui: o renderer só diz o rótulo
 * ("Tela de Ana") e recebe um id opaco.
 */

interface OpenRecording {
  stream: fs.WriteStream;
  file: string;
  owner: WebContents;
}

const open = new Map<string, OpenRecording>();
/** Arquivos criados nesta execução: só eles podem ser revelados no Explorer. */
const created = new Set<string>();
const watched = new WeakSet<WebContents>();

export function recordingsDir(): string {
  return path.join(app.getPath("videos"), "MyScreen");
}

export function openRecording(owner: WebContents, label: string, ext: "mp4" | "webm"): { id: string; file: string } {
  const dir = recordingsDir();
  fs.mkdirSync(dir, { recursive: true });
  const base = recordingBaseName(label, new Date());
  let file = path.join(dir, `${base}.${ext}`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n}).${ext}`);

  const id = randomUUID();
  const stream = fs.createWriteStream(file, { flags: "wx" });
  stream.on("error", (error) => {
    console.error(`Gravação ${file} falhou:`, error);
    open.delete(id);
  });
  open.set(id, { stream, file, owner });
  created.add(file);
  // A janela da sala morreu (crash, reload): fecha o que ela deixou aberto.
  if (!watched.has(owner)) {
    watched.add(owner);
    owner.once("destroyed", () => closeOwnedBy(owner));
  }
  return { id, file };
}

export function writeRecording(id: string, bytes: Uint8Array): void {
  const rec = open.get(id);
  if (!rec) return;
  rec.stream.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

export function closeRecording(id: string): Promise<string | null> {
  const rec = open.get(id);
  if (!rec) return Promise.resolve(null);
  open.delete(id);
  return new Promise((resolve) => rec.stream.end(() => resolve(rec.file)));
}

function closeOwnedBy(owner: WebContents): void {
  for (const [id, rec] of open) if (rec.owner === owner) void closeRecording(id);
}

export function closeAllRecordings(): void {
  for (const id of [...open.keys()]) void closeRecording(id);
}

/** Mostra o arquivo no Explorer; sem arquivo (ou um que não é nosso), abre a pasta. */
export function revealRecording(file: string | null): void {
  if (file && created.has(file) && fs.existsSync(file)) {
    shell.showItemInFolder(file);
    return;
  }
  const dir = recordingsDir();
  fs.mkdirSync(dir, { recursive: true });
  void shell.openPath(dir);
}
