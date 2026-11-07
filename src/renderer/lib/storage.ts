/**
 * Conveniências guardadas no próprio app (localStorage). Nunca a senha de
 * uma sala: ela vive só na memória da sessão.
 */

import { DEFAULT_MEDIA_PREFS, type MediaPrefs } from "@shared/media";

const NICKNAME_KEY = "myscreen:nickname";
const RECENT_KEY = "myscreen:recent";
const MAX_RECENT = 8;

export type RecentRoom = { id: string; title: string; at: number };

function readLocalNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * O apelido salvo nas configurações do app (em disco, sobrevive a fechar à
 * força); o localStorage fica de reserva para instalações antigas.
 */
export async function readNickname(): Promise<string> {
  try {
    const saved = (await window.myscreen.settings.get()).nickname;
    if (saved) return saved;
  } catch {
    // Cai no localStorage.
  }
  return readLocalNickname();
}

/** Últimos estados de mídia (em disco, junto do apelido). */
export async function readMediaPrefs(): Promise<MediaPrefs> {
  try {
    return (await window.myscreen.settings.get()).media ?? DEFAULT_MEDIA_PREFS;
  } catch {
    return DEFAULT_MEDIA_PREFS;
  }
}

export function writeMediaPrefs(patch: Partial<MediaPrefs>): void {
  void window.myscreen.settings.set({ media: patch }).catch(() => {});
}

export function writeNickname(nickname: string): void {
  try {
    localStorage.setItem(NICKNAME_KEY, nickname);
  } catch {
    // Lembrar o apelido é conveniência, não requisito.
  }
  void window.myscreen.settings.set({ nickname }).catch(() => {});
}

export function parseRecent(raw: string | null): RecentRoom[] {
  try {
    const list: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (r): r is RecentRoom =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as RecentRoom).id === "string" &&
          /^[a-z0-9_-]{1,64}$/.test((r as RecentRoom).id) &&
          typeof (r as RecentRoom).title === "string" &&
          typeof (r as RecentRoom).at === "number",
      )
      .map((r) => ({ id: r.id, title: r.title.slice(0, 120), at: r.at }))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function readRecent(): RecentRoom[] {
  try {
    return parseRecent(localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

/** Só id e título — a senha nunca entra aqui. */
export function rememberRoom(id: string, title: string): void {
  const next = [{ id, title, at: Date.now() }, ...readRecent().filter((r) => r.id !== id)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Sem storage, a lista só não cresce.
  }
}

export function forgetRoom(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(readRecent().filter((r) => r.id !== id)));
  } catch {
    // idem
  }
}

// ---------------------------------------------------------------- volumes por pessoa

const SCREEN_VOLUMES_KEY = "myscreen:screen-volumes";
const VOICE_VOLUMES_KEY = "myscreen:voice-volumes";
const MAX_VOLUMES = 64;
/** A voz pode passar de 100%: o som da sala sai por Web Audio, com ganho. */
export const MAX_VOICE_VOLUME = 2;

function validVolume(v: unknown, max = 1): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
}

/** De quem é o volume: o nome sobrevive entre reuniões; a identidade, não. */
export function screenVolumeKey(p: { name?: string; identity: string }): string {
  const name = p.name?.trim().toLowerCase();
  return name ? `name:${name}` : `id:${p.identity}`;
}

function readVolumes(store: string, max: number): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(store) ?? "{}");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (validVolume(v, max)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function writeVolume(store: string, max: number, key: string, volume: number): void {
  try {
    const all = readVolumes(store, max);
    delete all[key];
    all[key] = volume;
    // Mais recentes no fim: corta os mais antigos.
    const entries = Object.entries(all).slice(-MAX_VOLUMES);
    localStorage.setItem(store, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Sem storage, o volume vale só para esta sessão.
  }
}

/** Volume guardado para o som da tela dessa pessoa; sem um, 100%. */
export function readScreenVolume(key: string): number {
  const own = readVolumes(SCREEN_VOLUMES_KEY, 1)[key];
  return validVolume(own) ? own : 1;
}

export function writeScreenVolume(key: string, volume: number): void {
  writeVolume(SCREEN_VOLUMES_KEY, 1, key, volume);
}

/** Volume guardado para a voz (microfone) dessa pessoa; sem um, 100%. */
export function readVoiceVolume(key: string): number {
  const own = readVolumes(VOICE_VOLUMES_KEY, MAX_VOICE_VOLUME)[key];
  return validVolume(own, MAX_VOICE_VOLUME) ? own : 1;
}

export function writeVoiceVolume(key: string, volume: number): void {
  writeVolume(VOICE_VOLUMES_KEY, MAX_VOICE_VOLUME, key, volume);
}
