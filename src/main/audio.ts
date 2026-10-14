import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from "electron";
import type { ApiResult, AudioCapabilities, AudioLevel, SystemAudioMode, SystemAudioOptions } from "../shared/ipc";
import { hwndFromSourceId } from "../shared/media";

/**
 * Dono do utility process "audio". Cria a MessageChannel, entrega uma ponta
 * ao processo (que escreve o PCM) e a outra ao renderer (que toca no worklet).
 */

const DISCORD = ["discord.exe", "discordptb.exe", "discordcanary.exe", "discordsystemhelper.exe"];
/** Loopback por processo: Windows 10 2004 (build 19041) em diante. */
const MIN_WINDOWS_BUILD = 19041;

type WorkerMessage =
  | { type: "probe"; ok: boolean; error: string | null }
  | { type: "started" }
  | { type: "start-error"; message: string }
  | { type: "error"; message: string }
  | { type: "level"; level: number; agcDb: number };

let child: UtilityProcess | null = null;
let probe: Promise<AudioCapabilities> | null = null;
let owner: WebContents | null = null;
let active = false;
let paused = false;
let options: SystemAudioOptions = { normalize: true, gainPct: 100 };
const pending = new Set<(msg: WorkerMessage) => void>();
const levelListeners = new Set<(level: AudioLevel) => void>();
/** Janelas que já têm o "destroyed" ligado (um listener por janela, não por captura). */
const watched = new WeakSet<WebContents>();

export function nativeModulePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "myscreen-native.node")
    : path.join(app.getAppPath(), "native", "myscreen-native.node");
}

function windowsBuild(): number {
  const parts = os.release().split(".");
  return Number(parts[2]) || 0;
}

function lost(message: string): void {
  if (active && owner && !owner.isDestroyed()) owner.send("audio:lost", message);
  active = false;
  paused = false;
  for (const l of levelListeners) l({ level: 0, agcDb: 0 });
}

function ensureChild(): UtilityProcess {
  if (child) return child;
  const proc = utilityProcess.fork(path.join(__dirname, "../audio/worker.js"), [], {
    serviceName: "MyScreen Áudio",
  });
  proc.on("message", (msg: WorkerMessage) => {
    for (const fn of [...pending]) fn(msg);
    if (msg.type === "level") {
      for (const l of levelListeners) l({ level: msg.level, agcDb: msg.agcDb });
      if (owner && !owner.isDestroyed()) owner.send("audio:level", { level: msg.level, agcDb: msg.agcDb });
    } else if (msg.type === "error" && owner && !owner.isDestroyed()) {
      owner.send("audio:error", msg.message);
    }
  });
  proc.on("exit", (code) => {
    console.warn("Processo de áudio saiu com código", code);
    child = null;
    probe = null;
    lost("O áudio do sistema parou. A tela continua no ar, sem o som do PC.");
  });
  child = proc;
  return proc;
}

function waitFor<T extends WorkerMessage["type"]>(
  types: T[],
  timeoutMs: number,
): Promise<Extract<WorkerMessage, { type: T }> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(fn);
      resolve(null);
    }, timeoutMs);
    const fn = (msg: WorkerMessage) => {
      if ((types as string[]).includes(msg.type)) {
        clearTimeout(timer);
        pending.delete(fn);
        resolve(msg as Extract<WorkerMessage, { type: T }>);
      }
    };
    pending.add(fn);
  });
}

export function audioCapabilities(): Promise<AudioCapabilities> {
  if (probe) return probe;
  probe = (async (): Promise<AudioCapabilities> => {
    if (process.platform !== "win32") return { native: false, reason: "O som nativo só existe no Windows." };
    if (windowsBuild() < MIN_WINDOWS_BUILD) {
      return { native: false, reason: "Este Windows é anterior ao 10 versão 2004 e não tem captura de som por programa." };
    }
    const file = nativeModulePath();
    if (!existsSync(file)) return { native: false, reason: "O módulo de som nativo não foi encontrado nesta instalação." };
    const proc = ensureChild();
    const reply = waitFor(["probe"], 8000);
    proc.postMessage({ type: "probe", nativePath: file });
    const msg = await reply;
    if (!msg) return { native: false, reason: "O processo de som não respondeu." };
    return msg.ok ? { native: true, reason: null } : { native: false, reason: `Falha ao carregar o módulo de som: ${msg.error}` };
  })();
  return probe;
}

export async function startAudio(
  sender: WebContents,
  id: string,
  mode: SystemAudioMode,
  opts: SystemAudioOptions,
): Promise<ApiResult<null>> {
  const fail = (error: string): ApiResult<null> => ({ ok: false, error, field: null, status: 0, retryAfter: null });
  if (mode.kind === "off") return fail("sem som escolhido");
  const caps = await audioCapabilities();
  if (!caps.native) return fail(caps.reason ?? "som nativo indisponível");

  stopAudio();
  const proc = ensureChild();
  options = opts;
  paused = false;

  let cmd: Record<string, unknown>;
  if (mode.kind === "window-only") {
    const hwnd = hwndFromSourceId(mode.sourceId);
    if (hwnd === null) return fail("A fonte escolhida não é uma janela.");
    cmd = { mode: "include", pids: [], hwnd: hwnd.toString(), excludeNames: [] };
  } else {
    // A árvore do processo principal cobre o renderer e o serviço de áudio do
    // Chromium: a voz da chamada não volta para a sala como eco.
    cmd = { mode: "exclude", pids: [process.pid], hwnd: null, excludeNames: mode.alsoExcludeDiscord ? DISCORD : [] };
  }

  const { port1, port2 } = new MessageChannelMain();
  const reply = waitFor(["started", "start-error"], 8000);
  proc.postMessage({ type: "start", ...cmd, normalize: opts.normalize, gainPct: opts.gainPct }, [port1]);
  const msg = await reply;
  if (!msg || msg.type === "start-error") {
    port2.close();
    return fail(msg?.type === "start-error" ? msg.message : "O processo de som não respondeu.");
  }
  if (sender.isDestroyed()) {
    stopAudio();
    return fail("janela fechada");
  }
  owner = sender;
  active = true;
  if (!watched.has(sender)) {
    watched.add(sender);
    sender.once("destroyed", () => {
      if (owner === sender) stopAudio();
    });
  }
  sender.postMessage("audio:port", id, [port2]);
  return { ok: true, data: null };
}

export function updateAudio(patch: Partial<SystemAudioOptions> & { paused?: boolean }): void {
  if (typeof patch.normalize === "boolean") options = { ...options, normalize: patch.normalize };
  if (typeof patch.gainPct === "number") options = { ...options, gainPct: patch.gainPct };
  if (typeof patch.paused === "boolean") paused = patch.paused;
  child?.postMessage({ type: "update", ...patch });
}

export function stopAudio(): void {
  active = false;
  paused = false;
  owner = null;
  child?.postMessage({ type: "stop" });
  for (const l of levelListeners) l({ level: 0, agcDb: 0 });
}

export function audioState(): { active: boolean; paused: boolean; options: SystemAudioOptions } {
  return { active, paused, options };
}

export function onAudioLevel(fn: (level: AudioLevel) => void): () => void {
  levelListeners.add(fn);
  return () => levelListeners.delete(fn);
}

export function shutdownAudio(): void {
  stopAudio();
  child?.kill();
  child = null;
}
