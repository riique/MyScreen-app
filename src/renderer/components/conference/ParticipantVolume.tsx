import { Track, TrackEvent, type RemoteParticipant, type RemoteTrack } from "livekit-client";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  MAX_VOICE_VOLUME,
  readScreenVolume,
  readVoiceVolume,
  screenVolumeKey,
  writeScreenVolume,
  writeVoiceVolume,
} from "@/lib/storage";
import { cn } from "@/lib/utils";

/** De qual som é o controle: a voz (microfone) ou o som da tela. */
export type VolumeKind = "voice" | "screen";

const KINDS = {
  voice: {
    source: Track.Source.Microphone,
    max: MAX_VOICE_VOLUME,
    read: readVoiceVolume,
    write: writeVoiceVolume,
    what: "voz",
  },
  screen: {
    source: Track.Source.ScreenShareAudio,
    max: 1,
    read: readScreenVolume,
    write: writeScreenVolume,
    what: "som da tela",
  },
} as const;

/** O mesmo volume aparece no quadro e na lista de participantes. */
const VOLUME_EVENT = "myscreen:volume-changed";
type VolumeDetail = { kind: VolumeKind; key: string; volume: number };

/**
 * Aplica à faixa que acabou de chegar o volume guardado para quem fala ou
 * compartilha. Toda vez que o microfone ou a tela para e volta é uma faixa
 * nova, que nasce em 100%: sem isto o controle mostrava o valor salvo e tocava
 * no máximo. O SDK só reaplica o volume no `attach` quando ele não é zero, e o
 * ganho do Web Audio nasce depois do evento — então reaplica também logo após
 * anexar.
 */
export function applySavedVolume(track: RemoteTrack, source: Track.Source, participant: RemoteParticipant) {
  if (track.kind !== Track.Kind.Audio) return;
  const kind: VolumeKind | null =
    source === Track.Source.Microphone ? "voice" : source === Track.Source.ScreenShareAudio ? "screen" : null;
  if (!kind) return;
  const { read } = KINDS[kind];
  const audio = track as RemoteTrack & { setVolume(v: number): void };
  const current = () => read(screenVolumeKey(participant));
  participant.setVolume(current(), source as Track.Source.Microphone | Track.Source.ScreenShareAudio);
  audio.setVolume(current());
  track.on(TrackEvent.ElementAttached, () => {
    setTimeout(() => audio.setVolume(current()), 0);
  });
}

/**
 * Volume de uma pessoa, só para quem ouve: mudo e um controle deslizante. Fica
 * guardado por pessoa (pelo nome) e vale nesta e nas próximas reuniões. A voz
 * vai até 200%, para quem fala baixo; o som da tela, até 100%.
 */
export function ParticipantVolume({
  participant,
  kind,
  tone = "overlay",
}: {
  participant: RemoteParticipant;
  kind: VolumeKind;
  /** "overlay" sobre o vídeo; "sheet" na lista de participantes. */
  tone?: "overlay" | "sheet";
}) {
  const { source, max, read, write, what } = KINDS[kind];
  const key = screenVolumeKey(participant);
  const [volume, setVolume] = useState(() => read(key));
  const lastAudible = useRef(volume > 0 ? volume : 1);

  // Outra pessoa no mesmo quadro: mostra o volume dela.
  useEffect(() => {
    const v = read(key);
    setVolume(v);
    if (v > 0) lastAudible.current = v;
  }, [key, read]);

  useEffect(() => {
    const onChange = (event: Event) => {
      const d = (event as CustomEvent<VolumeDetail>).detail;
      if (d.kind !== kind || d.key !== key) return;
      setVolume(d.volume);
      if (d.volume > 0) lastAudible.current = d.volume;
    };
    window.addEventListener(VOLUME_EVENT, onChange);
    return () => window.removeEventListener(VOLUME_EVENT, onChange);
  }, [kind, key]);

  useEffect(() => {
    participant.setVolume(volume, source as Track.Source.Microphone | Track.Source.ScreenShareAudio);
  }, [participant, volume, source]);

  const apply = (v: number) => {
    setVolume(v);
    if (v > 0) lastAudible.current = v;
    write(key, v);
    window.dispatchEvent(new CustomEvent<VolumeDetail>(VOLUME_EVENT, { detail: { kind, key, volume: v } }));
  };

  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const percent = Math.round(volume * 100);
  const name = participant.name || participant.identity;
  const muteLabel = volume === 0 ? `Ativar ${what} de ${name}` : `Silenciar ${what} de ${name}`;
  const overlay = tone === "overlay";

  return (
    <div
      className={cn(
        "flex items-center",
        overlay ? "rounded-md bg-black/55 text-white backdrop-blur-sm" : "gap-1 text-ink-2",
      )}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label={muteLabel}
        aria-pressed={volume === 0}
        title={muteLabel}
        onClick={() => apply(volume === 0 ? lastAudible.current : 0)}
        className={cn(
          "flex items-center justify-center transition-colors",
          overlay
            ? "size-8 rounded-md hover:bg-black/40"
            : cn(
                "size-7 hover:bg-band hover:text-ink [border-radius:var(--radius-cell)]",
                volume === 0 && "text-[#d92d20]",
              ),
        )}
      >
        <Icon size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <input
        type="range"
        min={0}
        max={max * 100}
        step={5}
        value={percent}
        onChange={(event) => apply(Number(event.target.value) / 100)}
        aria-label={`Volume da ${what} de ${name}`}
        aria-valuetext={`${percent}%`}
        title={`${what[0].toUpperCase()}${what.slice(1)}: ${percent}%`}
        className={cn("h-1 cursor-pointer", overlay ? "mr-2.5 w-20 accent-white" : "w-24 accent-[var(--color-signal)]")}
      />
      {overlay ? null : (
        <span className="w-10 text-right font-mono text-[0.6875rem] tabular-nums text-ink-3">{percent}%</span>
      )}
    </div>
  );
}
