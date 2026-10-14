import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { AppSettings } from "../shared/ipc";
import { normalizeServerUrl } from "./security";

/**
 * Configurações do app, num JSON em `userData`. O apelido mora aqui, e não
 * só no localStorage, porque o Chromium grava o localStorage com atraso e
 * perde a escrita quando o app é fechado à força. Nunca guarda senha de sala:
 * ela vive só na memória da sessão, para o refresh do token.
 */

declare const __MYSCREEN_SERVER_URL__: string;

export const DEFAULT_SERVER_URL =
  normalizeServerUrl(process.env.MYSCREEN_SERVER_URL || __MYSCREEN_SERVER_URL__) ?? "https://myscreen.haumea.fun";

const DEFAULTS: AppSettings = {
  serverUrl: DEFAULT_SERVER_URL,
  shortcutsEnabled: true,
  nickname: "",
  autoDownloadUpdates: true,
};

let current: AppSettings | null = null;

function file(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function parse(raw: unknown): AppSettings {
  const out = { ...DEFAULTS };
  if (typeof raw !== "object" || raw === null) return out;
  const v = raw as Record<string, unknown>;
  if (typeof v.serverUrl === "string") out.serverUrl = normalizeServerUrl(v.serverUrl) ?? DEFAULTS.serverUrl;
  if (typeof v.shortcutsEnabled === "boolean") out.shortcutsEnabled = v.shortcutsEnabled;
  if (typeof v.autoDownloadUpdates === "boolean") out.autoDownloadUpdates = v.autoDownloadUpdates;
  if (typeof v.nickname === "string") out.nickname = v.nickname.trim().slice(0, 64);
  return out;
}

export function getSettings(): AppSettings {
  if (current) return current;
  try {
    current = parse(JSON.parse(readFileSync(file(), "utf8")));
  } catch {
    current = { ...DEFAULTS };
  }
  return current;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = parse({ ...getSettings(), ...patch });
  current = next;
  try {
    mkdirSync(path.dirname(file()), { recursive: true });
    // Grava num temporário e renomeia: um crash no meio não deixa JSON pela metade.
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, file());
  } catch (error) {
    console.error("Não foi possível salvar as configurações:", error);
  }
  return next;
}
