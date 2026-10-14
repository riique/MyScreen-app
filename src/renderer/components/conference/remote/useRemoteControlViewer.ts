import { RoomEvent, type Participant, type RemoteParticipant, type Room } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CONSENT_TIMEOUT_MS,
  RC_VERSION,
  TOPIC_CTL,
  TOPIC_IN,
  encodeCtl,
  encodeInput,
  isLossy,
  parseCtl,
  randomId,
  sessionTag,
  type Ctl,
  type DenyReason,
  type InputEvent,
  type PauseWhy,
  type RevokeReason,
} from "@shared/remote/protocol";

/**
 * Lado de quem controla: pede, espera a permissão, manda o input e mede a
 * latência. Um controle por vez. Nada aqui tem poder no PC remoto — quem
 * decide é o processo principal de lá.
 */

export type ViewerState =
  | { phase: "idle" }
  | { phase: "requesting"; target: string; targetName: string; reqId: string }
  | {
      phase: "active";
      target: string;
      targetName: string;
      sessionId: string;
      trackSid: string;
      width: number;
      height: number;
      paused: boolean;
      why: PauseWhy | null;
      /** Ida e volta do `ping` em ms; null até a primeira medida. */
      rttMs: number | null;
    };

export interface RemoteViewer {
  state: ViewerState;
  notice: string | null;
  dismissNotice(): void;
  request(participant: Participant): void;
  cancel(): void;
  stop(): void;
  send(ev: InputEvent): void;
}

const PING_INTERVAL_MS = 2000;

function denyText(name: string, reason: DenyReason): string {
  switch (reason) {
    case "refused":
      return `${name} recusou o pedido de controle.`;
    case "timeout":
      return `${name} não respondeu ao pedido de controle.`;
    case "busy":
      return `Outra pessoa já está controlando a tela de ${name}.`;
    case "disabled":
      return `${name} não aceita pedidos de controle.`;
    case "not-sharing":
      return `${name} não está compartilhando uma tela inteira pelo app.`;
    case "cooldown":
      return `Espere alguns segundos antes de pedir de novo a ${name}.`;
  }
}

function revokeText(name: string, reason: RevokeReason): string {
  switch (reason) {
    case "user":
      return `${name} encerrou o controle remoto.`;
    case "share-ended":
      return `O controle terminou: ${name} parou ou trocou a tela compartilhada.`;
    case "left":
      return `O controle terminou: ${name} saiu da sala.`;
    case "reconnected":
      return "O controle terminou porque a conexão foi refeita. Peça de novo.";
    case "locked":
      return `O controle terminou: o computador de ${name} foi bloqueado.`;
    case "panic":
      return `${name} usou o atalho de emergência e encerrou o controle.`;
    case "error":
      return "O controle remoto foi encerrado por um erro.";
  }
}

