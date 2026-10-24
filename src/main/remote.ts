import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Notification,
  powerMonitor,
  screen,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import type { RemoteCapabilities, RemoteSessionEvent } from "../shared/ipc";
import type { Rect } from "../shared/remote/geometry";
import { MAX_CLIP_FILES, MAX_CLIP_FILES_BYTES, isId, parseCtl, randomId, type Ctl } from "../shared/remote/protocol";
import { nativeModulePath } from "./audio";
import { appImage } from "./icons";
import { HELPER_FLAG, PARENT_FLAG } from "./inputHelper";
import { readRichClipboard, writeClipboardFiles, writeClipboardImage } from "./remoteClipboard";
import { RemoteGate, type HostShare, type InjectCommand, type SessionInfo } from "./remoteGate";
import { asBoolean, asObject, asString, assertAppSender } from "./security";
import { getSettings } from "./settings";
import { getMainWindow, getSharing, onSharingChanged, showMainWindow } from "./windows";

/**
 * Controle remoto do lado controlado, no processo principal: o utility
 * "input" (SendInput), o portão (`RemoteGate`), o auxiliar elevado, o atalho
 * de pânico e todas as revogações automáticas.
 */

/** Encerra o controle na hora, de qualquer lugar. Não conflita com os atalhos da sala. */
export const PANIC_SHORTCUT = "Control+Alt+Shift+S";

type WorkerMessage =
  | { type: "probe"; ok: boolean; error: string | null }
  | { type: "elevated"; on: boolean }
  | { type: "error"; message: string }
  | { type: "blocked" }
  | { type: "forward"; cmd: InjectCommand }
  | { type: "hookKey"; scancode: number; down: boolean }
  | { type: "localMouse" }
  | { type: "hook-error"; message: string }
  | { type: "dryrun"; cmd: InjectCommand }
  | { type: "elevate"; ok: boolean; error: string | null };

let child: UtilityProcess | null = null;
let probe: Promise<RemoteCapabilities> | null = null;
let panicRegistered = false;
const sessionListeners = new Set<(active: boolean) => void>();
/** Auxiliar elevado conectado: o input vai por ele, e janelas de administrador recebem. */
let elevatedLink: net.Socket | null = null;
let elevating = false;
let onElevate: ((msg: WorkerMessage & { type: "elevate" }) => void) | null = null;

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
        if (!elevatedLink) gate.setElevated(msg.on);
        break;
      case "elevate":
        onElevate?.(msg);
        onElevate = null;
        break;
      case "error":
        console.warn("Controle remoto:", msg.message);
        break;
      case "dryrun":
        console.info("[input dry-run]", JSON.stringify(msg.cmd));
        break;
      case "blocked":
        // Clique sobre o MyScreen da pessoa controlada: descartado de propósito.
        gate.blocked();
        break;
      case "localMouse":
        gate.localMouse();
        break;
      case "forward":
        elevatedLink?.write(`${JSON.stringify(msg.cmd)}\n`);
        break;
      case "hookKey":
        if (hookOwner && !hookOwner.isDestroyed()) hookOwner.send("remote:hookKey", msg.scancode, msg.down);
        break;
      case "hook-error":
        console.warn("Hook de teclado indisponível:", msg.message);
        if (hookOwner && !hookOwner.isDestroyed()) hookOwner.send("remote:hookState", false);
        break;
    }
  });
  proc.on("exit", (code) => {
    console.warn("Processo de controle remoto saiu com código", code);
    child = null;
    probe = null;
    onElevate?.({ type: "elevate", ok: false, error: "o processo de controle remoto saiu" });
    onElevate = null;
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
    proc.postMessage({ type: "probe", nativePath: file, dryRun: DRY_RUN, ownPid: process.pid });
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
  appFocused: () => BrowserWindow.getFocusedWindow() !== null,
  send: (to: string, msg: Ctl) => sendToMain("remote:send", to, msg),
  // Com o auxiliar elevado, o comando passa antes pelo utility (zona
  // protegida) e volta como "forward"; a ordem se mantém.
  inject: (cmd) => child?.postMessage({ type: elevatedLink ? "check" : "inject", cmd }),
  // Síncrono, no main: um Ctrl+V que vem logo depois já encontra o texto.
  setClipboard: (text) => clipboard.writeText(text),
  askConsent: (req) => {
    showMainWindow();
    consentNotification(req.name);
    sendToMain("remote:consent", req);
  },
  closeConsent: (reqId) => sendToMain("remote:consentClosed", reqId),
  sessionChanged: (info, ended) => onSessionChanged(info, ended ?? null),
});

