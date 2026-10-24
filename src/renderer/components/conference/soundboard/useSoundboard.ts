import { useCallback, useEffect, useRef, useState } from "react";
import { AudioPresets, LocalAudioTrack, Track, type Room } from "livekit-client";
import type { SoundInfo } from "@shared/ipc";

/** Nome da trilha no SFU: quem grava ou lista trilhas reconhece o áudio por ela. */
export const SOUNDBOARD_TRACK_NAME = "soundboard";

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
}

/**
 * Toca um áudio do servidor para a sala inteira. O som não é um aviso para
 * cada um tocar por conta própria: vira uma trilha de áudio publicada, então
 * todo mundo escuta pelo mesmo caminho das vozes — no app (com ou sem o botão
 * ligado, em qualquer versão) e no site. Quem tocou escuta pela saída da
 * chamada, sem a volta pelo SFU.
 */
export function useSoundboard(room: Room): SoundboardState {
  const [sounds, setSounds] = useState<SoundInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const buffers = useRef(new Map<string, AudioBuffer>());
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const outRef = useRef<{ gain: GainNode; dest: MediaStreamAudioDestinationNode; track: LocalAudioTrack } | null>(null);
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

  const unpublish = useCallback(() => {
    const out = outRef.current;
    outRef.current = null;
    if (!out) return;
    out.gain.disconnect();
    if (room.localParticipant.getTrackPublication(Track.Source.Unknown)?.track === out.track) {
      void room.localParticipant.unpublishTrack(out.track).catch(() => {});
    }
    out.track.stop();
  }, [room]);

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
    unpublish();
    setPlayingId(null);
    setLoadingId(null);
  }, [stopSource, unpublish]);

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

  const output = useCallback(
    async (ctx: AudioContext) => {
      if (outRef.current) return outRef.current;
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      gain.connect(dest);
      gain.connect(ctx.destination);
      const track = new LocalAudioTrack(dest.stream.getAudioTracks()[0], undefined, true);
      const out = { gain, dest, track };
      outRef.current = out;
      try {
        await room.localParticipant.publishTrack(track, {
          source: Track.Source.Unknown,
          name: SOUNDBOARD_TRACK_NAME,
          audioPreset: AudioPresets.musicHighQualityStereo,
          forceStereo: true,
          dtx: false,
          red: false,
        });
      } catch (err) {
        if (outRef.current === out) outRef.current = null;
        gain.disconnect();
        track.stop();
        throw err;
      }
      return out;
    },
    [room],
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
          let buffer = buffers.current.get(sound.id);
          if (!buffer) {
            const r = await window.myscreen.api.fetchSound(sound.id);
            if (!r.ok) throw new Error(r.error);
            // decodeAudioData toma posse do ArrayBuffer: decodifica uma cópia.
            buffer = await ctx.decodeAudioData(r.data.slice().buffer);
            buffers.current.set(sound.id, buffer);
          }
          if (seq !== playSeq.current || disposed.current) return;
          const out = await output(ctx);
          if (seq !== playSeq.current || disposed.current) return;
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(out.gain);
          src.onended = () => {
            if (sourceRef.current !== src) return;
            sourceRef.current = null;
            src.disconnect();
            setPlayingId(null);
            // Sem som, sem trilha: ninguém fica com um "participante" mudo publicado.
            unpublish();
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
    [context, output, stopSource, unpublish],
  );

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

  return { sounds, listError, playingId, loadingId, error, refresh, play, stop };
}
