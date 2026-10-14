import { toPhysical, type Rect } from "../shared/remote/geometry";
import {
  CONSENT_TIMEOUT_MS,
  REQUEST_COOLDOWN_MS,
  RC_VERSION,
  decodeInput,
  seqNewer,
  sessionTag,
  type Ctl,
  type InputEvent,
  type PauseWhy,
  type RevokeReason,
} from "../shared/remote/protocol";

/**
 * O portão do controle remoto (seção 7.2 de CONTROLE-REMOTO.md). É a única
 * peça que decide se um evento vindo da rede vira `SendInput`. Não importa o
 * Electron: tudo o que precisa do mundo chega por `GateDeps`, e os testes
 * usam um injetor falso.
 */

/** Remetente carimbado pelo SFU (o cliente não consegue mentir). */
export type Peer = { identity: string; sid: string; name: string };

/** Comando já decodificado e em pixels físicos — o utility nunca vê bytes da rede. */
export type InjectCommand =
  | { t: "move"; px: number; py: number }
  | { t: "button"; button: number; down: boolean; px: number; py: number }
  | { t: "wheel"; dx: number; dy: number; px: number; py: number }
  | { t: "key"; scancode: number; down: boolean }
  | { t: "text"; text: string }
  | { t: "release" };

export type HostShare = {
  /** Só tela inteira pode ser controlada (fase 1). */
  kind: "screen" | "window";
  sourceName: string;
  trackSid: string | null;
  /** Monitor compartilhado em pixels físicos; null se não foi encontrado. */
  physical: Rect | null;
};

export type ConsentRequest = { reqId: string; name: string; identity: string; sourceName: string };

export type SessionInfo = {
  identity: string;
  name: string;
  paused: boolean;
  /** Janela de administrador em primeiro plano: o Windows descarta o input. */
  elevated: boolean;
};

export interface GateDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  randomId(): string;
  /** O que está no ar agora (null: não está compartilhando). */
  share(): HostShare | null;
  /** O injetor nativo carregou e a pessoa não desligou o recurso. */
  acceptsRequests(): { ok: true } | { ok: false; reason: "disabled" };
  /**
   * Uma janela do MyScreen está em primeiro plano: tecla é descartada. (O
   * clique sobre uma janela do MyScreen é descartado no utility "input", que
   * pergunta ao Windows qual janela está DE FATO sob o pixel.)
   */
  appFocused(): boolean;
  send(to: string, msg: Ctl): void;
  inject(cmd: InjectCommand): void;
  askConsent(req: ConsentRequest): void;
  closeConsent(reqId: string): void;
  sessionChanged(info: SessionInfo | null, ended?: { reason: RevokeReason; identity: string; name: string }): void;
}

/** Balde de fichas: 240 eventos/s sustentados, rajada de 480. */
export const BUCKET_RATE = 240;
export const BUCKET_BURST = 480;
/** Movimento só passa se sobrar esta reserva: clique e tecla têm prioridade. */
const MOVE_RESERVE = 48;
const TEXT_COST = 20;

type Pending = { reqId: string; peer: Peer; timer: unknown };

type Session = {
  sessionId: string;
  tag: number;
  peer: Peer;
  trackSid: string;
  display: Rect;
  paused: boolean;
  elevated: boolean;
  appFocused: boolean;
  lastSeq: number | null;
  pressedKeys: Set<number>;
  pressedButtons: Set<number>;
  tokens: number;
  refilledAt: number;
  /** Último aviso de clique bloqueado (no máximo um a cada BLOCKED_NOTICE_MS). */
  blockedNoticeAt: number;
};

const BLOCKED_NOTICE_MS = 1500;

export class RemoteGate {
  private pending: Pending | null = null;
  private session: Session | null = null;
  private readonly cooldown = new Map<string, number>();

  constructor(private readonly deps: GateDeps) {}

  get active(): SessionInfo | null {
    const s = this.session;
    return s ? { identity: s.peer.identity, name: s.peer.name, paused: s.paused, elevated: s.elevated } : null;
  }

  get pendingRequest(): string | null {
    return this.pending?.reqId ?? null;
  }

  // ------------------------------------------------------------ controle

  handleCtl(from: Peer, msg: Ctl): void {
    switch (msg.t) {
      case "request":
        this.onRequest(from, msg.reqId, msg.v);
        break;
      case "cancel":
        if (this.pending && this.pending.reqId === msg.reqId && this.pending.peer.identity === from.identity) {
          this.clearPending();
        }
        break;
      case "revoke": {
        const s = this.session;
        if (s && s.sessionId === msg.sessionId && this.isSessionPeer(from)) this.end("user", false);
        break;
      }
      case "ping": {
        const s = this.session;
        if (s && s.sessionId === msg.sessionId && this.isSessionPeer(from)) {
          this.deps.send(from.identity, { t: "pong", sessionId: s.sessionId, n: msg.n });
        }
        break;
      }
      default:
        // grant/deny/state/pong só fazem sentido no outro sentido.
        break;
    }
  }

