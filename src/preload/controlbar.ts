import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ControlBarBridge, ControlBarState } from "../shared/ipc";

/**
 * Preload da barra "Fulano está controlando": só parar e pausar. A barra
 * não tem acesso a nenhuma outra parte do app.
 */
const bridge: ControlBarBridge = {
  stop: () => ipcRenderer.send("remote:stop"),
  pause: (paused) => ipcRenderer.send("remote:pause", paused === true),
  onState: (cb) => {
    const listener = (_event: IpcRendererEvent, state: ControlBarState) => cb(state);
    ipcRenderer.on("bar:state", listener);
    return () => ipcRenderer.removeListener("bar:state", listener);
  },
};

contextBridge.exposeInMainWorld("myscreenBar", bridge);
