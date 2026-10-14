import { app, net } from "electron";
import type { ApiResult, RoomInfo, TokenResponse } from "../shared/ipc";
import { getSettings } from "./settings";

/**
 * Cliente HTTP do servidor MyScreen. O renderer não faz `fetch` direto: a
 * origem dele é app://myscreen e o Next não manda CORS. Aqui a URL do servidor
 * mora num lugar só e as respostas chegam validadas e com erro padronizado.
 */

const TIMEOUT_MS = 15_000;

function fail<T>(status: number, error: string, field: string | null = null, retryAfter: number | null = null): ApiResult<T> {
  return { ok: false, status, error, field, retryAfter };
}

async function request(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; data: unknown; retryAfter: number | null }> {
  const url = `${getSettings().serverUrl}${path}`;
  const res = await net.fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      "User-Agent": `MyScreenDesktop/${app.getVersion()}`,
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const ra = Number(res.headers.get("retry-after"));
  return { status: res.status, data, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null };
}

function errorFrom<T>(status: number, data: unknown, retryAfter: number | null, fallback: string): ApiResult<T> {
  const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const message = typeof d.error === "string" && d.error ? d.error : fallback;
  const field = typeof d.field === "string" ? d.field : null;
  return fail(status, message, field, retryAfter);
}

function networkError<T>(error: unknown): ApiResult<T> {
  console.error("Servidor inacessível:", error);
  const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return fail(
    0,
    timeout
      ? "O servidor demorou demais para responder. Verifique sua conexão e tente de novo."
      : `Não foi possível falar com o servidor (${getSettings().serverUrl}). Verifique sua conexão ou o endereço em Configurações.`,
  );
}

function asRoom(raw: unknown, fallbackId: string, exists: boolean): RoomInfo {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : fallbackId;
  return {
    id,
    title: typeof r.title === "string" && r.title ? r.title : `Sala ${id}`,
    isLocked: r.isLocked === true,
    exists,
  };
}

export async function createRoom(input: { title: string; password?: string }): Promise<ApiResult<RoomInfo>> {
  try {
    const { status, data, retryAfter } = await request("/api/rooms", {
      method: "POST",
      body: { title: input.title.trim() || "Reunião instantânea", password: input.password || undefined },
    });
    if (status < 200 || status >= 300) return errorFrom(status, data, retryAfter, "Falha ao criar a sala.");
    const room = (data as { room?: unknown } | null)?.room;
    const info = asRoom(room, "", true);
    if (!info.id) return fail(502, "O servidor respondeu sem o código da sala.");
    return { ok: true, data: info };
  } catch (error) {
    return networkError(error);
  }
}

export async function getRoom(id: string): Promise<ApiResult<RoomInfo>> {
  try {
    const { status, data, retryAfter } = await request(`/api/rooms/${encodeURIComponent(id)}`);
    if (status < 200 || status >= 300) return errorFrom(status, data, retryAfter, `Falha ao carregar a sala (${status}).`);
    const d = (data ?? {}) as { exists?: unknown; room?: unknown };
    // Sala inexistente é sala efêmera válida: só precisa de um título.
    return { ok: true, data: asRoom(d.room, id, d.exists === true) };
  } catch (error) {
    return networkError(error);
  }
}

export async function token(input: {
  roomId: string;
  nickname: string;
  password?: string;
  participantIdentity?: string;
}): Promise<ApiResult<TokenResponse>> {
  try {
    const { status, data, retryAfter } = await request("/api/livekit/token", { method: "POST", body: input });
    if (status < 200 || status >= 300) {
      return errorFrom(status, data, retryAfter, "Não foi possível conectar à sala.");
    }
    const d = (data ?? {}) as Record<string, unknown>;
    if (typeof d.token !== "string" || typeof d.livekitUrl !== "string") {
      return fail(502, "O servidor respondeu sem o token da sala.");
    }
    return {
      ok: true,
      data: {
        token: d.token,
        livekitUrl: d.livekitUrl,
        participantIdentity: typeof d.participantIdentity === "string" ? d.participantIdentity : "",
        participantName: typeof d.participantName === "string" ? d.participantName : input.nickname,
      },
    };
  } catch (error) {
    return networkError(error);
  }
}

/**
 * `GET /api/desktop` (opcional no servidor): `{ minVersion }`. Rota ausente
 * (404) significa "sem exigência".
 */
export async function desktopInfo(): Promise<ApiResult<{ minVersion: string | null }>> {
  try {
    const { status, data } = await request("/api/desktop");
    if (status !== 200) return { ok: true, data: { minVersion: null } };
    const v = (data as { minVersion?: unknown } | null)?.minVersion;
    return { ok: true, data: { minVersion: typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : null } };
  } catch {
    return { ok: true, data: { minVersion: null } };
  }
}
