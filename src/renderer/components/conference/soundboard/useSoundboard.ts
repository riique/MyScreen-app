import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioPresets,
  LocalAudioTrack,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type Room,
} from "livekit-client";
import type { SoundInfo } from "@shared/ipc";

/** Nome da trilha no SFU: quem grava ou lista trilhas reconhece o áudio por ela. */
export const SOUNDBOARD_TRACK_NAME = "soundboard";
/** Aviso na sala de que a lista do servidor mudou: quem está com ela aberta recarrega. */
const SOUNDS_CHANGED_TOPIC = "myscreen.sounds.changed";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/**
 * A trilha fica publicada um tempo depois do som acabar: o próximo áudio sai
 * na hora, sem publicar de novo e sem esperar os outros assinarem.
 */
const LINGER_MS = 45_000;
/**
 * Trilha recém-publicada: quem está na sala ainda não assinou e perderia o
 * começo do som. Espera a primeira assinatura, mas não mais que isso.
 */
const SUBSCRIBE_WAIT_MS = 1500;

type Output = { gain: GainNode; dest: MediaStreamAudioDestinationNode; track: LocalAudioTrack };

export interface SoundboardState {
  sounds: SoundInfo[] | null;
  listError: string | null;
  /** Áudio tocando agora (id), ou baixando para tocar. */
  playingId: string | null;
  loadingId: string | null;
  error: string | null;
  refresh: () => void;
  play: (sound: SoundInfo) => void;
  stop: () => void;
  /** Áudio do computador sendo enviado ao servidor (nome), ou null. */
  uploading: string | null;
  upload: (file: File) => void;
}

/**
 * Toca um áudio do servidor para a sala inteira. O som não é um aviso para
 * cada um tocar por conta própria: vira uma trilha de áudio publicada, então
 * todo mundo escuta pelo mesmo caminho das vozes — no app (com ou sem o botão
 * ligado, em qualquer versão) e no site. Quem tocou escuta pela saída da
 * chamada, sem a volta pelo SFU.
 */
