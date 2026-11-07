import { Circle, FolderOpen, MonitorUp, Square, Video, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Track } from "livekit-client";
import { formatElapsed } from "@shared/recording";
import { cn } from "@/lib/utils";
import type { RecordAudio, RecordingInfo, RecordTarget } from "./engine";
import { recordKey } from "./engine";

/** Uma câmera ou tela que pode ser gravada agora. */
export interface RecordOption extends RecordTarget {
  /** Nome da pessoa, para agrupar as linhas. */
  person: string;
  isLocal: boolean;
  /** Tem imagem agora (câmera ligada, tela no ar). */
  live: boolean;
}

/**
 * Escolher o que gravar: cada câmera e cada tela da sala é uma linha, de
 * qualquer pessoa. Cada linha marcada vira um arquivo próprio, com som. O que
 * já está gravando aparece na mesma lista, com o tempo e o botão de parar.
 */
export function RecordDialog({
  open,
  options,
  recordings,
  lastFile,
  onClose,
  onStart,
  onStop,
  onStopAll,
  onReveal,
}: {
  open: boolean;
  options: RecordOption[];
  recordings: RecordingInfo[];
  lastFile: string | null;
  onClose: () => void;
  onStart: (targets: RecordTarget[], audio: RecordAudio) => void;
  onStop: (key: string) => void;
  onStopAll: () => void;
  onReveal: (file: string | null) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [audio, setAudio] = useState<RecordAudio>(readAudioMode);
  const now = useNow(open && recordings.length > 0);

  // Ao abrir, já vem marcado o que está no ar e ainda não grava.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const recordingsRef = useRef(recordings);
  recordingsRef.current = recordings;
  useEffect(() => {
    if (!open) return;
    const busy = new Set(recordingsRef.current.map((r) => r.key));
    const live = optionsRef.current.filter((o) => o.live && !busy.has(keyOf(o)));
    // Com tela no ar, a sugestão é a tela; sem, as câmeras.
    const screens = live.filter((o) => o.source === Track.Source.ScreenShare);
    setSelected((screens.length > 0 ? screens : live).map(keyOf));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const recordingByKey = new Map(recordings.map((r) => [r.key, r]));
  // Uma gravação cuja fonte sumiu da sala continua listada (e gravando).
  const rows: RecordOption[] = [...options];
  for (const r of recordings) {
    if (rows.some((o) => keyOf(o) === r.key)) continue;
    const identity = r.key.slice(0, r.key.lastIndexOf(":"));
    rows.push({ identity, source: r.source, label: r.label, person: r.label, isLocal: false, live: false });
  }
  const pickable = selected.filter((k) => rows.some((o) => keyOf(o) === k) && !recordingByKey.has(k));

  const toggle = (key: string) =>
    setSelected((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));

  const start = () => {
    const targets = rows
      .filter((o) => pickable.includes(keyOf(o)))
      .map(({ identity, source, label }) => ({ identity, source, label }));
    if (targets.length === 0) return;
    writeAudioMode(audio);
    onStart(targets, audio);
    setSelected([]);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-scrim p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-dialog-title"
        className="flex max-h-[92vh] w-full max-w-[34rem] flex-col overflow-hidden border border-rule-2 bg-sheet shadow-overlay outline-none [border-radius:var(--radius-sheet)]"
      >
        <div className="flex items-start justify-between gap-6 px-6 pt-5 pb-3">
          <div className="min-w-0">
            <h2 id="record-dialog-title" className="text-[1.125rem] font-semibold tracking-[-0.015em] text-ink">
              Gravar
            </h2>
            <p className="mt-1 text-[0.875rem] leading-[1.5] text-ink-2">
              Escolha quem gravar. Cada câmera e cada tela vira um arquivo separado, com som, na pasta Vídeos\MyScreen.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="shrink-0 p-1.5 text-ink-3 transition-colors hover:text-ink"
          >
            <X size={18} strokeWidth={1.75} aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-rule">
          {rows.length === 0 ? (
            <p className="px-6 py-10 text-center text-[0.875rem] text-ink-3">
              Ninguém está com câmera ligada ou tela compartilhada agora.
            </p>
          ) : (
            <ul aria-label="Fontes para gravar">
              {rows.map((o) => {
                const key = keyOf(o);
                const rec = recordingByKey.get(key);
                const Icon = o.source === Track.Source.ScreenShare ? MonitorUp : Video;
                const checked = selected.includes(key);
                return (
                  <li key={key} className="flex items-center gap-3 border-b border-rule px-5 py-2.5 last:border-b-0">
                    {rec ? (
                      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
                        <span className="size-2.5 animate-pulse rounded-full bg-[#d92d20]" />
                      </span>
                    ) : (
                      <input
                        id={`rec-${key}`}
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(key)}
                        className="size-4 shrink-0 cursor-pointer accent-[var(--color-signal)]"
                      />
                    )}
                    <label
                      htmlFor={rec ? undefined : `rec-${key}`}
                      className={cn("flex min-w-0 flex-1 items-center gap-2", !rec && "cursor-pointer")}
                    >
                      <Icon size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-2" />
                      <span className="min-w-0">
                        <span className="block truncate text-[0.875rem] font-medium text-ink">{o.label}</span>
                        <span className="block text-[0.75rem] text-ink-3">
                          {rec
                            ? `Gravando · ${formatElapsed(now - rec.startedAt)}`
                            : o.live
                              ? o.source === Track.Source.ScreenShare
                                ? "Tela no ar"
                                : "Câmera ligada"
                              : o.source === Track.Source.ScreenShare
                                ? "Tela pausada — grava um quadro de aviso até voltar"
                                : "Câmera desligada — grava um quadro de aviso até ligar"}
                        </span>
                      </span>
                    </label>
                    {rec ? (
                      <button
                        type="button"
                        onClick={() => onStop(key)}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 border border-alert-line bg-alert-wash px-2.5 text-[0.75rem] font-semibold text-alert transition-colors hover:bg-alert-wash-2 [border-radius:var(--radius-cell)]"
                      >
                        <Square size={12} strokeWidth={2} aria-hidden />
                        Parar
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <fieldset className="border-t border-rule px-6 py-3">
          <legend className="sr-only">Som da gravação</legend>
          <p className="mb-2 text-[0.75rem] font-semibold tracking-[0.02em] text-ink-2 uppercase">Som</p>
          <div className="flex flex-col gap-1.5">
            <AudioChoice
              checked={audio === "call"}
              onChange={() => setAudio("call")}
              label="A chamada inteira"
              note="Todas as vozes e o som das telas compartilhadas."
            />
            <AudioChoice
              checked={audio === "own"}
              onChange={() => setAudio("own")}
              label="Só de quem está sendo gravado"
              note="Câmera: a voz da pessoa. Tela: o som da tela e a voz de quem compartilha."
            />
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-6 py-4">
          <button
            type="button"
            onClick={() => onReveal(lastFile)}
            className="inline-flex items-center gap-1.5 text-[0.8125rem] text-ink-2 transition-colors hover:text-ink"
          >
            <FolderOpen size={15} strokeWidth={1.75} aria-hidden />
            {lastFile ? "Mostrar a última gravação" : "Abrir a pasta"}
          </button>
          <div className="flex shrink-0 gap-2">
            {recordings.length > 0 ? (
              <button
                type="button"
                onClick={onStopAll}
                className="inline-flex items-center gap-2 border border-alert-line bg-alert-wash px-4 py-2.5 text-[0.875rem] font-semibold text-alert transition-colors hover:bg-alert-wash-2 [border-radius:var(--radius-sheet)]"
              >
                <Square size={14} strokeWidth={2} aria-hidden />
                Parar tudo
              </button>
            ) : null}
            <button
              type="button"
              disabled={pickable.length === 0}
              onClick={start}
              className="inline-flex items-center justify-center gap-2 border border-[#b42318] bg-[#b42318] px-5 py-2.5 text-[0.875rem] font-semibold text-white transition-colors hover:bg-[#912018] disabled:cursor-not-allowed disabled:opacity-50 [border-radius:var(--radius-sheet)]"
            >
              <Circle size={14} strokeWidth={0} fill="currentColor" aria-hidden />
              {pickable.length > 1 ? `Gravar ${pickable.length}` : "Gravar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AudioChoice({
  checked,
  onChange,
  label,
  note,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  note: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="radio"
        name="record-audio"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--color-signal)]"
      />
      <span className="min-w-0">
        <span className="block text-[0.875rem] text-ink">{label}</span>
        <span className="block text-[0.75rem] text-ink-3">{note}</span>
      </span>
    </label>
  );
}

function keyOf(o: RecordTarget): string {
  return recordKey(o.identity, o.source);
}

/** Relógio que anda de segundo em segundo enquanto `on`. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

const AUDIO_MODE_KEY = "myscreen:record-audio";

function readAudioMode(): RecordAudio {
  try {
    return localStorage.getItem(AUDIO_MODE_KEY) === "own" ? "own" : "call";
  } catch {
    return "call";
  }
}

function writeAudioMode(mode: RecordAudio) {
  try {
    localStorage.setItem(AUDIO_MODE_KEY, mode);
  } catch {
    // Sem storage, a escolha vale só agora.
  }
}
