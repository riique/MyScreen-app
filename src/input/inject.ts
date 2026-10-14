/**
 * O `SendInput` de um comando já validado, comum ao utility "input" e ao
 * auxiliar elevado (que entra quando a pessoa controlada libera as janelas de
 * administrador).
 */

import type { InjectCommand } from "../main/remoteGate";

export type Injector = {
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

export type Native = {
  InputInjector: new () => Injector;
  startKeyboardHook(ownPid: number, onKey: (packed: number) => void): void;
  stopKeyboardHook(): void;
  runElevated(exe: string, args: string, hwnd: number): Promise<boolean>;
  connectParentPipe(path: string, serverPid: number, onLine: (line: string) => void): void;
};

export type InjectResult = "ok" | "blocked" | { error: string };

/**
 * `ownPid`: PID do processo principal do MyScreen, dono de todas as janelas do
 * app. Clique ou roda sobre uma janela dele que está DE FATO sob o cursor
 * (não só atrás de outra) não entra.
 */
export function inject(injector: Injector, ownPid: number, cmd: InjectCommand): InjectResult {
  if ((cmd.t === "button" && cmd.down) || cmd.t === "wheel") {
    if (ownPid && injector.windowPidAt(cmd.px, cmd.py) === ownPid) return "blocked";
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
    return "ok";
  } catch (error) {
    // SendInput recusado (área de trabalho segura, UIPI): segue, mas avisa.
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
