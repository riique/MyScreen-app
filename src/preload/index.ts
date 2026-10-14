import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { AUDIO_PORT_MESSAGE, type DesktopBridge } from "../shared/ipc";

/**
 * A ponte `window.myscreen`: funções estreitas sobre o IPC. O renderer nunca
 * vê o `ipcRenderer`.
 */

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// A MessagePort do PCM não atravessa o contextBridge: vai por postMessage
// para o mundo principal, que a entrega ao AudioWorklet.
ipcRenderer.on("audio:port", (event, id: string) => {
  window.postMessage({ type: AUDIO_PORT_MESSAGE, id }, "*", event.ports);
});

const bridge: DesktopBridge = {
  app: {
    info: () => ipcRenderer.invoke("app:info"),
    consumePendingRoom: () => ipcRenderer.invoke("app:consumePendingRoom"),
    onNavigate: (cb) => subscribe("app:navigate", cb),
    setTheme: (effective, preference) => ipcRenderer.send("app:setTheme", effective, preference),
    openPrivacySettings: (kind) => ipcRenderer.send("app:openPrivacy", kind),
    openExternal: (url) => ipcRenderer.send("app:openExternal", url),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },
  api: {
    createRoom: (input) => ipcRenderer.invoke("api:createRoom", input),
    getRoom: (id) => ipcRenderer.invoke("api:getRoom", id),
    token: (input) => ipcRenderer.invoke("api:token", input),
    desktopInfo: () => ipcRenderer.invoke("api:desktopInfo"),
  },
  capture: {
    list: () => ipcRenderer.invoke("capture:list"),
    select: (id, options) => ipcRenderer.invoke("capture:select", id, options),
  },
  audio: {
    capabilities: () => ipcRenderer.invoke("audio:capabilities"),
    start: (id, mode, options) => ipcRenderer.invoke("audio:start", id, mode, options),
    update: (patch) => ipcRenderer.send("audio:update", patch),
    stop: () => ipcRenderer.send("audio:stop"),
    onLevel: (cb) => subscribe("audio:level", cb),
    onLost: (cb) => subscribe("audio:lost", cb),
    onError: (cb) => subscribe("audio:error", cb),
  },
  room: {
    setState: (state) => ipcRenderer.send("room:setState", state),
    setSharing: (state) => ipcRenderer.send("room:setSharing", state),
    notify: (title, body) => ipcRenderer.send("room:notify", title, body),
    onShortcut: (cb) => subscribe("room:shortcut", cb),
    onLeaveRequest: (cb) => subscribe("room:leave", cb),
    onStopShareRequest: (cb) => subscribe("room:stopShare", cb),
    onAudioPauseChanged: (cb) => subscribe("room:audioPaused", cb),
  },
  updates: {
    status: () => ipcRenderer.invoke("updates:status"),
    onStatus: (cb) => subscribe("updates:status", cb),
    check: () => ipcRenderer.send("updates:check"),
    download: () => ipcRenderer.send("updates:download"),
    install: () => ipcRenderer.send("updates:install"),
  },
};

contextBridge.exposeInMainWorld("myscreen", bridge);
