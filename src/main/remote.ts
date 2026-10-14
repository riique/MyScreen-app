import { existsSync } from "node:fs";
import path from "node:path";
import {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Notification,
  powerMonitor,
  screen,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import type { ControlBarState, RemoteCapabilities, RemoteSessionEvent } from "../shared/ipc";
import type { Rect } from "../shared/remote/geometry";
import { parseCtl, randomId, type Ctl } from "../shared/remote/protocol";
import { nativeModulePath } from "./audio";
import { appImage } from "./icons";
import { RemoteGate, type HostShare, type InjectCommand, type SessionInfo } from "./remoteGate";
import { asBoolean, asObject, asString, assertAppSender } from "./security";
import { getSettings } from "./settings";
import { createControlBarWindow, getMainWindow, getSharing, onSharingChanged, showMainWindow } from "./windows";

/**
 * Controle remoto do lado controlado, no processo principal: o utility
 * "input" (SendInput), o portão (`RemoteGate`), a barra fixa no topo do monitor,
 * o atalho de pânico e todas as revogações automáticas.
 */

/** Encerra o controle na hora, de qualquer lugar. Não conflita com os atalhos da sala. */
export const PANIC_SHORTCUT = "Control+Alt+Shift+S";

type WorkerMessage =
  | { type: "probe"; ok: boolean; error: string | null }
  | { type: "elevated"; on: boolean }
  | { type: "error"; message: string }
  | { type: "dryrun"; cmd: InjectCommand };

let child: UtilityProcess | null = null;
let probe: Promise<RemoteCapabilities> | null = null;
let bar: BrowserWindow | null = null;
let barState: ControlBarState | null = null;
let panicRegistered = false;
const sessionListeners = new Set<(active: boolean) => void>();

const DRY_RUN = process.env.MYSCREEN_INPUT_DRYRUN === "1";

function sendToMain(channel: string, ...args: unknown[]): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ---------------------------------------------------------------- utility "input"

function ensureChild(): UtilityProcess {
  if (child) return child;
  const proc = utilityProcess.fork(path.join(__dirname, "../input/worker.js"), [], {
    serviceName: "MyScreen Controle remoto",
  });
  proc.on("message", (msg: WorkerMessage) => {
    switch (msg.type) {
      case "probe":
        onProbe?.(msg);
        onProbe = null;
        break;
      case "elevated":
        gate.setElevated(msg.on);
        break;
      case "error":
        console.warn("Controle remoto:", msg.message);
        break;
      case "dryrun":
        console.info("[input dry-run]", JSON.stringify(msg.cmd));
        break;
    }
  });
  proc.on("exit", (code) => {
    console.warn("Processo de controle remoto saiu com código", code);
    child = null;
    probe = null;
    // Não reinicia no meio de uma sessão: sem injetor, sem controle.
    gate.end("error");
  });
  child = proc;
  return proc;
}

let onProbe: ((msg: WorkerMessage & { type: "probe" }) => void) | null = null;

export function remoteCapabilities(): Promise<RemoteCapabilities> {
  if (probe) return probe;
  probe = (async (): Promise<RemoteCapabilities> => {
    if (process.platform !== "win32") return { available: false, reason: "O controle remoto só existe no Windows." };
    const file = nativeModulePath();
    if (!DRY_RUN && !existsSync(file)) {
      return { available: false, reason: "O módulo nativo não foi encontrado nesta instalação." };
    }
    const proc = ensureChild();
    const reply = new Promise<(WorkerMessage & { type: "probe" }) | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      onProbe = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
    });
    proc.postMessage({ type: "probe", nativePath: file, dryRun: DRY_RUN });
    const msg = await reply;
    if (!msg) return { available: false, reason: "O processo de controle remoto não respondeu." };
    return msg.ok
      ? { available: true, reason: null }
      : { available: false, reason: `Falha ao carregar o controle remoto: ${msg.error}` };
  })();
  return probe;
}

let available = false;

// ---------------------------------------------------------------- mundo → portão

function sharedDisplayPhysical(displayId: string | null): Rect | null {
  if (!displayId) return null;
  const display = screen.getAllDisplays().find((d) => String(d.id) === displayId);
  if (!display) return null;
  const r = screen.dipToScreenRect(null, display.bounds);
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

function currentShare(): HostShare | null {
  const s = getSharing();
  if (!s.active || !s.kind) return null;
  return {
    kind: s.kind,
    sourceName: s.sourceName,
    trackSid: s.trackSid,
    physical: s.kind === "screen" ? sharedDisplayPhysical(s.displayId) : null,
  };
}

function protectedRects(): Rect[] {
  const out: Rect[] = [];
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) continue;
    const r = screen.dipToScreenRect(win, win.getBounds());
    out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
  }
  return out;
}

function consentNotification(name: string): void {
  const win = getMainWindow();
  win?.flashFrame(true);
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: `${name} quer controlar seu computador`,
    body: "Abra o MyScreen para permitir ou recusar.",
    icon: appImage(64),
    urgency: "critical",
  });
  n.on("click", () => showMainWindow());
  n.show();
}