  private onRequest(from: Peer, reqId: string, version: number): void {
    const deny = (reason: Extract<Ctl, { t: "deny" }>["reason"]) =>
      this.deps.send(from.identity, { t: "deny", reqId, reason });
    if (this.pending?.reqId === reqId) return; // repetido
    if (version !== RC_VERSION) return deny("disabled");
    if (!this.deps.acceptsRequests().ok) return deny("disabled");
    const share = this.deps.share();
    if (!share || share.kind !== "screen" || !share.trackSid || !share.physical) return deny("not-sharing");
    if (this.session || this.pending) return deny("busy");
    const until = this.cooldown.get(from.identity);
    if (until !== undefined && this.deps.now() < until) return deny("cooldown");
    this.cooldown.delete(from.identity);

    const timer = this.deps.setTimer(() => {
      if (this.pending?.reqId !== reqId) return;
      this.clearPending();
      this.cooldown.set(from.identity, this.deps.now() + REQUEST_COOLDOWN_MS);
      deny("timeout");
    }, CONSENT_TIMEOUT_MS);
    this.pending = { reqId, peer: from, timer };
    this.deps.askConsent({ reqId, name: from.name, identity: from.identity, sourceName: share.sourceName });
  }

  private clearPending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.deps.clearTimer(p.timer);
    this.deps.closeConsent(p.reqId);
  }

  /** A resposta do diálogo. Só o clique em "Permitir" cria uma sessão. */
  decide(reqId: string, allow: boolean): void {
    const p = this.pending;
    if (!p || p.reqId !== reqId) return;
    this.clearPending();
    const send = (msg: Ctl) => this.deps.send(p.peer.identity, msg);
    if (!allow) {
      this.cooldown.set(p.peer.identity, this.deps.now() + REQUEST_COOLDOWN_MS);
      send({ t: "deny", reqId, reason: "refused" });
      return;
    }
    const share = this.deps.share();
    if (!share || share.kind !== "screen" || !share.trackSid || !share.physical) {
      send({ t: "deny", reqId, reason: "not-sharing" });
      return;
    }
    const sessionId = this.deps.randomId();
    this.session = {
      sessionId,
      tag: sessionTag(sessionId),
      peer: p.peer,
      trackSid: share.trackSid,
      display: share.physical,
      paused: false,
      elevated: false,
      appFocused: this.deps.appFocused(),
      lastSeq: null,
      pressedKeys: new Set(),
      pressedButtons: new Set(),
      tokens: BUCKET_BURST,
      refilledAt: this.deps.now(),
      blockedNoticeAt: -Infinity,
    };
    send({
      t: "grant",
      reqId,
      sessionId,
      trackSid: share.trackSid,
      width: Math.round(share.physical.w),
      height: Math.round(share.physical.h),
    });
    // Quem acabou de clicar em "Permitir" está com o MyScreen na frente: avisa
    // o controlador que as teclas só chegam depois de um clique fora dele.
    if (this.session.appFocused) this.sendState(this.session);
    this.deps.sessionChanged(this.active);
  }

  // ------------------------------------------------------------ input

  private isSessionPeer(from: Peer): boolean {
    const s = this.session;
    return s !== null && s.peer.identity === from.identity && s.peer.sid === from.sid;
  }

  private take(s: Session, cost: number, reserve: number): boolean {
    const now = this.deps.now();
    s.tokens = Math.min(BUCKET_BURST, s.tokens + ((now - s.refilledAt) / 1000) * BUCKET_RATE);
    s.refilledAt = now;
    if (s.tokens - cost < reserve) return false;
    s.tokens -= cost;
    return true;
  }

  /** Um pacote `rc.in` cru. Devolve se ele virou comando (para teste e diagnóstico). */
  handleInput(from: Peer, bytes: Uint8Array): boolean {
    const s = this.session;
    if (!s || !this.isSessionPeer(from)) return false;
    const pkt = decodeInput(bytes);
    if (!pkt || pkt.tag !== s.tag) return false;
    const { ev, seq } = pkt;

    if (ev.t === "move") {
      if (s.paused) return false;
      if (s.lastSeq !== null && !seqNewer(seq, s.lastSeq)) return false;
      if (!this.take(s, 1, MOVE_RESERVE)) return false;
    } else {
      if (!this.take(s, ev.t === "text" ? TEXT_COST : 1, 0)) {
        // Evento confiável estourando o balde: alguém está inundando.
        this.end("error");
        return false;
      }
      // Soltar é sempre permitido (nada pode ficar preso); o resto respeita a pausa.
      if (s.paused && !isRelease(ev)) return false;
    }
    s.lastSeq = seq;
    return this.apply(s, ev);
  }

  private apply(s: Session, ev: InputEvent): boolean {
    switch (ev.t) {
      case "move": {
        const [px, py] = toPhysical(ev.x, ev.y, s.display);
        this.deps.inject({ t: "move", px, py });
        return true;
      }
      case "button": {
        const [px, py] = toPhysical(ev.x, ev.y, s.display);
        if (ev.down) {
          s.pressedButtons.add(ev.button);
        } else {
          // Soltar só o que foi apertado por nós: um "up" solto não faz sentido.
          if (!s.pressedButtons.delete(ev.button)) return false;
        }
        this.deps.inject({ t: "button", button: ev.button, down: ev.down, px, py });
        return true;
      }
      case "wheel": {
        const [px, py] = toPhysical(ev.x, ev.y, s.display);
        this.deps.inject({ t: "wheel", dx: ev.dx, dy: ev.dy, px, py });
        return true;
      }
      case "key":
        if (ev.down) {
          if (this.deps.appFocused()) return false;
          s.pressedKeys.add(ev.scancode);
        } else if (!s.pressedKeys.delete(ev.scancode)) {
          return false;
        }
        this.deps.inject({ t: "key", scancode: ev.scancode, down: ev.down });
        return true;
      case "text":
        if (this.deps.appFocused()) return false;
        this.deps.inject({ t: "text", text: ev.text });
        return true;
      case "release":
        this.releaseAll(s);
        return true;
    }
  }

  private releaseAll(s: Session): void {
    s.pressedKeys.clear();
    s.pressedButtons.clear();
    this.deps.inject({ t: "release" });
  }

  // ------------------------------------------------------------ estado e fim

  /** Pausa pela pessoa controlada (pílula da sala). Solta tudo ao pausar. */
  setPaused(paused: boolean): void {
    const s = this.session;
    if (!s || s.paused === paused) return;
    if (paused) this.releaseAll(s);
    s.paused = paused;
    this.sendState(s);
    this.deps.sessionChanged(this.active);
  }

  /** O utility viu uma janela de administrador entrar/sair do primeiro plano. */
  setElevated(elevated: boolean): void {
    const s = this.session;
    if (!s || s.elevated === elevated) return;
    s.elevated = elevated;
    this.sendState(s);
    this.deps.sessionChanged(this.active);
  }

  /**
   * Um clique caiu sobre uma janela do MyScreen (zona protegida) e foi
   * descartado. Com "esconder o MyScreen da transmissão", quem controla nem vê
   * a janela: avisa, para o clique não parecer sumir no nada.
   */
  blocked(): void {
    const s = this.session;
    if (!s) return;
    const now = this.deps.now();
    if (now - s.blockedNoticeAt < BLOCKED_NOTICE_MS) return;
    s.blockedNoticeAt = now;
    this.deps.send(s.peer.identity, { t: "blocked", sessionId: s.sessionId });
  }

  /** Uma janela do MyScreen ganhou ou perdeu o primeiro plano. */
  setAppFocused(focused: boolean): void {
    const s = this.session;
    if (!s || s.appFocused === focused) return;
    s.appFocused = focused;
    this.sendState(s);
  }

  private sendState(s: Session): void {
    const why: PauseWhy | undefined = s.paused
      ? "user"
      : s.elevated
        ? "elevated"
        : s.appFocused
          ? "protected"
          : undefined;
    const msg: Ctl = why
      ? { t: "state", sessionId: s.sessionId, paused: true, why }
      : { t: "state", sessionId: s.sessionId, paused: false };
    this.deps.send(s.peer.identity, msg);
  }

  /** O compartilhamento mudou: parou, trocou de fonte ou de monitor → a sessão cai. */
  shareChanged(): void {
    const share = this.deps.share();
    const s = this.session;
    if (s && (!share || share.kind !== "screen" || share.trackSid !== s.trackSid || !share.physical)) {
      this.end("share-ended");
    }
    if (this.pending && (!share || share.kind !== "screen")) {
      const p = this.pending;
      this.clearPending();
      this.deps.send(p.peer.identity, { t: "deny", reqId: p.reqId, reason: "not-sharing" });
    }
  }

  /** Alguém saiu da sala (ou reconectou com outro SID). */
  peerGone(identity: string, reason: "left" | "reconnected"): void {
    if (this.pending?.peer.identity === identity) this.clearPending();
    if (this.session?.peer.identity === identity) this.end(reason, reason === "reconnected");
  }

  /** Mesma identidade apareceu com SID novo: é outra conexão, a sessão não migra. */
  peerSeen(identity: string, sid: string): void {
    const s = this.session;
    if (s && s.peer.identity === identity && s.peer.sid !== sid) this.end("reconnected");
    const p = this.pending;
    if (p && p.peer.identity === identity && p.peer.sid !== sid) this.clearPending();
  }

  /**
   * Encerra a sessão. Solta tudo ANTES de limpar o estado: se o aviso ao
   * controlador falhar, pelo menos nada fica pressionado no PC.
   */
  end(reason: RevokeReason, notifyPeer = true): void {
    if (this.pending) {
      const p = this.pending;
      this.clearPending();
      if (notifyPeer) this.deps.send(p.peer.identity, { t: "deny", reqId: p.reqId, reason: "busy" });
    }
    const s = this.session;
    if (!s) return;
    this.releaseAll(s);
    this.session = null;
    if (notifyPeer) this.deps.send(s.peer.identity, { t: "revoke", sessionId: s.sessionId, reason });
    this.deps.sessionChanged(null, { reason, identity: s.peer.identity, name: s.peer.name });
  }
}

function isRelease(ev: InputEvent): boolean {
  return ev.t === "release" || ((ev.t === "button" || ev.t === "key") && !ev.down);
}
