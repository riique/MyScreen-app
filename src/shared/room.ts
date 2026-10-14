/**
 * Regras de id de sala, link de convite e deep link. Puras, sem DOM nem
 * Electron: valem para o processo principal, o renderer e os testes.
 */

/** Teto de um id de sala (o servidor aceita até 64). */
export const MAX_ROOM_ID_LENGTH = 64;

/** Forma canônica de um id de sala: minúsculo, sem espaço nas pontas, com teto. */
export function normalizeRoomId(raw: string): string {
  return raw.trim().toLowerCase().slice(0, MAX_ROOM_ID_LENGTH);
}

/**
 * Aceita o código ou o link colado (igual à home do site): o que vem depois de
 * `/room/`, cortado em `?` ou `#`. Devolve null quando não sobra nada usável.
 */
export function parseRoomInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let code = text;
  if (text.includes("/room/")) {
    code = text.split("/room/")[1] ?? "";
  }
  code = code.split(/[?#]/)[0].replace(/\/+$/, "");
  try {
    code = decodeURIComponent(code);
  } catch {
    // Percent-encoding quebrado: usa como veio.
  }
  const id = normalizeRoomId(code);
  return id && /^[a-z0-9_-]+$/.test(id) ? id : null;
}

/** `myscreen://room/<id>` → id. Qualquer outra forma é ignorada. */
export function parseDeepLink(url: string): string | null {
  if (!url.toLowerCase().startsWith("myscreen://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // `myscreen://room/abc` → host "room", pathname "/abc".
  const path = `${parsed.host}${parsed.pathname}`.replace(/^\/+/, "");
  const match = /^room\/([^/?#]+)\/?$/i.exec(path);
  return match ? parseRoomInput(match[1]) : null;
}

/** Link de convite: sempre a URL web, que funciona para quem não tem o app. */
export function inviteUrl(serverUrl: string, roomId: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/room/${encodeURIComponent(roomId)}`;
}

/** Compara versões x.y.z (ignora sufixos). -1, 0 ou 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