const gate: RemoteGate = new RemoteGate({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  randomId,
  share: currentShare,
  acceptsRequests: () => (available && !getSettings().remoteControlDisabled ? { ok: true } : { ok: false, reason: "disabled" }),
  protectedRects,
  appFocused: () => BrowserWindow.getFocusedWindow() !== null,
  send: (to: string, msg: Ctl) => sendToMain("remote:send", to, msg),
  inject: (cmd) => child?.postMessage({ type: "inject", cmd }),
  askConsent: (req) => {
    showMainWindow();
    consentNotification(req.name);
    sendToMain("remote:consent", req);
  },
  closeConsent: (reqId) => sendToMain("remote:consentClosed", reqId),
  sessionChanged: (info, ended) => onSessionChanged(info, ended ?? null),
});

// ---------------------------------------------------------------- sessão

function onSessionChanged(info: SessionInfo | null, ended: RemoteSessionEvent["ended"]): void {
  const event: RemoteSessionEvent = { session: info, ended };
  sendToMain("remote:session", event);
  child?.postMessage({ type: "watch", on: info !== null });
  syncPanic(info !== null);
  syncBar(info);
  for (const fn of sessionListeners) fn(info !== null);
}

function syncBar(info: SessionInfo | null): void {
  if (!info) {
    barState = null;
    if (bar && !bar.isDestroyed()) {
      bar.setClosable(true);
      bar.destroy();
    }
    bar = null;
    return;
  }
  barState = { name: info.name, paused: info.paused, elevated: info.elevated };
  if (!bar || bar.isDestroyed()) {
    const sharing = getSharing();
    const display =
      screen.getAllDisplays().find((d) => String(d.id) === sharing.displayId) ?? screen.getPrimaryDisplay();
    bar = createControlBarWindow(display.workArea);
    bar.webContents.on("did-finish-load", () => {
      if (barState && bar && !bar.isDestroyed()) bar.webContents.send("bar:state", barState);
    });
  } else {
    bar.webContents.send("bar:state", barState);
  }
}

function syncPanic(on: boolean): void {
  if (on && !panicRegistered) {
    panicRegistered = globalShortcut.register(PANIC_SHORTCUT, () => gate.end("panic"));
    if (!panicRegistered) console.warn(`Atalho de pânico ocupado por outro programa: ${PANIC_SHORTCUT}`);
  } else if (!on && panicRegistered) {
    globalShortcut.unregister(PANIC_SHORTCUT);
    panicRegistered = false;
  }
}

/** Há alguém controlando este PC agora? (bandeja) */
export function remoteSessionActive(): boolean {
  return gate.active !== null;
}

export function onRemoteSession(fn: (active: boolean) => void): () => void {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

export function stopRemoteControl(reason: "user" | "left" = "user"): void {
  gate.end(reason);
}

export function shutdownRemote(): void {
  gate.end("left");
  child?.kill();
  child = null;
}

// ---------------------------------------------------------------- IPC e gatilhos

function asPeer(raw: unknown) {
  const v = asObject(raw, "peer");
  return {
    identity: asString(v.identity, "identity", 128),
    sid: asString(v.sid, "sid", 64),
    name: asString(v.name ?? "", "name", 128).trim().slice(0, 64) || "Participante",
  };
}

export function registerRemote(): void {
  const on = (channel: string, fn: (event: Electron.IpcMainEvent, ...args: unknown[]) => void) =>
    ipcMain.on(channel, (event, ...args) => {
      try {
        assertAppSender(event);
        fn(event, ...args);
      } catch (error) {
        console.warn(`IPC ${channel} recusado:`, error);
      }
    });

  ipcMain.handle("remote:capabilities", async (event) => {
    assertAppSender(event);
    const caps = await remoteCapabilities();
    available = caps.available;
    return caps;
  });

  on("remote:control", (_e, peer, raw) => {
    const msg = parseCtl(raw);
    if (msg) gate.handleCtl(asPeer(peer), msg);
  });
  on("remote:input", (_e, peer, bytes) => {
    if (!(bytes instanceof Uint8Array)) return;
    gate.handleInput(asPeer(peer), bytes);
  });
  on("remote:decide", (_e, reqId, allow) => gate.decide(asString(reqId, "reqId", 64), asBoolean(allow, "allow")));
  on("remote:peerSeen", (_e, identity, sid) =>
    gate.peerSeen(asString(identity, "identity", 128), asString(sid, "sid", 64)),
  );
  on("remote:peerGone", (_e, identity) => gate.peerGone(asString(identity, "identity", 128), "left"));
  on("remote:roomLost", () => gate.end("left"));
  on("remote:stop", () => gate.end("user"));
  on("remote:pause", (_e, paused) => gate.setPaused(asBoolean(paused, "paused")));

  onSharingChanged(() => gate.shareChanged());
  screen.on("display-removed", () => gate.shareChanged());
  powerMonitor.on("lock-screen", () => gate.end("locked"));
  powerMonitor.on("suspend", () => gate.end("locked"));
}

/** A janela principal recarregou ou caiu: quem mandava o input sumiu. */
export function watchMainWindow(win: BrowserWindow): void {
  win.webContents.on("render-process-gone", () => gate.end("left"));
  win.webContents.on("did-start-loading", () => gate.end("left"));
}