// ---------------------------------------------------------------- janelas de administrador

/**
 * A pessoa controlada clicou em "Liberar" na sala: sobe o auxiliar elevado
 * (UAC) e passa o input por ele. Vale até o MyScreen fechar — o UAC é uma vez
 * por execução, e quem decide se um evento entra continua sendo o portão.
 * Devolve se o acesso ficou liberado.
 */
async function elevateInput(): Promise<boolean> {
  const proc = child;
  if (elevatedLink) return true;
  if (elevating || !proc || DRY_RUN) return false;
  elevating = true;
  const pipe = `\\\\.\\pipe\\myscreen-input-${randomBytes(16).toString("hex")}`;
  const server = net.createServer();
  let socket: net.Socket | null = null;
  const connected = new Promise<void>((resolve) => {
    server.on("connection", (s) => {
      s.on("error", (error) => console.warn("Auxiliar elevado:", error.message));
      if (socket) {
        s.destroy();
        return;
      }
      socket = s;
      resolve();
    });
  });
  // O UAC só aparece na frente se uma janela nossa estiver na frente.
  const win = getMainWindow();
  const wasHidden = win !== null && !win.isVisible();
  const wasMinimized = win !== null && win.isMinimized();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipe, resolve);
    });
    showMainWindow();
    const main = getMainWindow();
    const hwnd = main ? Number(main.getNativeWindowHandle().readBigInt64LE(0)) : 0;
    const args = [
      ...(process.defaultApp ? [`"${app.getAppPath()}"`] : []),
      `${HELPER_FLAG}${pipe}`,
      `${PARENT_FLAG}${process.pid}`,
    ].join(" ");
    const reply = new Promise<WorkerMessage & { type: "elevate" }>((resolve) => {
      onElevate = resolve;
    });
    proc.postMessage({ type: "elevate", exe: process.execPath, args, hwnd });
    const result = await reply;
    if (!result.ok) {
      if (result.error) console.warn("Auxiliar elevado:", result.error);
      return false;
    }
    await Promise.race([connected, new Promise((resolve) => setTimeout(resolve, 15000))]);
    if (!socket) {
      console.warn("Auxiliar elevado: não conectou ao pipe.");
      return false;
    }
    attachElevated(socket);
    return true;
  } catch (error) {
    console.warn("Auxiliar elevado:", error);
    return false;
  } finally {
    server.close();
    elevating = false;
    // A janela volta para onde estava: quem controla segue no que estava fazendo.
    if (win && !win.isDestroyed()) {
      if (wasHidden) win.hide();
      else if (wasMinimized) win.minimize();
    }
  }
}

function attachElevated(socket: net.Socket): void {
  // O que o injetor comum segurava não fica preso.
  child?.postMessage({ type: "inject", cmd: { t: "release" } });
  elevatedLink = socket;
  socket.on("close", () => {
    if (elevatedLink !== socket) return;
    elevatedLink = null;
    syncWatch(gate.active !== null);
  });
  gate.setElevated(false);
  syncWatch(gate.active !== null);
}

// ---------------------------------------------------------------- sessão

function onSessionChanged(info: SessionInfo | null, ended: RemoteSessionEvent["ended"]): void {
  const event: RemoteSessionEvent = { session: info, ended };
  sendToMain("remote:session", event);
  syncWatch(info !== null);
  child?.postMessage({ type: "localWatch", on: info !== null });
  syncPanic(info !== null);
  notifyElevated(info);
  for (const fn of sessionListeners) fn(info !== null);
}

let elevatedNotified = false;

/**
 * Janela de administrador na frente e sem o auxiliar: quem controla não
 * consegue mexer nela. Sem barra na tela, avisa a pessoa controlada uma vez
 * por vez que acontece, e o clique leva ao "Liberar" da sala.
 */
function notifyElevated(info: SessionInfo | null): void {
  const blocked = info !== null && info.elevated && !info.paused && !elevatedLink;
  if (!blocked) {
    elevatedNotified = false;
    return;
  }
  if (elevatedNotified || !Notification.isSupported()) return;
  elevatedNotified = true;
  const n = new Notification({
    title: `${info.name} não consegue mexer nesta janela`,
    body: "É uma janela de administrador. Abra o MyScreen e clique em Liberar.",
    icon: appImage(64),
  });
  n.on("click", () => showMainWindow());
  n.show();
}

