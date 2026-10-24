import { LoaderCircle, Music, Play, RotateCw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { SoundboardState } from "./useSoundboard";

/**
 * O botão de áudios da doca (ligado em Configurações): abre a lista do
 * servidor; um clique toca para a sala inteira, outro clique no mesmo para.
 */
export function SoundboardControl({ board }: { board: SoundboardState }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { sounds, listError, playingId, loadingId, error, refresh, play, stop } = board;

  // A lista vem de novo a cada abertura: arquivo novo no servidor aparece sem sair da sala.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const busy = playingId !== null || loadingId !== null;
  const label = playingId ? "Áudio tocando para a sala" : "Áudios";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${label}: escolher`}
        title={label}
        className={cn(
          "flex h-11 min-w-11 items-center justify-center gap-2 rounded-full border px-3.5 transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96] sm:px-4",
          busy
            ? "border-signal bg-signal text-on-signal hover:border-signal-2 hover:bg-signal-2"
            : "border-rule-2 bg-sheet text-ink hover:border-rule-3 hover:bg-band",
        )}
      >
        <Music size={18} strokeWidth={1.75} aria-hidden className={cn(playingId && "animate-pulse")} />
        <span className="hidden text-[0.8125rem] font-semibold sm:inline">Áudios</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Áudios"
          className="absolute bottom-full left-1/2 z-30 mb-3 flex max-h-[60vh] w-[20rem] -translate-x-1/2 flex-col border border-rule-2 bg-sheet shadow-overlay [border-radius:var(--radius-sheet)]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-3">
            <div className="min-w-0">
              <span className="block text-[0.875rem] font-semibold text-ink">Áudios</span>
              <span className="block text-[0.75rem] text-ink-3">Toca para todo mundo na sala.</span>
            </div>
            {playingId ? (
              <button
                type="button"
                onClick={stop}
                className="inline-flex shrink-0 items-center gap-1.5 border border-alert-line bg-alert-wash px-2.5 py-1 text-[0.75rem] font-semibold text-alert transition-colors hover:bg-alert-wash-2 [border-radius:var(--radius-cell)]"
              >
                <Square size={12} strokeWidth={2} aria-hidden />
                Parar
              </button>
            ) : (
              <button
                type="button"
                onClick={refresh}
                aria-label="Atualizar a lista"
                title="Atualizar a lista"
                className="shrink-0 p-1.5 text-ink-3 transition-colors hover:text-ink"
              >
                <RotateCw size={15} strokeWidth={1.75} aria-hidden />
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {listError ? (
              <p className="px-4 py-6 text-center text-[0.8125rem] text-warn">{listError}</p>
            ) : sounds === null ? (
              <p className="px-4 py-6 text-center text-[0.8125rem] text-ink-3">Carregando…</p>
            ) : sounds.length === 0 ? (
              <p className="px-4 py-6 text-center text-[0.8125rem] text-ink-3">Nenhum áudio no servidor ainda.</p>
            ) : (
              <ul aria-label="Áudios do servidor">
                {sounds.map((s) => {
                  const playing = playingId === s.id;
                  const loading = loadingId === s.id;
                  return (
                    <li key={s.id} className="border-b border-rule last:border-b-0">
                      <button
                        type="button"
                        onClick={() => (playing ? stop() : play(s))}
                        aria-pressed={playing}
                        className={cn(
                          "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-band",
                          playing && "bg-band",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "flex size-7 shrink-0 items-center justify-center rounded-full border",
                            playing ? "border-signal bg-signal text-on-signal" : "border-rule-2 text-ink-2",
                          )}
                        >
                          {loading ? (
                            <LoaderCircle size={14} strokeWidth={2} className="animate-spin" />
                          ) : playing ? (
                            <Square size={11} strokeWidth={2.25} />
                          ) : (
                            <Play size={13} strokeWidth={2} className="translate-x-px" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[0.875rem] text-ink">{s.name}</span>
                        <span className="sr-only">{playing ? " (tocando, clique para parar)" : ""}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {error ? (
            <p role="alert" className="border-t border-rule px-4 py-2.5 text-[0.8125rem] text-warn">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