export function useSoundboard(room: Room, roomToken: string): SoundboardState {
  const [sounds, setSounds] = useState<SoundInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const tokenRef = useRef(roomToken);
  tokenRef.current = roomToken;

  const ctxRef = useRef<AudioContext | null>(null);
  const buffers = useRef(new Map<string, AudioBuffer>());
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const outRef = useRef<Output | null>(null);
  // Publicação em andamento: dois cliques seguidos esperam a mesma.
  const outPending = useRef<{ out: Output; promise: Promise<Output> } | null>(null);
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cada clique invalida o anterior: um download lento não toca por cima.
  const playSeq = useRef(0);
  const disposed = useRef(false);

  const refresh = useCallback(() => {
    setListError(null);
    void window.myscreen.api.listSounds().then((r) => {
      if (disposed.current) return;
      if (r.ok) setSounds(r.data);
      else setListError(r.error);
    });
  }, []);

  const cancelLinger = useCallback(() => {
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
    lingerTimer.current = null;
  }, []);

  const unpublish = useCallback(() => {
    cancelLinger();
    const out = outRef.current;
    outRef.current = null;
    outPending.current = null;
    if (!out) return;
    out.gain.disconnect();
    if (room.localParticipant.getTrackPublication(Track.Source.Unknown)?.track === out.track) {
      void room.localParticipant.unpublishTrack(out.track).catch(() => {});
    }
    out.track.stop();
  }, [room, cancelLinger]);

  // Sem som por um tempo, sem trilha: ninguém fica com um "participante" mudo publicado.
  const unpublishLater = useCallback(() => {
    cancelLinger();
    lingerTimer.current = setTimeout(unpublish, LINGER_MS);
  }, [cancelLinger, unpublish]);

  const stopSource = useCallback(() => {
    const src = sourceRef.current;
    sourceRef.current = null;
    if (!src) return;
    src.onended = null;
    try {
      src.stop();
    } catch {
      // Já tinha parado.
    }
    src.disconnect();
  }, []);

  const stop = useCallback(() => {
    playSeq.current += 1;
    stopSource();
    if (outRef.current || outPending.current) unpublishLater();
    setPlayingId(null);
    setLoadingId(null);
  }, [stopSource, unpublishLater]);

  const context = useCallback(async (): Promise<AudioContext> => {
    let ctx = ctxRef.current;
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: "playback" });
      ctxRef.current = ctx;
    }
    // O eco local sai pelo mesmo alto-falante da chamada.
    const sink = room.getActiveDevice("audiooutput");
    const withSink = ctx as AudioContext & { sinkId?: string; setSinkId?: (id: string) => Promise<void> };
    if (withSink.setSinkId && sink && sink !== "default" && withSink.sinkId !== sink) {
      await withSink.setSinkId(sink).catch(() => {});
    }
    if (ctx.state === "suspended") await ctx.resume();
    return ctx;
  }, [room]);

  /** Espera alguém assinar a trilha nova, até SUBSCRIBE_WAIT_MS. Sala vazia: não espera. */
  const firstSubscriber = useCallback(
    (track: LocalAudioTrack) =>
      new Promise<void>((resolve) => {
        if (room.remoteParticipants.size === 0) return resolve();
        const done = () => {
          clearTimeout(timer);
          room.off(RoomEvent.LocalTrackSubscribed, onSub);
          resolve();
        };
        const onSub = (pub: LocalTrackPublication) => {
          if (pub.track === track) done();
        };
        const timer = setTimeout(done, SUBSCRIBE_WAIT_MS);
        room.on(RoomEvent.LocalTrackSubscribed, onSub);
      }),
    [room],
  );

  const output = useCallback(
    (ctx: AudioContext): Promise<Output> => {
      cancelLinger();
      if (outRef.current) return Promise.resolve(outRef.current);
      if (outPending.current) return outPending.current.promise;
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      gain.connect(dest);
      gain.connect(ctx.destination);
      const track = new LocalAudioTrack(dest.stream.getAudioTracks()[0], undefined, true);
      const out = { gain, dest, track };
      const pending = (async () => {
        try {
          // Escuta antes de publicar: a assinatura pode chegar antes do publishTrack voltar.
          const subscribed = firstSubscriber(track);
          await room.localParticipant.publishTrack(track, {
            source: Track.Source.Unknown,
            name: SOUNDBOARD_TRACK_NAME,
            audioPreset: AudioPresets.musicHighQualityStereo,
            forceStereo: true,
            dtx: false,
            red: false,
          });
          await subscribed;
        } catch (err) {
          if (outPending.current?.out === out) outPending.current = null;
          gain.disconnect();
          track.stop();
          throw err;
        }
        if (outPending.current?.out !== out) {
          // Desistiram (stop/desmontagem) enquanto publicava.
          gain.disconnect();
          void room.localParticipant.unpublishTrack(track).catch(() => {});
          track.stop();
          throw new Error("cancelado");
        }
        outPending.current = null;
        outRef.current = out;
        return out;
      })();
      outPending.current = { out, promise: pending };
      return pending;
    },
    [room, cancelLinger, firstSubscriber],
  );

  const play = useCallback(
    (sound: SoundInfo) => {
      const seq = ++playSeq.current;
      stopSource();
      setPlayingId(null);
      setError(null);
      setLoadingId(sound.id);
      void (async () => {
        try {
          const ctx = await context();
          // Publica enquanto baixa: as duas esperas correm juntas, não uma depois da outra.
          const outP = output(ctx);
          outP.catch(() => {});
          let buffer = buffers.current.get(sound.id);
          if (!buffer) {
            const r = await window.myscreen.api.fetchSound(sound.id);
            if (!r.ok) throw new Error(r.error);
            // decodeAudioData toma posse do ArrayBuffer: decodifica uma cópia.
            buffer = await ctx.decodeAudioData(r.data.slice().buffer);
            buffers.current.set(sound.id, buffer);
          }
          if (seq !== playSeq.current || disposed.current) return;
          const out = await outP;
          if (seq !== playSeq.current || disposed.current) return;
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(out.gain);
          src.onended = () => {
            if (sourceRef.current !== src) return;
            sourceRef.current = null;
            src.disconnect();
            setPlayingId(null);
            unpublishLater();
          };
          sourceRef.current = src;
          src.start();
          setPlayingId(sound.id);
        } catch (err) {
          if (seq !== playSeq.current) return;
          console.error("Não foi possível tocar o áudio:", err);
          const message = err instanceof Error ? err.message : "";
          setError(
            /decode|EncodingError|Unable to decode/i.test(message)
              ? "Esse arquivo não é um áudio que o app consiga tocar."
              : message || "Não foi possível tocar o áudio.",
          );
          unpublish();
        } finally {
          if (seq === playSeq.current) setLoadingId(null);
        }
      })();
    },
    [context, output, stopSource, unpublish, unpublishLater],
  );

  const upload = useCallback(
    (file: File) => {
      setError(null);
      if (file.size === 0) return setError("O arquivo está vazio.");
      if (file.size > MAX_UPLOAD_BYTES) return setError("Áudio grande demais. O limite é 25 MB.");
      setUploading(file.name);
      void (async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const r = await window.myscreen.api.uploadSound(tokenRef.current, file.name, bytes);
          if (disposed.current) return;
          if (!r.ok) throw new Error(r.error);
          refresh();
          // Os outros não precisam esperar reabrir o painel para ver o áudio novo.
          void room.localParticipant
            .publishData(new TextEncoder().encode(r.data.id), { reliable: true, topic: SOUNDS_CHANGED_TOPIC })
            .catch(() => {});
        } catch (err) {
          if (!disposed.current) setError(err instanceof Error && err.message ? err.message : "Não foi possível enviar o áudio.");
        } finally {
          if (!disposed.current) setUploading(null);
        }
      })();
    },
    [refresh, room],
  );

  // Alguém mandou um áudio: a lista já carregada se atualiza sozinha.
  const loaded = sounds !== null;
  useEffect(() => {
    if (!loaded) return;
    const onData = (_payload: Uint8Array, _p?: unknown, _k?: unknown, topic?: string) => {
      if (topic === SOUNDS_CHANGED_TOPIC) refresh();
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, loaded, refresh]);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      playSeq.current += 1;
      stopSource();
      unpublish();
      void ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    };
  }, [stopSource, unpublish]);

  return { sounds, listError, playingId, loadingId, error, refresh, play, stop, uploading, upload };
}
