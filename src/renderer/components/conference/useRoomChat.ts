import type { ReceivedChatMessage } from "@livekit/components-react";
import { RoomEvent, type Room } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoredChatMessage } from "@shared/ipc";

/** Um anexo na tela: o `File` que chegou pela sala, ou um id do histórico no servidor. */
export interface ChatAttachment {
  name: string;
  size: number;
  type: string;
  file?: File;
  remoteId?: string;
}

/** Uma linha do chat, venha ela da sala agora ou do histórico guardado. */
export interface ChatEntry {
  id: string;
  timestamp: number;
  message: string;
  attributes: Record<string, string>;
  fromIdentity: string;
  fromName: string;
  isLocal: boolean;
  files: ChatAttachment[];
}

export type ChatSend = (
  message: string,
  options?: { attachments?: File[]; attributes?: Record<string, string> },
) => Promise<unknown>;

/** Aviso na sala: "apaguei a mensagem X". Cada um tira da própria tela. */
const DELETE_TOPIC = "myscreen.chat.delete";

export interface RoomChat {
  entries: ChatEntry[];
  send: ChatSend;
  remove: (id: string) => Promise<void>;
  /** Busca os bytes de um anexo do histórico (com cache). */
  loadFile: (attachment: ChatAttachment) => Promise<Blob>;
}

/**
 * O chat da sala com memória. O que vai pela sala continua indo pelo canal de
 * dados (rápido, e o site também recebe); cada um guarda no servidor o que
 * mandou, com os anexos. Ao entrar, o histórico guardado aparece antes das
 * mensagens ao vivo — sair, reiniciar o app e voltar para a mesma sala traz
 * a conversa de volta.
 */
export function useRoomChat({
  room,
  roomId,
  roomToken,
  live,
  sendLive,
}: {
  room: Room;
  roomId: string;
  roomToken: string;
  live: ReceivedChatMessage[];
  sendLive: (message: string, options?: { attachments?: File[]; attributes?: Record<string, string> }) => Promise<ReceivedChatMessage>;
}): RoomChat {
  const [history, setHistory] = useState<StoredChatMessage[]>([]);
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set());
  const tokenRef = useRef(roomToken);
  tokenRef.current = roomToken;
  const fileCache = useRef(new Map<string, Promise<Blob>>());

  useEffect(() => {
    let alive = true;
    void window.myscreen.api.chatHistory(roomId, tokenRef.current).then((r) => {
      if (!alive) return;
      if (r.ok) setHistory(r.data);
      else console.warn("Histórico do chat indisponível:", r.error);
    });
    return () => {
      alive = false;
    };
  }, [roomId]);

  const myIdentity = room.localParticipant.identity;

  const entries = useMemo(() => {
    const liveIds = new Set(live.map((m) => m.id));
    const out: ChatEntry[] = [];
    for (const m of history) {
      if (liveIds.has(m.id)) continue;
      out.push({
        id: m.id,
        timestamp: m.timestamp,
        message: m.message,
        attributes: m.attributes,
        fromIdentity: m.fromIdentity,
        fromName: m.fromName,
        isLocal: m.fromIdentity !== "" && m.fromIdentity === myIdentity,
        files: m.files.map((f) => ({ name: f.name, size: f.size, type: f.type, remoteId: f.id })),
      });
    }
    for (const m of live) {
      out.push({
        id: m.id,
        timestamp: m.timestamp,
        message: m.message,
        attributes: m.attributes ?? {},
        fromIdentity: m.from?.identity ?? "",
        fromName: m.from?.name || m.from?.identity || "",
        // `isLocal` é a autoridade do SDK, não o apelido.
        isLocal: m.from?.isLocal === true,
        files: (m.attachedFiles ?? []).map((f) => ({ name: f.name, size: f.size, type: f.type, file: f })),
      });
    }
    return out.filter((e) => !deleted.has(e.id)).sort((a, b) => a.timestamp - b.timestamp);
  }, [history, live, deleted, myIdentity]);

  // Apagar só vale vindo do autor: compara quem avisou com quem mandou.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: { identity: string }, _k?: unknown, topic?: string) => {
      if (topic !== DELETE_TOPIC || !participant) return;
      const id = new TextDecoder().decode(payload).slice(0, 128);
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry || entry.fromIdentity !== participant.identity) return;
      setDeleted((cur) => new Set(cur).add(id));
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  const send = useCallback<ChatSend>(
    async (message, options) => {
      const sent = await sendLive(message, options);
      // Guardar é melhor-esforço: a mensagem já chegou a quem está na sala.
      void (async () => {
        const fileIds: string[] = [];
        for (const file of options?.attachments ?? []) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const r = await window.myscreen.api.chatUploadFile(roomId, tokenRef.current, {
            name: file.name || "arquivo",
            type: file.type,
            bytes,
          });
          if (!r.ok) throw new Error(r.error);
          fileIds.push(r.data.id);
        }
        const r = await window.myscreen.api.chatAppend(roomId, tokenRef.current, {
          id: sent.id,
          timestamp: sent.timestamp,
          message,
          attributes: options?.attributes ?? {},
          fileIds,
        });
        if (!r.ok) throw new Error(r.error);
      })().catch((err) => console.warn("Mensagem não ficou no histórico:", err));
      return sent;
    },
    [roomId, sendLive],
  );

  const remove = useCallback(
    async (id: string) => {
      const r = await window.myscreen.api.chatDelete(roomId, tokenRef.current, id);
      // Servidor sem histórico (rota ausente): ainda some da tela de todos.
      if (!r.ok && r.status !== 404 && r.status !== 405) throw new Error(r.error);
      setDeleted((cur) => new Set(cur).add(id));
      await room.localParticipant
        .publishData(new TextEncoder().encode(id), { reliable: true, topic: DELETE_TOPIC })
        .catch(() => {});
    },
    [room, roomId],
  );

  const loadFile = useCallback(
    (a: ChatAttachment): Promise<Blob> => {
      if (a.file) return Promise.resolve(a.file);
      const id = a.remoteId;
      if (!id) return Promise.reject(new Error("Anexo sem origem."));
      let p = fileCache.current.get(id);
      if (!p) {
        p = window.myscreen.api.chatFile(roomId, tokenRef.current, id).then((r) => {
          if (!r.ok) throw new Error(r.error);
          return new Blob([r.data as Uint8Array<ArrayBuffer>], { type: a.type });
        });
        p.catch(() => fileCache.current.delete(id));
        fileCache.current.set(id, p);
      }
      return p;
    },
    [roomId],
  );

  return { entries, send, remove, loadFile };
}
