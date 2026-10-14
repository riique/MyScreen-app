/**
 * Utility process "input": carrega o addon nativo e faz o `SendInput` do
 * controle remoto. Só recebe comandos já validados pelo processo principal,
 * em pixels físicos — nunca os bytes da rede. Se cair, a sessão de controle
 * é encerrada e a sala continua.
 *
 * `MYSCREEN_INPUT_DRYRUN=1`: não carrega o addon; registra os comandos (testes
 * ponta a ponta sem mexer no mouse de quem roda o teste).
 */

import type { InjectCommand } from "../main/remoteGate";

type Native = {
  InputInjector: new () => {
    moveTo(px: number, py: number): void;
    button(button: number, down: boolean, px: number, py: number): void;
    wheel(dx: number, dy: number, px: number, py: number): void;
    key(scancode: number, down: boolean): void;
    text(s: string): void;
    releaseAll(): void;
    foreground(): { pid: number; elevated: boolean | null };
    windowPidAt(px: number, py: number): number;
    selfElevated(): boolean;
  };
  startKeyboardHook(ownPid: number, onKey: (packed: number) => void): void;
  stopKeyboardHook(): void;
};

type Command =
  | { type: "probe"; nativePath: string; dryRun: boolean; ownPid: number }
  | { type: "inject"; cmd: InjectCommand }
  | { type: "watch"; on: boolean }
  | { type: "hook"; on: boolean };

const parent = process.parentPort;

let native: Native | null = null;
let injector: InstanceType<Native["InputInjector"]> | null = null;
/** PID do processo principal do MyScreen: dono de todas as janelas do app. */
let ownPid = 0;
let hookOn = false;
let dryRun = false;
let loadError: string | null = null;
let selfElevated = false;
let watchTimer: ReturnType<typeof setInterval> | null = null;
let lastElevated = false;

function load(path: string): void {
  if (injector || loadError || dryRun) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    native = require(path) as Native;
    injector = new native.InputInjector();
    selfElevated = injector.selfElevated();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }
}

function run(cmd: InjectCommand): void {
  if (dryRun) {
    parent.postMessage({ type: "dryrun", cmd });
    return;
  }
  if (!injector) return;
  // Zona protegida exata: clique ou roda sobre uma janela do MyScreen que
  // está DE FATO sob o cursor (não só atrás de outra) não entra.
  if ((cmd.t === "button" && cmd.down) || cmd.t === "wheel") {
    if (ownPid && injector.windowPidAt(cmd.px, cmd.py) === ownPid) {
      parent.postMessage({ type: "blocked" });
      return;
    }
  }
  try {
    switch (cmd.t) {
      case "move":
        injector.moveTo(cmd.px, cmd.py);
        break;
      case "button":
        injector.button(cmd.button, cmd.down, cmd.px, cmd.py);
        break;
      case "wheel":
        injector.wheel(cmd.dx, cmd.dy, cmd.px, cmd.py);
        break;
      case "key":
        injector.key(cmd.scancode, cmd.down);
        break;
      case "text":
        injector.text(cmd.text);
        break;
      case "release":
        injector.releaseAll();
        break;
    }
  } catch (error) {
    // SendInput recusado (área de trabalho segura, UIPI): segue, mas avisa.
    parent.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * O UIPI descarta em silêncio o input enviado a uma janela de administrador
 * (o `SendInput` nem sempre devolve erro). Então olha a janela em primeiro
 * plano e avisa quando muda.
 */
function checkForeground(): void {
  if (!injector || selfElevated) return;
  const elevated = injector.foreground().elevated === true;
  if (elevated !== lastElevated) {
    lastElevated = elevated;
    parent.postMessage({ type: "elevated", on: elevated });
  }
}

/**
 * Lado de quem controla: com a tela remota focada, o hook de baixo nível
 * engole toda tecla física (Windows, Alt+Tab, Ctrl+C...) e manda ao renderer,
 * que repassa ao PC controlado. Só engole com o MyScreen em primeiro plano.
 */
function setHook(on: boolean): void {
  if (on === hookOn) return;
  if (!native || dryRun) {
    if (on) parent.postMessage({ type: "hook-error", message: loadError ?? "módulo nativo indisponível" });
    return;
  }
  try {
    if (on) {
      native.startKeyboardHook(ownPid, (packed) => {
        parent.postMessage({ type: "hookKey", scancode: packed & 0xffff, down: (packed >> 16) === 1 });
      });
    } else {
      native.stopKeyboardHook();
    }
    hookOn = on;
  } catch (error) {
    parent.postMessage({ type: "hook-error", message: error instanceof Error ? error.message : String(error) });
  }
}

parent.on("message", (event) => {
  const cmd = event.data as Command;
  switch (cmd.type) {
    case "probe":
      dryRun = cmd.dryRun;
      ownPid = cmd.ownPid;
      load(cmd.nativePath);
      parent.postMessage({ type: "probe", ok: dryRun || injector !== null, error: loadError });
      break;
    case "inject":
      run(cmd.cmd);
      break;
    case "watch":
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
      lastElevated = false;
      if (cmd.on && !dryRun) watchTimer = setInterval(checkForeground, 500);
      break;
    case "hook":
      setHook(cmd.on);
      break;
  }
});
