/**
 * Protocolo do controle remoto (seção 5 de CONTROLE-REMOTO.md). Puro: roda no
 * renderer dos dois lados e no processo principal, e é testado sem Electron.
 *
 * - `myscreen.rc.ctl`: controle, JSON UTF-8, sempre confiável.
 * - `myscreen.rc.in`: input, binário compacto. Movimento vai com perda; o
 *   resto, confiável. Todo evento de mouse carrega a própria coordenada, então
 *   um clique que chega antes do movimento que o precede cai no lugar certo.
 *
 * Todo pacote sai com `destinationIdentities` do outro lado: tecla digitada
 * nunca vai para a sala inteira.
 */

export const RC_VERSION = 1;
export const TOPIC_CTL = "myscreen.rc.ctl";
export const TOPIC_IN = "myscreen.rc.in";

/** Atributos de participante que anunciam quem pode ser controlado. */
export const ATTR_VERSION = "rc.v";
export const ATTR_DISPLAY = "rc.display";
export const ATTR_BY = "rc.by";

/** Pedido sem resposta vira recusa. */
export const CONSENT_TIMEOUT_MS = 30_000;
/** Depois de recusar, a mesma identidade espera isto para pedir de novo. */
export const REQUEST_COOLDOWN_MS = 30_000;

export type DenyReason = "refused" | "timeout" | "busy" | "disabled" | "not-sharing" | "cooldown";
export type RevokeReason = "user" | "share-ended" | "left" | "reconnected" | "locked" | "panic" | "error";
/** `protected`: o MyScreen da pessoa controlada está em primeiro plano e as teclas não entram. */
export type PauseWhy = "local-input" | "locked" | "elevated" | "user" | "protected";

export type Ctl =
  | { t: "request"; v: number; reqId: string }
  | { t: "cancel"; reqId: string }
  | { t: "grant"; reqId: string; sessionId: string; trackSid: string; width: number; height: number }
  | { t: "deny"; reqId: string; reason: DenyReason }
  | { t: "revoke"; sessionId: string; reason: RevokeReason }
  | { t: "state"; sessionId: string; paused: boolean; why?: PauseWhy }
  | { t: "ping"; sessionId: string; n: number }
  | { t: "pong"; sessionId: string; n: number };

const DENY: readonly DenyReason[] = ["refused", "timeout", "busy", "disabled", "not-sharing", "cooldown"];
const REVOKE: readonly RevokeReason[] = ["user", "share-ended", "left", "reconnected", "locked", "panic", "error"];
const WHY: readonly PauseWhy[] = ["local-input", "locked", "elevated", "user", "protected"];

/** 16 bytes aleatórios em base64url (22 caracteres). */
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_CTL_BYTES = 1024;

export function isId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

export function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Os 4 primeiros bytes do `sessionId`, como u32: vai em todo pacote de input. */
export function sessionTag(sessionId: string): number {
  const b64 = sessionId.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.slice(0, 8));
  return ((bin.charCodeAt(0) << 24) | (bin.charCodeAt(1) << 16) | (bin.charCodeAt(2) << 8) | bin.charCodeAt(3)) >>> 0;
}

