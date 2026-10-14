import path from "node:path";
import { app } from "electron";
import type { InjectCommand } from "./remoteGate";
import { inject, type Native } from "../input/inject";
import { nativeModulePath } from "./audio";

/**
 * Auxiliar elevado do controle remoto: o próprio MyScreen.exe, aberto como
 * administrador depois que a pessoa controlada clica em "Liberar" e aceita o
 * UAC. Sem janela, sem sala, sem nada além do `SendInput` — o UIPI só deixa
 * um processo elevado mandar input para janelas de administrador (jogos,
 * Gerenciador de Tarefas, instaladores).
 *
 * Os comandos chegam já validados pelo processo principal, uma linha JSON por
 * comando, num pipe que o nativo só aceita se o servidor for o PID recebido
 * aqui. Quando o pipe fecha (o MyScreen saiu ou desligou o acesso), sai também.
 */

export const HELPER_FLAG = "--myscreen-input-helper=";
export const PARENT_FLAG = "--myscreen-parent=";

export function inputHelperArgs(argv: readonly string[]): { pipe: string; parentPid: number } | null {
  const pipe = argv.find((a) => a.startsWith(HELPER_FLAG))?.slice(HELPER_FLAG.length);
  const parentPid = Number(argv.find((a) => a.startsWith(PARENT_FLAG))?.slice(PARENT_FLAG.length));
  if (!pipe || !/^\\\\\.\\pipe\\myscreen-input-[0-9a-f]{32}$/.test(pipe)) return null;
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null;
  return { pipe, parentPid };
}

export function runInputHelper(pipe: string, parentPid: number): void {
  // Nada de GPU nem de perfil compartilhado com o app de verdade.
  app.disableHardwareAcceleration();
  app.setPath("userData", path.join(app.getPath("temp"), "MyScreen-input-helper"));

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const native = require(nativeModulePath()) as Native;
    const injector = new native.InputInjector();
    if (!injector.selfElevated()) throw new Error("o auxiliar não está elevado");
    native.connectParentPipe(pipe, parentPid, (line) => {
      if (!line) {
        try {
          injector.releaseAll();
        } catch {
          // saindo de qualquer jeito
        }
        app.exit(0);
        return;
      }
      let cmd: InjectCommand;
      try {
        cmd = JSON.parse(line) as InjectCommand;
      } catch {
        return;
      }
      if (cmd && typeof cmd === "object" && typeof cmd.t === "string") inject(injector, parentPid, cmd);
    });
  } catch (error) {
    console.error("Auxiliar elevado do controle remoto:", error);
    app.exit(1);
  }
}
