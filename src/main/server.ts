import { app, net } from "electron";
import type { ApiResult, ChatFileInfo, RoomInfo, SoundInfo, StoredChatMessage, TokenResponse } from "../shared/ipc";
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
  identityProof?: string;
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
        identityProof: typeof d.identityProof === "string" ? d.identityProof : null,
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

// ---------------------------------------------------------------- áudios da chamada

/** O mesmo teto do servidor: o arquivo vem inteiro pela IPC. */
const MAX_SOUND_BYTES = 25 * 1024 * 1024;
const SOUND_TIMEOUT_MS = 60_000;

/** `GET /api/sounds`. Servidor sem a rota (404) é só uma lista vazia. */
export async function listSounds(): Promise<ApiResult<SoundInfo[]>> {
  try {
    const { status, data, retryAfter } = await request("/api/sounds");
    if (status === 404) return { ok: true, data: [] };
    if (status < 200 || status >= 300) return errorFrom(status, data, retryAfter, "Não foi possível carregar os áudios.");
    const raw = (data as { sounds?: unknown } | null)?.sounds;
    const sounds: SoundInfo[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const r = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      if (typeof r.id !== "string" || !r.id || r.id.length > 200) continue;
      sounds.push({
        id: r.id,
        name: typeof r.name === "string" && r.name ? r.name.slice(0, 120) : r.id,
        size: typeof r.size === "number" && Number.isFinite(r.size) ? r.size : 0,
      });
    }
    return { ok: true, data: sounds };
  } catch (error) {
    return networkError(error);
  }
}

/** `GET /api/sounds/:id`: os bytes do arquivo, para o renderer decodificar. */
export async function fetchSound(id: string): Promise<ApiResult<Uint8Array>> {
  try {
    const res = await net.fetch(`${getSettings().serverUrl}/api/sounds/${encodeURIComponent(id)}`, {
      headers: { "User-Agent": `MyScreenDesktop/${app.getVersion()}` },
      cache: "no-store",
      signal: AbortSignal.timeout(SOUND_TIMEOUT_MS),
    });
    if (!res.ok) return fail(res.status, res.status === 404 ? "Esse áudio não está mais no servidor." : `Falha ao baixar o áudio (${res.status}).`);
    if (Number(res.headers.get("content-length")) > MAX_SOUND_BYTES) return fail(413, "Áudio grande demais.");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_SOUND_BYTES) return fail(413, "Áudio grande demais.");
    return { ok: true, data: bytes };
  } catch (error) {
    return networkError(error);
  }
}

// ------------------------------------------------- envios com o token da sala

