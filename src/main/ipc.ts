import { app, ipcMain, session } from "electron";
import type { SharingState, SystemAudioMode, ThemePreference } from "../shared/ipc";
import { audioCapabilities, startAudio, stopAudio, updateAudio } from "./audio";
import { listCaptureSources, selectCaptureSource } from "./capture";
import { consumePendingRoom, notify, refreshShortcuts, setRoomState } from "./integration";
import {
  asBoolean,
  asNumber,
  asObject,
  asOptionalString,
  asString,
  assertAppSender,
  isAppUrl,
  normalizeServerUrl,
} from "./security";
import { createRoom, desktopInfo, getRoom, token } from "./server";
import { getSettings, updateSettings } from "./settings";
import { applyAutoDownload, checkForUpdates, configureFeed, downloadUpdate, installUpdate, updateStatus } from "./updater";
import { applyTheme, getMainWindow, openExternalSafely, setSharing } from "./windows";
import { normalizeRoomId } from "../shared/room";

// ---------------------------------------------------------------- permissões

/** Só estas permissões existem para o app; todo o resto é negado. */
const ALLOWED = new Set([
  "media",
  "display-capture",
  "fullscreen",
  "clipboard-sanitized-write",
  "notifications",
  "speaker-selection",
]);

export function installPermissionHandlers(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    // Tela cheia vale também para os pop-outs (about:blank) de um quadro.
    if (permission === "fullscreen") return callback(true);
    callback(ALLOWED.has(permission) && isAppUrl(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (permission === "fullscreen") return true;
    return ALLOWED.has(permission) && isAppUrl(origin);
  });
}

// ---------------------------------------------------------------- handlers

function parseAudioMode(raw: unknown): SystemAudioMode {
  const v = asObject(raw, "mode");
  switch (v.kind) {
    case "off":
      return { kind: "off" };
    case "system-except-self":
      return { kind: "system-except-self", alsoExcludeDiscord: v.alsoExcludeDiscord === true };
    case "window-only":
      return { kind: "window-only", sourceId: asString(v.sourceId, "sourceId", 64) };
    default:
      throw new TypeError("modo de som inválido");
  }
}

function parseRoomId(raw: unknown): string {
  const id = normalizeRoomId(asString(raw, "roomId", 200));
  if (!id) throw new TypeError("roomId vazio");
  return id;
}

