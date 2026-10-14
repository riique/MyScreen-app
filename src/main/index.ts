import { app, dialog } from "electron";
import { shutdownAudio } from "./audio";
import { installDisplayMediaHandler } from "./capture";
import { createTray, destroyTray, getRoomState, handleArgv, hintTray, registerProtocolClient } from "./integration";
import { installPermissionHandlers, registerIpc } from "./ipc";
import { handleAppProtocol, registerSchemePrivileges } from "./protocol";
import { DEV_SERVER_URL } from "./security";
import { startUpdater } from "./updater";
import { createMainWindow, getMainWindow, installWindowPolicies, showMainWindow } from "./windows";

/**
 * MyScreen para Windows — processo principal.
 *
 * Uma instância só: abrir um `myscreen://room/<id>` com o app aberto foca a
 * janela existente e leva a ela o link.
 *
 * O X da janela não fecha o app: esconde a janela e o MyScreen segue nos ícones
 * ocultos da bandeja. Sair de verdade é pelo "Sair" do menu da bandeja.
 */

/** Saída de verdade em curso (menu da bandeja, atualização, desligar o PC). */
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId("com.myscreen.desktop");
  registerSchemePrivileges();
  // O Chromium usa o Windows Graphics Capture quando disponível (60 FPS
  // estáveis, janela por trás de outras). Pedir explicitamente não custa nada.
  app.commandLine.appendSwitch("enable-features", "AllowWgcScreenCapturer,AllowWgcWindowCapturer");

  app.on("second-instance", (_event, argv) => {
    showMainWindow();
    handleArgv(argv);
  });

  app.whenReady().then(() => {
    if (!DEV_SERVER_URL) handleAppProtocol();
    installPermissionHandlers();
    installDisplayMediaHandler();
    installWindowPolicies();
    registerIpc();
    registerProtocolClient();

    const win = createMainWindow();
    win.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      win.hide();
      hintTray();
    });
    // Desligar ou sair da conta no Windows: não segura o sistema esperando a janela.
    win.on("session-end", () => {
      quitting = true;
    });

    createTray();
    handleArgv(process.argv);
    startUpdater();
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (!quitting && getRoomState().inRoom) {
      const win = getMainWindow();
      const options = {
        type: "question" as const,
        buttons: ["Sair", "Cancelar"],
        defaultId: 1,
        cancelId: 1,
        title: "MyScreen",
        message: "Você está numa sala.",
        detail: "Sair do MyScreen tira você da chamada.",
      };
      const choice = win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
      if (choice !== 0) {
        event.preventDefault();
        return;
      }
    }
    quitting = true;
    shutdownAudio();
    destroyTray();
  });
  app.on("activate", () => {
    if (!getMainWindow()) createMainWindow();
  });
}