/** Quem está na sala prova isso com o token do SFU: o servidor o verifica. */
async function authed(
  path: string,
  roomToken: string,
  init: { method?: string; json?: unknown; file?: { name: string; type: string; bytes: Uint8Array } } = {},
  timeoutMs = TIMEOUT_MS,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${roomToken}`,
    "User-Agent": `MyScreenDesktop/${app.getVersion()}`,
  };
  let body: BodyInit | undefined;
  if (init.file) {
    // O `Response` serializa o multipart e diz a fronteira no Content-Type.
    const form = new FormData();
    form.append("file", new Blob([init.file.bytes as Uint8Array<ArrayBuffer>], { type: init.file.type || "application/octet-stream" }), init.file.name);
    const encoded = new Response(form);
    headers["Content-Type"] = encoded.headers.get("content-type") ?? "multipart/form-data";
    body = new Uint8Array(await encoded.arrayBuffer());
  } else if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  return net.fetch(`${getSettings().serverUrl}${path}`, {
    method: init.method ?? "GET",
    headers,
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function retryAfterOf(res: Response): number | null {
  const ra = Number(res.headers.get("retry-after"));
  return Number.isFinite(ra) && ra > 0 ? ra : null;
}

function asChatFile(raw: unknown): ChatFileInfo | null {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^[0-9a-f]{32}$/.test(r.id)) return null;
  return {
    id: r.id,
    name: typeof r.name === "string" && r.name ? r.name.slice(0, 200) : "arquivo",
    type: typeof r.type === "string" ? r.type.slice(0, 100) : "application/octet-stream",
    size: typeof r.size === "number" && Number.isFinite(r.size) ? r.size : 0,
  };
}

/** `POST /api/sounds`: um áudio do computador entra na lista de todo mundo. */
export async function uploadSound(roomToken: string, name: string, bytes: Uint8Array): Promise<ApiResult<SoundInfo>> {
  if (bytes.byteLength > MAX_SOUND_BYTES) return fail(413, "Áudio grande demais. O limite é 25 MB.");
  try {
    const res = await authed("/api/sounds", roomToken, { method: "POST", file: { name, type: "", bytes } }, SOUND_TIMEOUT_MS * 2);
    const data = await jsonOf(res);
    if (res.status === 404 || res.status === 405) return fail(res.status, "O servidor ainda não aceita envio de áudios.");
    if (!res.ok) return errorFrom(res.status, data, retryAfterOf(res), "Não foi possível enviar o áudio.");
    const s = ((data as { sound?: unknown } | null)?.sound ?? {}) as Record<string, unknown>;
    if (typeof s.id !== "string") return fail(502, "O servidor respondeu sem o áudio.");
    return {
      ok: true,
      data: { id: s.id, name: typeof s.name === "string" ? s.name : s.id, size: typeof s.size === "number" ? s.size : bytes.byteLength },
    };
  } catch (error) {
    return networkError(error);
  }
}

const roomPath = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}/chat`;

/** `GET /api/rooms/:id/chat`. Servidor sem a rota: histórico vazio. */
export async function chatHistory(roomId: string, roomToken: string): Promise<ApiResult<StoredChatMessage[]>> {
  try {
    const res = await authed(roomPath(roomId), roomToken);
    if (res.status === 404 || res.status === 405) return { ok: true, data: [] };
    const data = await jsonOf(res);
    if (!res.ok) return errorFrom(res.status, data, retryAfterOf(res), "Não foi possível carregar o histórico do chat.");
    const raw = (data as { messages?: unknown } | null)?.messages;
    const out: StoredChatMessage[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const r = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      if (typeof r.id !== "string" || typeof r.timestamp !== "number") continue;
      const attributes: Record<string, string> = {};
      if (typeof r.attributes === "object" && r.attributes !== null) {
        for (const [k, v] of Object.entries(r.attributes)) if (typeof v === "string") attributes[k] = v;
      }
      out.push({
        id: r.id,
        timestamp: r.timestamp,
        message: typeof r.message === "string" ? r.message : "",
        attributes,
        fromIdentity: typeof r.fromIdentity === "string" ? r.fromIdentity : "",
        fromName: typeof r.fromName === "string" ? r.fromName : "",
        files: (Array.isArray(r.files) ? r.files : []).map(asChatFile).filter((f): f is ChatFileInfo => f !== null),
      });
    }
    return { ok: true, data: out };
  } catch (error) {
    return networkError(error);
  }
}

export async function chatUploadFile(
  roomId: string,
  roomToken: string,
  file: { name: string; type: string; bytes: Uint8Array },
): Promise<ApiResult<ChatFileInfo>> {
  try {
    const res = await authed(`${roomPath(roomId)}/files`, roomToken, { method: "POST", file }, SOUND_TIMEOUT_MS * 2);
    const data = await jsonOf(res);
    if (!res.ok) return errorFrom(res.status, data, retryAfterOf(res), "Não foi possível guardar o arquivo.");
    const f = asChatFile((data as { file?: unknown } | null)?.file);
    return f ? { ok: true, data: f } : fail(502, "O servidor respondeu sem o arquivo.");
  } catch (error) {
    return networkError(error);
  }
}

export async function chatAppend(
  roomId: string,
  roomToken: string,
  msg: { id: string; timestamp: number; message: string; attributes: Record<string, string>; fileIds: string[] },
): Promise<ApiResult<null>> {
  try {
    const res = await authed(roomPath(roomId), roomToken, { method: "POST", json: msg });
    if (res.ok) return { ok: true, data: null };
    return errorFrom(res.status, await jsonOf(res), retryAfterOf(res), "Não foi possível guardar a mensagem.");
  } catch (error) {
    return networkError(error);
  }
}

export async function chatDelete(roomId: string, roomToken: string, messageId: string): Promise<ApiResult<null>> {
  try {
    const res = await authed(`${roomPath(roomId)}/${encodeURIComponent(messageId)}`, roomToken, { method: "DELETE" });
    if (res.ok) return { ok: true, data: null };
    return errorFrom(res.status, await jsonOf(res), retryAfterOf(res), "Não foi possível apagar a mensagem.");
  } catch (error) {
    return networkError(error);
  }
}

export async function chatFile(roomId: string, roomToken: string, fileId: string): Promise<ApiResult<Uint8Array>> {
  try {
    const res = await authed(`${roomPath(roomId)}/files/${encodeURIComponent(fileId)}`, roomToken, {}, SOUND_TIMEOUT_MS);
    if (!res.ok) return fail(res.status, res.status === 404 ? "Esse arquivo não está mais no servidor." : `Falha ao baixar o arquivo (${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { ok: true, data: bytes };
  } catch (error) {
    return networkError(error);
  }
}
