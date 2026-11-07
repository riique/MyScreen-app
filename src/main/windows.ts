import path from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  powerSaveBlocker,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from "electron";
import type { SharingState } from "../shared/ipc";
import { appImage } from "./icons";
import { APP_ORIGIN, DEV_SERVER_URL, isAppUrl } from "./security";
import { getSettings } from "./settings";

/** Altura da barra superior (e dos botões de janela sobrepostos). */
export const TITLE_BAR_HEIGHT = 48;

const COLORS = {
  light: { sheet: "#ffffff", ink: "#16171a", paper: "#fafaf9" },
  dark: { sheet: "#131315", ink: "#ededee", paper: "#0b0b0c" },
} as const;

let mainWindow: BrowserWindow | null = null;
let effectiveTheme: "light" | "dark" = nativeTheme.shouldUseDarkColors ? "dark" : "light";

export function pageUrl(): string {
  if (DEV_SERVER_URL) return `${DEV_SERVER_URL.replace(/\/$/, "")}/`;
  return `${APP_ORIGIN}/`;
}

function preloadPath(name = "index"): string {
  return path.join(__dirname, `../preload/${name}.js`);
}

function secureWebPreferences(extra?: BrowserWindowConstructorOptions["webPreferences"]) {
  return {
    preload: preloadPath(),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    ...extra,
  };
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function createMainWindow(): BrowserWindow {
  const c = COLORS[effectiveTheme];
  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "MyScreen",
    icon: appImage(256),
    backgroundColor: c.paper,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: c.sheet, symbolColor: c.ink, height: TITLE_BAR_HEIGHT },
    webPreferences: secureWebPreferences({
      // A 60 FPS mesmo minimizado: sem isto o Chromium segura timers e
      // quadros da janela escondida e quem assiste vê a tela engasgar.
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    }),
  });
  win.once("ready-to-show", () => win.show());
  win.on("focus", () => win.flashFrame(false));
  void win.loadURL(pageUrl());
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

export function showMainWindow(): void {
  const win = getMainWindow() ?? createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** A barra de título nativa acompanha as cores da folha. */
export function applyTheme(theme: "light" | "dark", preference: "light" | "dark" | "system"): void {
  effectiveTheme = theme;
  nativeTheme.themeSource = preference;
  const c = COLORS[theme];
  const win = getMainWindow();
  if (win) {
    win.setTitleBarOverlay({ color: c.sheet, symbolColor: c.ink, height: TITLE_BAR_HEIGHT });
    win.setBackgroundColor(c.paper);
  }
}

// ---------------------------------------------------------------- navegação e pop-outs

/** Links externos permitidos: o servidor configurado e o GitHub do projeto. */
function isAllowedExternal(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "ms-settings:") return true;
    if (u.protocol !== "https:") return false;
    return u.origin === getSettings().serverUrl || u.hostname === "github.com";
  } catch {
    return false;
  }
}

export function openExternalSafely(url: string): void {
  if (isAllowedExternal(url)) void shell.openExternal(url);
}

/**
 * Link que alguém mandou no chat e a pessoa clicou: só http(s), sem usuário e
 * senha embutidos, sempre no navegador padrão — nunca dentro do app.
 */
export function openChatLink(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  if (url.username || url.password) return;
  void shell.openExternal(url.href);
}

const keepOnTop = new WeakMap<BrowserWindow, () => void>();

/**
 * "Sempre no topo" de verdade, inclusive sobre jogo em janela ou tela cheia
 * sem bordas. Um jogo que também se põe no topo passa na frente ao ganhar o
 * foco; por isso, a cada perda de foco a janela reafirma o topo. Tela cheia
 * EXCLUSIVA (DirectX) não deixa nenhuma janela por cima — isso é do Windows.
 */
function setPinnedOnTop(win: BrowserWindow, on: boolean): void {
  const prev = keepOnTop.get(win);
  if (prev) win.off("blur", prev);
  keepOnTop.delete(win);
  win.setAlwaysOnTop(on, "screen-saver");
  if (!on) return;
  const reassert = () => {
    if (win.isDestroyed() || !win.isAlwaysOnTop()) return;
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
  };
  win.on("blur", reassert);
  keepOnTop.set(win, reassert);
}

