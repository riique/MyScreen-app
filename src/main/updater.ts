import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "../shared/ipc";
import { getRoomState } from "./integration";
import { getSettings } from "./settings";
import { getMainWindow } from "./windows";

/**
 * Atualização servida pelo próprio servidor (`<servidor>/downloads/latest.yml`).
 * Com "baixar automaticamente" ligado, baixa em segundo plano; desligado, só
 * avisa e espera o botão "Baixar". NUNCA instala no meio de uma chamada: a home
 * mostra "Reiniciar e atualizar", e sair do app também aplica.
 */

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let status: UpdateStatus = { state: "idle" };
let started = false;
/** A verificação em curso foi pedida no botão: erro e "nada novo" viram aviso. */
let manualCheck = false;

function publish(next: UpdateStatus): void {
  status = next;
  getMainWindow()?.webContents.send("updates:status", status);
}

export function updateStatus(): UpdateStatus {
  return status;
}

export function configureFeed(): void {
  autoUpdater.setFeedURL({ provider: "generic", url: `${getSettings().serverUrl}/downloads/` });
}

/** Segue a configuração; ligar com uma versão já encontrada começa o download. */
export function applyAutoDownload(): void {
  if (!started) return;
  autoUpdater.autoDownload = getSettings().autoDownloadUpdates;
  if (autoUpdater.autoDownload && status.state === "available") downloadUpdate();
}

export function startUpdater(): void {
  if (!app.isPackaged) return;
  started = true;
  autoUpdater.autoDownload = getSettings().autoDownloadUpdates;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;
  configureFeed();

  autoUpdater.on("checking-for-update", () => {
    if (status.state !== "ready" && status.state !== "downloading") publish({ state: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    manualCheck = false;
    publish(
      autoUpdater.autoDownload ? { state: "downloading", percent: 0 } : { state: "available", version: info.version },
    );
  });
  autoUpdater.on("download-progress", (p) => publish({ state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => publish({ state: "ready", version: info.version }));
  autoUpdater.on("update-not-available", () => {
    manualCheck = false;
    publish({ state: "uptodate", checkedAt: Date.now() });
  });
  autoUpdater.on("error", (error) => {
    console.warn("Atualização falhou:", error);
    if (status.state === "ready") return;
    // A checagem de fundo falhar é rotina (servidor fora do ar): só o botão vira aviso.
    publish(manualCheck ? { state: "error", message: "Não foi possível falar com o servidor de atualizações." } : { state: "idle" });
    manualCheck = false;
  });

  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_EVERY_MS);
}

/** O botão "Verificar atualizações". */
export function checkForUpdates(): void {
  if (!started) {
    publish({ state: "error", message: "Atualizações só funcionam no app instalado." });
    return;
  }
  if (status.state === "checking" || status.state === "downloading" || status.state === "ready") return;
  manualCheck = true;
  void autoUpdater.checkForUpdates().catch(() => {});
}

export function downloadUpdate(): void {
  if (!started || status.state !== "available") return;
  publish({ state: "downloading", percent: 0 });
  void autoUpdater.downloadUpdate().catch(() => {});
}

export function installUpdate(): void {
  if (status.state !== "ready" || getRoomState().inRoom) return;
  autoUpdater.quitAndInstall(false, true);
}