function isUint(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

function isTrackSid(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
}

/**
 * Valida uma mensagem de controle. Esquema estrito: tipo, cada campo e nada
 * além do tamanho máximo. Qualquer desvio devolve null (e é ignorado).
 */
export function parseCtl(input: Uint8Array | unknown): Ctl | null {
  let raw: unknown = input;
  if (input instanceof Uint8Array) {
    if (input.byteLength === 0 || input.byteLength > MAX_CTL_BYTES) return null;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case "request":
      return isUint(m.v, 1000) && isId(m.reqId) ? { t: "request", v: m.v, reqId: m.reqId } : null;
    case "cancel":
      return isId(m.reqId) ? { t: "cancel", reqId: m.reqId } : null;
    case "grant":
      return isId(m.reqId) && isId(m.sessionId) && isTrackSid(m.trackSid) && isUint(m.width, 100_000) && isUint(m.height, 100_000)
        ? { t: "grant", reqId: m.reqId, sessionId: m.sessionId, trackSid: m.trackSid, width: m.width, height: m.height }
        : null;
    case "deny":
      return isId(m.reqId) && DENY.includes(m.reason as DenyReason)
        ? { t: "deny", reqId: m.reqId, reason: m.reason as DenyReason }
        : null;
    case "revoke":
      return isId(m.sessionId) && REVOKE.includes(m.reason as RevokeReason)
        ? { t: "revoke", sessionId: m.sessionId, reason: m.reason as RevokeReason }
        : null;
    case "state": {
      if (!isId(m.sessionId) || typeof m.paused !== "boolean") return null;
      if (m.why !== undefined && !WHY.includes(m.why as PauseWhy)) return null;
      const msg: Ctl = { t: "state", sessionId: m.sessionId, paused: m.paused };
      if (m.why !== undefined) msg.why = m.why as PauseWhy;
      return msg;
    }
    case "ping":
    case "pong":
      return isId(m.sessionId) && isUint(m.n, 0xffff_ffff) ? { t: m.t, sessionId: m.sessionId, n: m.n } : null;
    default:
      return null;
  }
}

export function encodeCtl(msg: Ctl): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(msg));
}

// ---------------------------------------------------------------- input binário

export const IN = {
  MOVE: 0x01,
  BUTTON: 0x02,
  WHEEL: 0x03,
  KEY: 0x04,
  TEXT: 0x05,
  RELEASE_ALL: 0x06,
} as const;

/** `u8 tipo | u32 sessionTag | u16 seq` */
export const HEADER_BYTES = 7;
export const MAX_TEXT_BYTES = 1024;
export const COORD_MAX = 65535;

export type InputEvent =
  | { t: "move"; x: number; y: number }
  | { t: "button"; button: number; down: boolean; x: number; y: number }
  | { t: "wheel"; dx: number; dy: number; x: number; y: number }
  | { t: "key"; scancode: number; down: boolean }
  | { t: "text"; text: string }
  | { t: "release" };

export type InputPacket = { tag: number; seq: number; ev: InputEvent };

/** Movimento vai pelo canal com perda; o resto, confiável. */
export function isLossy(ev: InputEvent): boolean {
  return ev.t === "move";
}

export function encodeInput(tag: number, seq: number, ev: InputEvent): Uint8Array<ArrayBuffer> {
  let body: Uint8Array<ArrayBuffer>;
  let type: number;
  switch (ev.t) {
    case "move": {
      type = IN.MOVE;
      body = new Uint8Array(4);
      const v = new DataView(body.buffer);
      v.setUint16(0, ev.x);
      v.setUint16(2, ev.y);
      break;
    }
    case "button": {
      type = IN.BUTTON;
      body = new Uint8Array(6);
      const v = new DataView(body.buffer);
      v.setUint8(0, ev.button);
      v.setUint8(1, ev.down ? 1 : 0);
      v.setUint16(2, ev.x);
      v.setUint16(4, ev.y);
      break;
    }
    case "wheel": {
      type = IN.WHEEL;
      body = new Uint8Array(8);
      const v = new DataView(body.buffer);
      v.setInt16(0, ev.dx);
      v.setInt16(2, ev.dy);
      v.setUint16(4, ev.x);
      v.setUint16(6, ev.y);
      break;
    }
    case "key": {
      type = IN.KEY;
      body = new Uint8Array(3);
      const v = new DataView(body.buffer);
      v.setUint16(0, ev.scancode);
      v.setUint8(2, ev.down ? 1 : 0);
      break;
    }
    case "text":
      type = IN.TEXT;
      body = new TextEncoder().encode(ev.text);
      if (body.byteLength === 0 || body.byteLength > MAX_TEXT_BYTES) throw new RangeError("texto fora do limite");
      break;
    case "release":
      type = IN.RELEASE_ALL;
      body = new Uint8Array(0);
      break;
  }
  const out = new Uint8Array(HEADER_BYTES + body.byteLength);
  const h = new DataView(out.buffer);
  h.setUint8(0, type);
  h.setUint32(1, tag >>> 0);
  h.setUint16(5, seq & 0xffff);
  out.set(body, HEADER_BYTES);
  return out;
}