export function useRemoteControlViewer(room: Room): RemoteViewer {
  const [state, setState] = useState<ViewerState>({ phase: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const seq = useRef(0);
  const pings = useRef(new Map<number, number>());
  const pingN = useRef(0);

  const sendCtl = useCallback(
    (to: string, msg: Ctl) => {
      void room.localParticipant
        .publishData(encodeCtl(msg), { reliable: true, topic: TOPIC_CTL, destinationIdentities: [to] })
        .catch((error: unknown) => console.warn("rc.ctl não saiu:", error));
    },
    [room],
  );

  const send = useCallback(
    (ev: InputEvent) => {
      const s = stateRef.current;
      if (s.phase !== "active") return;
      seq.current = (seq.current + 1) & 0xffff;
      const bytes = encodeInput(sessionTag(s.sessionId), seq.current, ev);
      void room.localParticipant
        .publishData(bytes, { reliable: !isLossy(ev), topic: TOPIC_IN, destinationIdentities: [s.target] })
        .catch(() => {
          // Movimento perdido não importa; o próximo põe o cursor no lugar.
        });
    },
    [room],
  );

  const request = useCallback(
    (participant: Participant) => {
      if (stateRef.current.phase !== "idle" || participant.isLocal) return;
      const reqId = randomId();
      const name = participant.name || participant.identity;
      setNotice(null);
      setState({ phase: "requesting", target: participant.identity, targetName: name, reqId });
      sendCtl(participant.identity, { t: "request", v: RC_VERSION, reqId });
    },
    [sendCtl],
  );

  const cancel = useCallback(() => {
    const s = stateRef.current;
    if (s.phase !== "requesting") return;
    sendCtl(s.target, { t: "cancel", reqId: s.reqId });
    setState({ phase: "idle" });
  }, [sendCtl]);

  const stop = useCallback(() => {
    const s = stateRef.current;
    if (s.phase === "requesting") return cancel();
    if (s.phase !== "active") return;
    send({ t: "release" });
    sendCtl(s.target, { t: "revoke", sessionId: s.sessionId, reason: "user" });
    setState({ phase: "idle" });
  }, [cancel, send, sendCtl]);

  // Mensagens de controle vindas do PC que está (ou vai ser) controlado.
  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== TOPIC_CTL || !participant) return;
      const s = stateRef.current;
      if (s.phase === "idle" || participant.identity !== s.target) return;
      const msg = parseCtl(payload);
      if (!msg) return;
      switch (msg.t) {
        case "grant":
          if (s.phase !== "requesting" || msg.reqId !== s.reqId) return;
          seq.current = 0;
          pings.current.clear();
          setState({
            phase: "active",
            target: s.target,
            targetName: s.targetName,
            sessionId: msg.sessionId,
            trackSid: msg.trackSid,
            width: msg.width,
            height: msg.height,
            paused: false,
            why: null,
            rttMs: null,
          });
          break;
        case "deny":
          if (s.phase !== "requesting" || msg.reqId !== s.reqId) return;
          setNotice(denyText(s.targetName, msg.reason));
          setState({ phase: "idle" });
          break;
        case "revoke":
          if (s.phase !== "active" || msg.sessionId !== s.sessionId) return;
          setNotice(revokeText(s.targetName, msg.reason));
          setState({ phase: "idle" });
          break;
        case "state":
          if (s.phase !== "active" || msg.sessionId !== s.sessionId) return;
          setState({ ...s, paused: msg.paused, why: msg.why ?? null });
          break;
        case "pong": {
          if (s.phase !== "active" || msg.sessionId !== s.sessionId) return;
          const sent = pings.current.get(msg.n);
          if (sent === undefined) return;
          pings.current.delete(msg.n);
          const rtt = Math.round(performance.now() - sent);
          setState((cur) => (cur.phase === "active" && cur.sessionId === s.sessionId ? { ...cur, rttMs: rtt } : cur));
          break;
        }
        default:
          break;
      }
    };
    const onGone = (participant: RemoteParticipant) => {
      const s = stateRef.current;
      if (s.phase === "idle" || participant.identity !== s.target) return;
      setNotice(s.phase === "active" ? revokeText(s.targetName, "left") : `${s.targetName} saiu da sala.`);
      setState({ phase: "idle" });
    };
    // A nossa conexão caiu: do outro lado a sessão é revogada; aqui, também.
    const onReconnecting = () => {
      const s = stateRef.current;
      if (s.phase === "idle") return;
      setNotice(s.phase === "active" ? revokeText(s.targetName, "reconnected") : null);
      setState({ phase: "idle" });
    };
    room
      .on(RoomEvent.DataReceived, onData)
      .on(RoomEvent.ParticipantDisconnected, onGone)
      .on(RoomEvent.Reconnecting, onReconnecting)
      .on(RoomEvent.SignalReconnecting, onReconnecting);
    return () => {
      room
        .off(RoomEvent.DataReceived, onData)
        .off(RoomEvent.ParticipantDisconnected, onGone)
        .off(RoomEvent.Reconnecting, onReconnecting)
        .off(RoomEvent.SignalReconnecting, onReconnecting);
    };
  }, [room]);

  // O pedido expira do outro lado em 30 s; se a resposta se perder, desiste aqui também.
  const requestKey = state.phase === "requesting" ? state.reqId : null;
  useEffect(() => {
    if (!requestKey) return;
    const timer = setTimeout(() => {
      const s = stateRef.current;
      if (s.phase === "requesting" && s.reqId === requestKey) {
        setNotice(denyText(s.targetName, "timeout"));
        setState({ phase: "idle" });
      }
    }, CONSENT_TIMEOUT_MS + 5000);
    return () => clearTimeout(timer);
  }, [requestKey]);

  // Latência medida: ping pelo canal de controle a cada 2 s.
  const sessionKey = state.phase === "active" ? state.sessionId : null;
  useEffect(() => {
    if (!sessionKey) return;
    const tick = () => {
      const s = stateRef.current;
      if (s.phase !== "active" || s.sessionId !== sessionKey) return;
      const n = ++pingN.current;
      pings.current.set(n, performance.now());
      if (pings.current.size > 8) pings.current.delete(pings.current.keys().next().value as number);
      sendCtl(s.target, { t: "ping", sessionId: s.sessionId, n });
    };
    tick();
    const id = setInterval(tick, PING_INTERVAL_MS);
    return () => clearInterval(id);
  }, [sessionKey, sendCtl]);

  // Sair da sala no meio do controle: solta tudo e avisa.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => () => stopRef.current(), []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { state, notice, dismissNotice, request, cancel, stop, send };
}
