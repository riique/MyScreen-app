import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

/** Origem do renderer empacotado. */
export const APP_SCHEME = "app";
export const APP_HOST = "myscreen";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** Em desenvolvimento o renderer vem do servidor do Vite. */
export const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || null;

function devOrigin(): string | null {
  if (!DEV_SERVER_URL) return null;
  try {
    return new URL(DEV_SERVER_URL).origin;
  } catch {
    return null;
  }
}

/** A URL pertence ao próprio app (protocolo app:// ou, em dev, o Vite)? */
export function isAppUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  if (url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`)) return true;
  const dev = devOrigin();
  return dev !== null && (url === dev || url.startsWith(`${dev}/`));
}

/**
 * Todo `ipcMain.handle` passa por aqui: só o frame principal das páginas do
 * app fala com o processo principal. Um pop-out `about:blank` ou qualquer
 * conteúdo navegado por engano não chega a nenhum handler.
 */
export function assertAppSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const url = event.senderFrame?.url;
  if (!isAppUrl(url)) {
    throw new Error(`IPC recusado de ${url ?? "remetente desconhecido"}`);
  }
}

// ---------------------------------------------------------------- validação

export function asString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new TypeError(`${name}: esperado texto`);
  if (value.length > max) throw new RangeError(`${name}: longo demais`);
  return value;
}

export function asOptionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return asString(value, name, max);
}

export function asBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name}: esperado booleano`);
  return value;
}

export function asNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name}: esperado número`);
  if (value < min || value > max) throw new RangeError(`${name}: fora do intervalo`);
  return value;
}

export function asObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name}: esperado objeto`);
  }
  return value as Record<string, unknown>;
}

/**
 * URL de servidor aceita nas configurações: https em qualquer host, http só
 * para máquina local (desenvolvimento do site). Devolve a origem sem barra.
 */
export function normalizeServerUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password) return null;
  return url.origin;
}
