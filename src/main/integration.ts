import path from "node:path";
import { app, globalShortcut, Menu, Notification, Tray } from "electron";
import type { RoomState, ShortcutAction } from "../shared/ipc";
import { parseDeepLink } from "../shared/room";
import { appImage, glyphImage } from "./icons";
import { getSettings } from "./settings";
import { getMainWindow, showMainWindow } from "./windows";

/**
 * Integração com o Windows: deep link, bandeja, atalhos globais, botões da
 * miniatura e notificações. Tudo segue o estado da sala que o renderer manda.
 */

let roomState: RoomState = { inRoom: false, micOn: false, camOn: false, sharing: false };
let pendingRoom: string | null = null;
let tray: Tray | null = null;

function send(channel: string, ...args: unknown[]): void {
  const win = getMainWindow();
  if (win) win.webContents.send(channel, ...args);
}

// ---------------------------------------------------------------- deep link

export function registerProtocolClient(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    // Em dev o executável é o electron.exe: o deep link precisa do caminho do app.
    app.setAsDefaultProtocolClient("myscreen", process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("myscreen");
  }
}

/** Procura `myscreen://room/<id>` nos argumentos (primeira execução ou segunda instância). */
export function handleArgv(argv: string[]): void {
  for (const arg of argv) {
    const room = parseDeepLink(arg);
    if (room) {
      openRoom(room);
      return;
    }
  }
}

function openRoom(room: string): void {
  const win = getMainWindow();
  if (win && !win.webContents.isLoading()) {
    win.webContents.send("app:navigate", room);
  } else {
    pendingRoom = room;
  }
  showMainWindow();
}

export function consumePendingRoom(): string | null {
  const r = pendingRoom;
  pendingRoom = null;
  return r;
}

// ---------------------------------------------------------------- bandeja

function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: "Mostrar o MyScreen", click: () => showMainWindow() },
    { label: "Sair da sala", enabled: roomState.inRoom, click: () => send("room:leave") },
    { type: "separator" },
    { label: "Sair do MyScreen", click: () => app.quit() },
  ]);
}

export function createTray(): void {
  if (tray) return;
  tray = new Tray(appImage(32));
  tray.setToolTip("MyScreen");
  tray.setContextMenu(trayMenu());
  tray.on("click", () => showMainWindow());
}

let hinted = false;

/** Na primeira vez que o X esconde a janela, avisa onde o app foi parar. */
export function hintTray(): void {
  if (hinted || !tray) return;
  hinted = true;
  tray.displayBalloon({
    title: "O MyScreen continua aberto",
    content: "Ele fica nos ícones ocultos da barra de tarefas. Para sair, clique com o botão direito no ícone e escolha “Sair do MyScreen”.",
    iconType: "info",
  });
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

// ---------------------------------------------------------------- atalhos

const SHORTCUTS: Record<ShortcutAction, string> = {
  mic: "CommandOrControl+Shift+M",
  cam: "CommandOrControl+Shift+V",
  "stop-share": "CommandOrControl+Shift+S",
};

let shortcutsOn = false;

function syncShortcuts(): void {
  const want = roomState.inRoom && getSettings().shortcutsEnabled;
  if (want === shortcutsOn) return;
  if (want) {
    for (const [action, accel] of Object.entries(SHORTCUTS) as [ShortcutAction, string][]) {
      // Outro programa pode já ter o atalho: falha calada, os outros seguem.
      const ok = globalShortcut.register(accel, () => send("room:shortcut", action));
      if (!ok) console.warn(`Atalho ocupado por outro programa: ${accel}`);
    }
  } else {
    for (const accel of Object.values(SHORTCUTS)) globalShortcut.unregister(accel);
  }
  shortcutsOn = want;
}

export function refreshShortcuts(): void {
  // Força reavaliação quando a configuração muda.
  if (shortcutsOn) {
    for (const accel of Object.values(SHORTCUTS)) globalShortcut.unregister(accel);
    shortcutsOn = false;
  }
  syncShortcuts();
}

// ---------------------------------------------------------------- miniatura

function syncThumbar(): void {
  const win = getMainWindow();
  if (!win) return;
  if (!roomState.inRoom) {
    win.setThumbarButtons([]);
    return;
  }
  win.setThumbarButtons([
    {
      tooltip: roomState.micOn ? "Silenciar microfone" : "Ativar microfone",
      icon: glyphImage(roomState.micOn ? "mic" : "mic-off"),
      click: () => send("room:shortcut", "mic"),
    },
    {
      tooltip: roomState.camOn ? "Desligar câmera" : "Ligar câmera",
      icon: glyphImage(roomState.camOn ? "cam" : "cam-off"),
      click: () => send("room:shortcut", "cam"),
    },
    { tooltip: "Sair da sala", icon: glyphImage("leave"), click: () => send("room:leave") },
  ]);
}

// ---------------------------------------------------------------- estado

export function setRoomState(state: RoomState): void {
  roomState = state;
  syncShortcuts();
  syncThumbar();
  tray?.setContextMenu(trayMenu());
}

export function getRoomState(): RoomState {
  return roomState;
}

/** Mensagem de chat com a janela fora de foco: notificação + piscar na barra. */
export function notify(title: string, body: string): void {
  const win = getMainWindow();
  if (!win || win.isFocused()) return;
  win.flashFrame(true);
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: appImage(64), silent: false });
  n.on("click", () => showMainWindow());
  n.show();
}