const BODY_BYTES: Record<number, number> = {
  [IN.MOVE]: 4,
  [IN.BUTTON]: 6,
  [IN.WHEEL]: 8,
  [IN.KEY]: 3,
  [IN.RELEASE_ALL]: 0,
};

/**
 * Parser de tamanho exato por tipo. Nunca lança: bytes da rede que não
 * formam um pacote válido devolvem null.
 */
export function decodeInput(bytes: Uint8Array): InputPacket | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_BYTES) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = v.getUint8(0);
  const tag = v.getUint32(1);
  const seq = v.getUint16(5);
  const bodyLen = bytes.byteLength - HEADER_BYTES;
  if (type !== IN.TEXT && BODY_BYTES[type] !== bodyLen) return null;
  const at = HEADER_BYTES;
  let ev: InputEvent;
  switch (type) {
    case IN.MOVE:
      ev = { t: "move", x: v.getUint16(at), y: v.getUint16(at + 2) };
      break;
    case IN.BUTTON: {
      const button = v.getUint8(at);
      const down = v.getUint8(at + 1);
      if (button > 4 || down > 1) return null;
      ev = { t: "button", button, down: down === 1, x: v.getUint16(at + 2), y: v.getUint16(at + 4) };
      break;
    }
    case IN.WHEEL: {
      const dx = v.getInt16(at);
      const dy = v.getInt16(at + 2);
      if (Math.abs(dx) > WHEEL_MAX || Math.abs(dy) > WHEEL_MAX) return null;
      ev = { t: "wheel", dx, dy, x: v.getUint16(at + 4), y: v.getUint16(at + 6) };
      break;
    }
    case IN.KEY: {
      const scancode = v.getUint16(at);
      const down = v.getUint8(at + 2);
      if (down > 1 || (scancode & 0xff) === 0 || scancode > 0x1ff) return null;
      ev = { t: "key", scancode, down: down === 1 };
      break;
    }
    case IN.TEXT: {
      if (bodyLen === 0 || bodyLen > MAX_TEXT_BYTES) return null;
      try {
        ev = { t: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at)) };
      } catch {
        return null;
      }
      break;
    }
    case IN.RELEASE_ALL:
      ev = { t: "release" };
      break;
    default:
      return null;
  }
  return { tag, seq, ev };
}

/** `a` é posterior a `b` num contador de 16 bits que dá a volta? */
export function seqNewer(a: number, b: number): boolean {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

// ---------------------------------------------------------------- roda

/** Unidade do Windows: 120 por "dente" da roda. */
export const WHEEL_DELTA = 120;
/** Teto por pacote (≈ 16 dentes): mais que isso é rajada, não gesto. */
export const WHEEL_MAX = WHEEL_DELTA * 16;

/**
 * Converte `WheelEvent` (pixels, linhas ou páginas; positivo = para baixo)
 * em unidades do Windows (positivo = para cima), acumulando frações: o
 * touchpad manda deltas pequenos que, somados, viram rolagem suave.
 */
export class WheelAccumulator {
  private fx = 0;
  private fy = 0;

  add(deltaX: number, deltaY: number, deltaMode: number): { dx: number; dy: number } {
    // O Chromium no Windows dá 100 px por dente (escala 100%); 3 linhas por dente.
    const per = deltaMode === 1 ? WHEEL_DELTA / 3 : deltaMode === 2 ? WHEEL_DELTA * 3 : WHEEL_DELTA / 100;
    this.fx += deltaX * per;
    this.fy += -deltaY * per;
    const dx = Math.trunc(this.fx);
    const dy = Math.trunc(this.fy);
    this.fx -= dx;
    this.fy -= dy;
    // `+ 0` tira o -0 do trunc.
    return { dx: clampWheel(dx) + 0, dy: clampWheel(dy) + 0 };
  }

  reset(): void {
    this.fx = 0;
    this.fy = 0;
  }
}

function clampWheel(v: number): number {
  return Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, v));
}