export function registerIpc(): void {
  // Atalho: handle com remetente validado.
  const handle = (channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      assertAppSender(event);
      return fn(event, ...args);
    });
  const on = (channel: string, fn: (event: Electron.IpcMainEvent, ...args: unknown[]) => void) =>
    ipcMain.on(channel, (event, ...args) => {
      try {
        assertAppSender(event);
        fn(event, ...args);
      } catch (error) {
        console.warn(`IPC ${channel} recusado:`, error);
      }
    });

  // --- app
  handle("app:info", () => ({ version: app.getVersion(), platform: process.platform, isPackaged: app.isPackaged }));
  handle("app:consumePendingRoom", () => consumePendingRoom());
  on("app:setTheme", (_e, effective, preference) => {
    const eff = effective === "dark" ? "dark" : "light";
    const pref: ThemePreference = preference === "dark" || preference === "light" ? preference : "system";
    applyTheme(eff, pref);
  });
  on("app:openPrivacy", (_e, kind) => {
    openExternalSafely(kind === "microphone" ? "ms-settings:privacy-microphone" : "ms-settings:privacy-webcam");
  });
  on("app:openExternal", (_e, url) => openExternalSafely(asString(url, "url", 2048)));

  // --- configurações
  handle("settings:get", () => getSettings());
  handle("settings:set", (_e, raw) => {
    const patch = asObject(raw, "settings");
    const next: Record<string, unknown> = {};
    if (patch.serverUrl !== undefined) {
      const url = normalizeServerUrl(asString(patch.serverUrl, "serverUrl", 512));
      if (!url) {
        return {
          ok: false,
          error: "Endereço inválido. Use https://seu-dominio (http só para localhost).",
          field: "serverUrl",
          status: 400,
          retryAfter: null,
        };
      }
      next.serverUrl = url;
    }
    if (patch.shortcutsEnabled !== undefined) next.shortcutsEnabled = asBoolean(patch.shortcutsEnabled, "shortcutsEnabled");
    if (patch.nickname !== undefined) next.nickname = asString(patch.nickname, "nickname", 64);
    if (patch.autoDownloadUpdates !== undefined) {
      next.autoDownloadUpdates = asBoolean(patch.autoDownloadUpdates, "autoDownloadUpdates");
    }
    const saved = updateSettings(next);
    refreshShortcuts();
    if (next.serverUrl && app.isPackaged) configureFeed();
    if (next.autoDownloadUpdates !== undefined) applyAutoDownload();
    return { ok: true, data: saved };
  });

  // --- API do servidor
  handle("api:createRoom", (_e, raw) => {
    const v = asObject(raw, "input");
    return createRoom({
      title: asString(v.title ?? "", "title", 120),
      password: asOptionalString(v.password, "password", 200),
    });
  });
  handle("api:getRoom", (_e, id) => getRoom(parseRoomId(id)));
  handle("api:token", (_e, raw) => {
    const v = asObject(raw, "input");
    return token({
      roomId: parseRoomId(v.roomId),
      nickname: asString(v.nickname, "nickname", 64),
      password: asOptionalString(v.password, "password", 200),
      participantIdentity: asOptionalString(v.participantIdentity, "participantIdentity", 64),
    });
  });
  handle("api:desktopInfo", () => desktopInfo());

  // --- captura
  handle("capture:list", () => listCaptureSources());
  handle("capture:select", (_e, id, raw) => {
    const opts = asObject(raw ?? {}, "options");
    selectCaptureSource(asString(id, "sourceId", 64), opts.loopbackAudio === true);
  });

  // --- som do sistema
  handle("audio:capabilities", () => audioCapabilities());
  handle("audio:start", (event, id, mode, raw) => {
    const opts = asObject(raw, "options");
    return startAudio(event.sender, asString(id, "id", 64), parseAudioMode(mode), {
      normalize: asBoolean(opts.normalize, "normalize"),
      gainPct: asNumber(opts.gainPct, "gainPct", 0, 400),
    });
  });
  on("audio:update", (_e, raw) => {
    const v = asObject(raw, "patch");
    updateAudio({
      normalize: typeof v.normalize === "boolean" ? v.normalize : undefined,
      gainPct: typeof v.gainPct === "number" ? asNumber(v.gainPct, "gainPct", 0, 400) : undefined,
      paused: typeof v.paused === "boolean" ? v.paused : undefined,
    });
  });
  on("audio:stop", () => stopAudio());

  // --- sala
  on("room:setState", (_e, raw) => {
    const v = asObject(raw, "state");
    setRoomState({
      inRoom: v.inRoom === true,
      micOn: v.micOn === true,
      camOn: v.camOn === true,
      sharing: v.sharing === true,
    });
  });
  on("room:setSharing", (_e, raw) => {
    const v = asObject(raw, "sharing");
    const state: SharingState = {
      active: v.active === true,
      sourceName: typeof v.sourceName === "string" ? v.sourceName.slice(0, 200) : "",
      displayId: typeof v.displayId === "string" ? v.displayId.slice(0, 64) : null,
      hideSelf: v.hideSelf === true,
      hasSystemAudio: v.hasSystemAudio === true,
    };
    setSharing(state);
  });
  on("room:notify", (_e, title, body) => {
    notify(asString(title, "title", 200), asString(body, "body", 500));
  });

  // --- atualização
  handle("updates:status", () => updateStatus());
  on("updates:check", () => checkForUpdates());
  on("updates:download", () => downloadUpdate());
  on("updates:install", () => installUpdate());

}
