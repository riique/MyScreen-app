/**
 * Conveniências guardadas no próprio app (localStorage). Nunca a senha de
 * uma sala: ela vive só na memória da sessão.
 */

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