/** Com o auxiliar elevado não há o que vigiar: toda janela recebe. */
function syncWatch(active: boolean): void {
  child?.postMessage({ type: "watch", on: active && !elevatedLink });
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
  elevatedLink?.destroy();
  elevatedLink = null;
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
  ipcMain.handle("remote:elevate", async (event) => {
    assertAppSender(event);
    return elevateInput();
  });

  // Lado de quem controla: o texto copiado aqui, para colar no PC remoto.
  ipcMain.handle("remote:readClipboard", (event) => {
    assertAppSender(event);
    return clipboard.readText();
  });

  ipcMain.handle("remote:readClipboardRich", (event, lastKey) => {
    assertAppSender(event);
    return readRichClipboard(typeof lastKey === "string" ? lastKey.slice(0, 64) : null);
  });

  // Lado controlado: imagem/arquivos que quem controla copiou. Só entram da
  // sessão ativa, sem pausa; a resposta volta a quem controla pelo rc.ctl.
  on("remote:deliverClip", (_e, peer, raw) => {
    const from = asPeer(peer);
    const v = asObject(raw, "clip");
    const sessionId = v.sessionId;
    const clipId = v.clipId;
    if (!isId(sessionId) || !isId(clipId)) return;
    const kind = v.kind === "image" ? "image" : v.kind === "files" ? "files" : null;
    const files = Array.isArray(v.files) ? v.files : [];
    if (!kind || files.length === 0 || files.length > MAX_CLIP_FILES) return gate.clipResult(sessionId, clipId, false);
    let total = 0;
    const parsed: { name: string; bytes: Uint8Array }[] = [];
    for (const f of files) {
      const o = asObject(f, "file");
      if (!(o.bytes instanceof Uint8Array)) return gate.clipResult(sessionId, clipId, false);
      total += o.bytes.byteLength;
      parsed.push({ name: asString(o.name ?? "", "name", 260), bytes: o.bytes });
    }
    if (total > MAX_CLIP_FILES_BYTES || !gate.acceptsClip(from, sessionId)) return gate.clipResult(sessionId, clipId, false);
    const write = kind === "image" ? writeClipboardImage(parsed[0].bytes) : writeClipboardFiles(parsed);
    void write.then(
      () => gate.clipResult(sessionId, clipId, true),
      (error: unknown) => {
        console.warn("Área de transferência remota não gravou:", error);
        gate.clipResult(sessionId, clipId, false);
      },
    );
  });

  // Hook de teclado de quem controla: ligado enquanto a tela remota está focada.
  on("remote:captureKeys", (event, on) => void captureKeys(event.sender, asBoolean(on, "on")));

  // O MyScreen ganhou/perdeu o primeiro plano: as teclas do controlador param/voltam.
  const syncFocus = () => setImmediate(() => gate.setAppFocused(BrowserWindow.getFocusedWindow() !== null));
  app.on("browser-window-focus", syncFocus);
  app.on("browser-window-blur", syncFocus);

  onSharingChanged(() => gate.shareChanged());
  screen.on("display-removed", () => gate.shareChanged());
  powerMonitor.on("lock-screen", () => gate.end("locked"));
  powerMonitor.on("suspend", () => gate.end("locked"));
}

let hookOwner: Electron.WebContents | null = null;

async function captureKeys(sender: Electron.WebContents, on: boolean): Promise<void> {
  if (on) {
    const caps = await remoteCapabilities();
    if (!caps.available || !child) {
      sender.send("remote:hookState", false);
      return;
    }
    hookOwner = sender;
    sender.once("destroyed", () => {
      if (hookOwner === sender) {
        hookOwner = null;
        child?.postMessage({ type: "hook", on: false });
      }
    });
  } else if (hookOwner !== sender) {
    return;
  }
  child?.postMessage({ type: "hook", on });
  sender.send("remote:hookState", on);
  if (!on) hookOwner = null;
}

/** A janela principal recarregou ou caiu: quem mandava o input sumiu. */
export function watchMainWindow(win: BrowserWindow): void {
  win.webContents.on("render-process-gone", () => gate.end("left"));
  win.webContents.on("did-start-loading", () => gate.end("left"));
}
