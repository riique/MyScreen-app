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
import { inject, type Native } from "./inject";

type Command =
  | { type: "probe"; nativePath: string; dryRun: boolean; ownPid: number }
  | { type: "inject"; cmd: InjectCommand }
  /** Com o auxiliar elevado: só a zona protegida é conferida aqui; o resto volta ao main. */
  | { type: "check"; cmd: InjectCommand }
  | { type: "watch"; on: boolean }
  | { type: "hook"; on: boolean }
  /** Lado controlado: avisa quando a dona do PC mexe no mouse de verdade. */
  | { type: "localWatch"; on: boolean }
  | { type: "elevate"; exe: string; args: string; hwnd: number };

const parent = process.parentPort;

let native: Native | null = null;
let injector: InstanceType<Native["InputInjector"]> | null = null;
/** PID do processo principal do MyScreen: dono de todas as janelas do app. */
let ownPid = 0;
let hookOn = false;
let localWatchOn = false;
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
  const result = inject(injector, ownPid, cmd);
  if (result === "blocked") parent.postMessage({ type: "blocked" });
  else if (result !== "ok") parent.postMessage({ type: "error", message: result.error });
}

/**
 * Com o auxiliar elevado ligado, todo comando passa por aqui antes (na ordem)
 * só para conferir a zona protegida e avisar do clique bloqueado.
 */
function check(cmd: InjectCommand): void {
  if (injector && ((cmd.t === "button" && cmd.down) || cmd.t === "wheel")) {
    if (ownPid && injector.windowPidAt(cmd.px, cmd.py) === ownPid) {
      parent.postMessage({ type: "blocked" });
      return;
    }
  }
  parent.postMessage({ type: "forward", cmd });
}

/** Pede o UAC para subir o auxiliar elevado. Fora da thread do JS: o UAC espera a pessoa. */
function elevate(exe: string, args: string, hwnd: number): void {
  if (!native) {
    parent.postMessage({ type: "elevate", ok: false, error: loadError ?? "módulo nativo indisponível" });
    return;
  }
  native.runElevated(exe, args, hwnd).then(
    (ok) => parent.postMessage({ type: "elevate", ok, error: null }),
    (error: unknown) =>
      parent.postMessage({ type: "elevate", ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
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

/**
 * Lado controlado: o hook de mouse só observa. Cada aviso (no máximo a cada
 * 100 ms) diz ao portão que a pessoa do PC está usando o mouse agora.
 */
function setLocalWatch(on: boolean): void {
  if (on === localWatchOn || !native || dryRun) return;
  try {
    if (on) native.startMouseWatch(() => parent.postMessage({ type: "localMouse" }));
    else native.stopMouseWatch();
    localWatchOn = on;
  } catch (error) {
    parent.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
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
    case "check":
      check(cmd.cmd);
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
    case "localWatch":
      setLocalWatch(cmd.on);
      break;
    case "elevate":
      elevate(cmd.exe, cmd.args, cmd.hwnd);
      break;
  }
});