function popoutMenu(win: BrowserWindow): Menu {
  const displays = screen.getAllDisplays();
  return Menu.buildFromTemplate([
    {
      label: "Sempre no topo",
      type: "checkbox",
      checked: win.isAlwaysOnTop(),
      click: (item) => setPinnedOnTop(win, item.checked),
    },
    {
      label: "Mover para o monitor",
      enabled: displays.length > 1,
      submenu: displays.map((d, i) => ({
        label: `${d.label || `Monitor ${i + 1}`} (${Math.round(d.size.width * d.scaleFactor)} × ${Math.round(d.size.height * d.scaleFactor)})`,
        click: () => {
          const { x, y, width, height } = d.workArea;
          const [w, h] = win.getSize();
          win.setBounds({
            x: Math.round(x + (width - Math.min(w, width)) / 2),
            y: Math.round(y + (height - Math.min(h, height)) / 2),
            width: Math.min(w, width),
            height: Math.min(h, height),
          });
        },
      })),
    },
    { type: "separator" },
    { label: "Tela cheia", type: "checkbox", checked: win.isFullScreen(), click: () => win.setFullScreen(!win.isFullScreen()) },
    { label: "Fechar", click: () => win.close() },
  ]);
}

/** Começo do nome das janelas flutuantes (o renderer abre com ele). */
const FLOAT_PREFIX = "myscreen-float-";
const floatingWindows = new Set<BrowserWindow>();

/**
 * Janela flutuante: sempre no topo, no canto inferior direito do monitor do
 * app, e cada nova sobe um degrau acima das que já estão abertas. O botão
 * direito na barra (área de arrastar) abre o mesmo menu do resto da janela.
 */
function placeFloating(win: BrowserWindow): void {
  const main = getMainWindow();
  const display = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
  const area = display.workArea;
  const [w, h] = win.getSize();
  const margin = 16;
  let y = area.y + area.height - h - margin;
  for (const other of floatingWindows) {
    if (other.isDestroyed()) continue;
    y = Math.min(y, other.getBounds().y - h - 8);
  }
  if (y < area.y) y = area.y + area.height - h - margin;
  win.setBounds({ x: area.x + area.width - w - margin, y, width: w, height: h });
  setPinnedOnTop(win, true);
  floatingWindows.add(win);
  win.on("closed", () => floatingWindows.delete(win));
  win.on("system-context-menu", (event) => {
    event.preventDefault();
    popoutMenu(win).popup({ window: win });
  });
}

/**
 * Políticas de toda janela: nada navega para fora do app, `window.open("")`
 * (pop-out de um quadro) vira BrowserWindow com moldura nativa, links https
 * permitidos vão para o navegador padrão. O resto é negado.
 */
export function installWindowPolicies(): void {
  app.on("web-contents-created", (_event, contents: WebContents) => {
    contents.on("will-navigate", (event, url) => {
      if (!isAppUrl(url)) {
        event.preventDefault();
        openExternalSafely(url);
      }
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url, frameName }) => {
      if (url === "" || url === "about:blank") {
        // A janela flutuante não tem moldura (nem o "app://myscreen" do PiP
        // do Chromium): a página desenha a própria barra.
        const floating = frameName.startsWith(FLOAT_PREFIX);
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            icon: appImage(256),
            backgroundColor: "#000000",
            autoHideMenuBar: true,
            ...(floating ? { frame: false, minWidth: 220, minHeight: 124, alwaysOnTop: true } : {}),
            webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
          },
        };
      }
      openExternalSafely(url);
      return { action: "deny" };
    });
    contents.on("did-create-window", (child, { frameName }) => {
      child.setMenuBarVisibility(false);
      if (sharing.active && sharing.hideSelf) child.setContentProtection(true);
      child.webContents.on("context-menu", () => popoutMenu(child).popup({ window: child }));
      child.webContents.on("will-navigate", (event) => event.preventDefault());
      if (frameName.startsWith(FLOAT_PREFIX)) placeFloating(child);
    });
  });
}

// ---------------------------------------------------------------- compartilhamento

let sharing: SharingState = {
  active: false,
  kind: null,
  sourceName: "",
  displayId: null,
  trackSid: null,
  hideSelf: false,
  hasSystemAudio: false,
};
let powerBlocker: number | null = null;
const sharingListeners = new Set<() => void>();
function protectAll(on: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) win.setContentProtection(on);
}

export function setSharing(state: SharingState): void {
  const was = sharing;
  sharing = state;
  for (const fn of sharingListeners) fn();
  if (state.active) {
    if (powerBlocker === null) powerBlocker = powerSaveBlocker.start("prevent-display-sleep");
    protectAll(state.hideSelf);
  } else {
    if (powerBlocker !== null && powerSaveBlocker.isStarted(powerBlocker)) powerSaveBlocker.stop(powerBlocker);
    powerBlocker = null;
    if (was.active) protectAll(false);
  }
}

export function isSharing(): boolean {
  return sharing.active;
}

export function getSharing(): SharingState {
  return sharing;
}

export function onSharingChanged(fn: () => void): () => void {
  sharingListeners.add(fn);
  return () => sharingListeners.delete(fn);
}

