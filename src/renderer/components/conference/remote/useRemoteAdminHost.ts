import { RoomEvent, type Room } from "livekit-client";
import { useEffect, useState } from "react";
import type { RemoteAdminEvent } from "@shared/ipc";
import { ATTR_UAC, MAX_UAC_FRAME_BYTES, TOPIC_CTL, TOPIC_UAC_FRAME, encodeCtl } from "@shared/remote/protocol";
import { createUacKeyPair, deriveUacKey, encryptUacFrame } from "./uacVideoCrypto";

type Target = Extract<RemoteAdminEvent, { t: "authorized" }>;
type Frame = Extract<RemoteAdminEvent, { t: "frame" }>;

function jpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.76));
}

/** Só o stream dirigido e cifrado contém a imagem. O compartilhamento e o gravador ficam na trilha normal. */
export function useRemoteAdminHost(room: Room): boolean {
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const bridge = window.myscreen.remote;
    const local = room.localParticipant;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    let target: Target | null = null;
    let keys: Promise<{ key: CryptoKey; publicKey: string } | null> | null = null;
    let pending: Frame | null = null;
    let announced: number | null = null;
    let secure = false;
    let sending = false;
    let connected = true;
    let desktopEpoch = 0;

    function showWaiting(value: boolean) {
      void local.setAttributes({ [ATTR_UAC]: value ? "1" : "" }).catch(() => {});
    }

    function resetDesktop() {
      pending = null;
      announced = null;
      desktopEpoch++;
      context?.clearRect(0, 0, canvas.width, canvas.height);
    }

    function close() {
      resetDesktop();
      if (secure) showWaiting(false);
      secure = false;
      target = null;
      keys = null;
      setAuthorized(false);
    }

    async function flush() {
      if (sending || !pending || !target || !keys || !context) return;
      sending = true;
      const viewer = target;
      const frame = pending;
      pending = null;
      const epoch = desktopEpoch;
      const active = () => connected && secure && viewer === target && epoch === desktopEpoch
        && room.remoteParticipants.get(viewer.identity)?.sid === viewer.sid;
      try {
        const sessionKeys = await keys;
        if (!active()) return;
        if (!sessionKeys) throw new Error("Chave do vídeo protegido indisponível");
        canvas.width = frame.width;
        canvas.height = frame.height;
        context.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
        const image = await jpeg(canvas);
        if (!image || image.size > MAX_UAC_FRAME_BYTES - 28 || !active()) return;
        const bytes = await encryptUacFrame(sessionKeys.key, viewer.sessionId, frame.generation, await image.arrayBuffer());
        if (!active()) return;
        if (announced !== frame.generation) {
          await local.publishData(encodeCtl({
            t: "admin-view", sessionId: viewer.sessionId, desktop: "prompt",
            generation: frame.generation, publicKey: sessionKeys.publicKey,
          }), { reliable: true, topic: TOPIC_CTL, destinationIdentities: [viewer.identity] });
          if (!active()) return;
          announced = frame.generation;
        }
        const writer = await local.streamBytes({
          topic: TOPIC_UAC_FRAME, destinationIdentities: [viewer.identity], totalSize: bytes.length,
          attributes: { session: viewer.sessionId, generation: String(frame.generation) },
        });
        try {
          if (active()) await writer.write(bytes);
        } finally {
          await writer.close();
        }
      } catch {
        if (active()) {
          close();
          bridge.stopAdmin();
        }
      } finally {
        sending = false;
        if (pending) void flush();
      }
    }

    const off = bridge.onAdmin((event) => {
      if (event.t === "authorized") {
        if (!connected || !context) {
          bridge.stopAdmin();
          return;
        }
        close();
        target = event;
        keys = createUacKeyPair()
          .then(async ({ privateKey, publicKey }) => ({ key: await deriveUacKey(privateKey, event.publicKey), publicKey }))
          .catch(() => null);
        setAuthorized(true);
        return;
      }
      if (!target || event.sessionId !== target.sessionId) return;
      if (event.t === "end") {
        close();
      } else if (event.t === "desktop") {
        resetDesktop();
        if (event.secure !== secure) {
          secure = event.secure;
          showWaiting(secure);
        }
      } else if (event.t === "frame" && secure) {
        pending = event;
        void flush();
      }
    });

    const lost = () => {
      connected = false;
      close();
      bridge.stopAdmin();
    };
    const reconnected = () => {
      connected = true;
      showWaiting(false);
    };
    const peerChanged = () => {
      if (target && room.remoteParticipants.get(target.identity)?.sid !== target.sid) {
        close();
        bridge.stopAdmin();
      }
    };
    room.on(RoomEvent.ParticipantConnected, peerChanged)
      .on(RoomEvent.ParticipantDisconnected, peerChanged)
      .on(RoomEvent.Reconnecting, lost)
      .on(RoomEvent.SignalReconnecting, lost)
      .on(RoomEvent.Disconnected, lost)
      .on(RoomEvent.Reconnected, reconnected);
    return () => {
      off();
      lost();
      room.off(RoomEvent.ParticipantConnected, peerChanged)
        .off(RoomEvent.ParticipantDisconnected, peerChanged)
        .off(RoomEvent.Reconnecting, lost)
        .off(RoomEvent.SignalReconnecting, lost)
        .off(RoomEvent.Disconnected, lost)
        .off(RoomEvent.Reconnected, reconnected);
    };
  }, [room]);

  return authorized;
}
