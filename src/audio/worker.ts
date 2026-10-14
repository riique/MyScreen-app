/**
 * Utility process "audio": carrega o addon nativo e entrega o PCM direto ao
 * renderer por uma MessagePort. Se este processo cair, a sala continua e a
 * tela segue sem som.
 */

import type { MessagePortMain } from "electron";

type Native = {
  SystemAudioCapture: new (
    options: { mode: string; pids: number[]; excludeNames?: string[]; normalize?: boolean; gainPct?: number },
    onPcm: (pcm: Buffer) => void,
    onError: (message: string) => void,
  ) => {
    update(update: { normalize?: boolean; gainPct?: number }): void;
    level(): number;
    agcDb(): number;
    stop(): void;
  };
  pidFromHwnd(hwnd: number): number;
};

type Command =
  | { type: "probe"; nativePath: string }
  | {
      type: "start";
      mode: "exclude" | "include";
      pids: number[];
      hwnd: string | null;
      excludeNames: string[];
      normalize: boolean;
      gainPct: number;
    }
  | { type: "update"; normalize?: boolean; gainPct?: number; paused?: boolean }
  | { type: "stop" };

const parent = process.parentPort;

let native: Native | null = null;
let nativeError: string | null = null;
let capture: InstanceType<Native["SystemAudioCapture"]> | null = null;
let port: MessagePortMain | null = null;
let paused = false;
let levelTimer: ReturnType<typeof setInterval> | null = null;

function loadNative(path: string): void {
  if (native || nativeError) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    native = require(path) as Native;
  } catch (error) {
    nativeError = error instanceof Error ? error.message : String(error);
  }
}

function stop(): void {
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
  try {
    capture?.stop();
  } catch {
    // Parar é melhor-esforço: o processo pode estar saindo.
  }
  capture = null;
  port?.close();
  port = null;
  paused = false;
}

function start(cmd: Extract<Command, { type: "start" }>, newPort: MessagePortMain | undefined): void {
  stop();
  if (!native) {
    parent.postMessage({ type: "start-error", message: nativeError ?? "módulo nativo não carregado" });
    return;
  }
  if (!newPort) {
    parent.postMessage({ type: "start-error", message: "porta de áudio ausente" });
    return;
  }
  let pids = cmd.pids;
  if (cmd.mode === "include") {
    const pid = cmd.hwnd ? native.pidFromHwnd(Number(cmd.hwnd)) : 0;
    if (!pid) {
      newPort.close();
      parent.postMessage({ type: "start-error", message: "A janela escolhida não existe mais." });
      return;
    }
    pids = [pid];
  }
  port = newPort;
  port.start();
  const out = port;
  try {
    capture = new native.SystemAudioCapture(
      { mode: cmd.mode, pids, excludeNames: cmd.excludeNames, normalize: cmd.normalize, gainPct: cmd.gainPct },
      (pcm) => {
        // Pausado: nada sai; o worklet do renderer toca silêncio sozinho.
        if (paused) return;
        out.postMessage(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
      },
      (message) => parent.postMessage({ type: "error", message }),
    );
  } catch (error) {
    stop();
    parent.postMessage({ type: "start-error", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  levelTimer = setInterval(() => {
    if (!capture) return;
    parent.postMessage({ type: "level", level: paused ? 0 : capture.level(), agcDb: capture.agcDb() });
  }, 100);
  parent.postMessage({ type: "started" });
}

parent.on("message", (event) => {
  const cmd = event.data as Command;
  switch (cmd.type) {
    case "probe":
      loadNative(cmd.nativePath);
      parent.postMessage({ type: "probe", ok: native !== null, error: nativeError });
      break;
    case "start":
      start(cmd, event.ports[0]);
      break;
    case "update":
      if (typeof cmd.paused === "boolean") paused = cmd.paused;
      capture?.update({ normalize: cmd.normalize, gainPct: cmd.gainPct });
      break;
    case "stop":
      stop();
      break;
  }
});
