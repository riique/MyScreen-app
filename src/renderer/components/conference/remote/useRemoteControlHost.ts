import { RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteCapabilities, RemoteConsentRequest, RemoteSessionInfo } from "@shared/ipc";
import { ATTR_BY, ATTR_DISPLAY, ATTR_VERSION, RC_VERSION, TOPIC_CTL, TOPIC_IN, encodeCtl, parseCtl, type Ctl } from "@shared/remote/protocol";

/**
 * Lado de quem é controlado, no renderer. Anuncia que o PC pode ser controlado
 * (atributos `rc.*`), repassa o que chega da rede ao processo principal SEM
 * interpretar o input, e mostra o diálogo quando o processo principal pede.
 * Não existe "permitir" que funcione daqui: a sessão nasce lá.
 */

export type HostShare = {
  kind: "screen" | "window";
  /** "2560x1440": tamanho físico do monitor, só informativo. */
  display: string | null;
};

export interface RemoteHost {
  capabilities: RemoteCapabilities | null;
  consent: RemoteConsentRequest | null;
  session: RemoteSessionInfo | null;
  decide(allow: boolean): void;
  stop(): void;
  pause(paused: boolean): void;
  /** Pedindo o UAC do "Liberar" agora. */
  elevating: boolean;
  /** Libera janelas de administrador para quem controla. */
  elevate(): void;
}

const END_TEXT: Record<string, string> = {
  user: "parou de controlar",
  "share-ended": "parou de controlar (a tela saiu do ar)",
  left: "parou de controlar (saiu da sala)",
  reconnected: "parou de controlar (a conexão caiu)",
  locked: "parou de controlar (o computador foi bloqueado)",
  panic: "parou de controlar (atalho de emergência)",
  error: "parou de controlar (erro)",
};

export function useRemoteControlHost({
  room,
  share,
  disabled,
  myName,
  sendChat,
}: {
  room: Room;
  share: HostShare | null;
  /** "Nunca aceitar pedidos de controle". */
  disabled: boolean;
  myName: string;
  sendChat: (text: string) => Promise<unknown>;
}): RemoteHost {
  const bridge = window.myscreen.remote;
  const [capabilities, setCapabilities] = useState<RemoteCapabilities | null>(null);
  const [consent, setConsent] = useState<RemoteConsentRequest | null>(null);
  const [session, setSession] = useState<RemoteSessionInfo | null>(null);
  const consentRef = useRef(consent);
  consentRef.current = consent;
  const sessionRef = useRef(session);
  const [elevating, setElevating] = useState(false);

  useEffect(() => {
    let alive = true;
    void bridge.capabilities().then((caps) => {
      if (alive) setCapabilities(caps);
    });
    return () => {
      alive = false;
    };
  }, [bridge]);

  // --- Anúncio: só com tela inteira no ar, injetor disponível e recurso ligado.
  const advertise = capabilities?.available === true && !disabled && share?.kind === "screen";
  const advertised = useRef(false);
  const display = share?.display ?? "";
  useEffect(() => {
    if (!advertise && !advertised.current) return;
    const attrs: Record<string, string> = advertise
      ? { [ATTR_VERSION]: String(RC_VERSION), [ATTR_DISPLAY]: display }
      : { [ATTR_VERSION]: "", [ATTR_DISPLAY]: "", [ATTR_BY]: "" };
    advertised.current = advertise;
    room.localParticipant.setAttributes(attrs).catch((error: unknown) => {
      // Servidor sem `canUpdateOwnMetadata` no token: o recurso só não aparece.
      console.warn("Não foi possível anunciar o controle remoto:", error);
    });
  }, [room, advertise, display]);

  // --- Rede → processo principal.
  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (!participant || (topic !== TOPIC_CTL && topic !== TOPIC_IN)) return;
      const from = { identity: participant.identity, sid: participant.sid, name: participant.name || participant.identity };
      if (topic === TOPIC_IN) {
        bridge.input(from, payload);
        return;
      }
      const msg = parseCtl(payload);
      if (msg) bridge.control(from, msg);
    };
    const onConnected = (p: RemoteParticipant) => bridge.peerSeen(p.identity, p.sid);
    const onDisconnected = (p: RemoteParticipant) => bridge.peerGone(p.identity);
    const onLost = () => bridge.roomLost();
    room
      .on(RoomEvent.DataReceived, onData)
      .on(RoomEvent.ParticipantConnected, onConnected)
      .on(RoomEvent.ParticipantDisconnected, onDisconnected)
      .on(RoomEvent.Reconnecting, onLost)
      .on(RoomEvent.Disconnected, onLost);
    return () => {
      room
        .off(RoomEvent.DataReceived, onData)
        .off(RoomEvent.ParticipantConnected, onConnected)
        .off(RoomEvent.ParticipantDisconnected, onDisconnected)
        .off(RoomEvent.Reconnecting, onLost)
        .off(RoomEvent.Disconnected, onLost);
      bridge.roomLost();
    };
  }, [room, bridge]);

  // --- Processo principal → rede e interface.
  const chatRef = useRef({ sendChat, myName });
  chatRef.current = { sendChat, myName };
  useEffect(() => {
    const offSend = bridge.onSend((to, msg) => {
      void room.localParticipant
        .publishData(encodeCtl(msg as Ctl), { reliable: true, topic: TOPIC_CTL, destinationIdentities: [to] })
        .catch((error: unknown) => console.warn("rc.ctl não saiu:", error));
    });
    const offConsent = bridge.onConsent(setConsent);
    const offClosed = bridge.onConsentClosed((reqId) => setConsent((cur) => (cur?.reqId === reqId ? null : cur)));
    const offSession = bridge.onSession(({ session: next, ended }) => {
      const prev = sessionRef.current;
      sessionRef.current = next;
      setSession(next);
      const { sendChat: chat, myName: me } = chatRef.current;
      // Transparência para a sala inteira: uma linha no chat quando começa e quando acaba.
      if (next && !prev) void chat(`🖱 ${next.name} começou a controlar a tela de ${me}.`).catch(() => {});
      if (!next && ended) void chat(`🖱 ${ended.name} ${END_TEXT[ended.reason] ?? "parou de controlar"}.`).catch(() => {});
      room.localParticipant
        .setAttributes({ [ATTR_BY]: next ? next.identity : "" })
        .catch(() => {});
    });
    return () => {
      offSend();
      offConsent();
      offClosed();
      offSession();
    };
  }, [room, bridge]);

  const decide = useCallback(
    (allow: boolean) => {
      const cur = consentRef.current;
      if (cur) bridge.decide(cur.reqId, allow);
      setConsent(null);
    },
    [bridge],
  );

  return {
    capabilities,
    consent,
    session,
    decide,
    stop: () => bridge.stop(),
    pause: (paused) => bridge.pause(paused),
    elevating,
    elevate: () => {
      if (elevating) return;
      setElevating(true);
      void bridge
        .elevate()
        .catch(() => false)
        .finally(() => setElevating(false));
    },
  };
}
