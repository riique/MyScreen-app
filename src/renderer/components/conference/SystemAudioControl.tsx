import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SystemAudioPrefs } from "@/components/capture/capturePrefs";
import { CheckCell } from "@/components/sheet";
import { cn } from "@/lib/utils";

/**
 * O som do PC enquanto a tela está no ar: medidor, pausar, normalizar e o
 * volume enviado (0–400%), como no MyScreen Áudio. Mudanças valem na hora,
 * sem reiniciar a captura.
 */
export function SystemAudioControl({
  prefs,
  paused,
  onChange,
  onPausedChange,
}: {
  prefs: SystemAudioPrefs;
  paused: boolean;
  onChange: (patch: Partial<SystemAudioPrefs>) => void;
  onPausedChange: (paused: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(0);
  const [agcDb, setAgcDb] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      window.myscreen.audio.onLevel((l) => {
        setLevel(l.level);
        setAgcDb(l.agcDb);
      }),
    [],
  );

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

  const meter = `${Math.round(Math.sqrt(Math.min(1, Math.max(0, level))) * 100)}%`;
  const label = paused ? "Som do PC pausado" : "Som do PC";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${label}: ajustes`}
        title={label}
        className={cn(
          "flex h-11 items-center gap-2 rounded-full border px-3.5 transition-colors",
          paused
            ? "border-alert-line bg-alert-wash text-alert hover:bg-alert-wash-2"
            : "border-rule-2 bg-sheet text-ink hover:border-rule-3 hover:bg-band",
        )}
      >
        {paused ? <VolumeX size={18} strokeWidth={1.75} aria-hidden /> : <Volume2 size={18} strokeWidth={1.75} aria-hidden />}
        <span aria-hidden className="h-1.5 w-10 overflow-hidden rounded-full bg-band-2">
          <span className="block h-full bg-signal transition-[width] duration-100" style={{ width: paused ? 0 : meter }} />
        </span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Som do PC"
          className="absolute bottom-full left-1/2 z-30 mb-3 w-[20rem] -translate-x-1/2 border border-rule-2 bg-sheet shadow-overlay [border-radius:var(--radius-sheet)]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-3">
            <span className="text-[0.875rem] font-semibold text-ink">Som do PC</span>
            <button
              type="button"
              onClick={() => onPausedChange(!paused)}
              aria-pressed={paused}
              className="border border-rule-2 px-2.5 py-1 text-[0.75rem] font-semibold text-ink transition-colors hover:bg-band [border-radius:var(--radius-cell)]"
            >
              {paused ? "Retomar" : "Pausar"}
            </button>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="label-col">Nível enviado</span>
              <span className="font-mono text-[0.6875rem] text-ink-3">
                {prefs.normalize ? `normalização ${agcDb >= 0 ? "+" : ""}${agcDb.toFixed(0)} dB` : "sem normalização"}
              </span>
            </div>
            <div className="mt-2 h-2 w-full border border-rule bg-band" role="meter" aria-label="Nível do som do PC" aria-valuemin={0} aria-valuemax={100} aria-valuenow={paused ? 0 : Math.round(Math.sqrt(level) * 100)}>
              <div className="h-full bg-signal transition-[width] duration-100" style={{ width: paused ? 0 : meter }} />
            </div>
          </div>
          <div className="border-t border-rule">
            <CheckCell
              name="sa-normalize"
              checked={prefs.normalize}
              onChange={(v) => onChange({ normalize: v })}
              label="Normalizar volume (recomendado)"
              note="Leva o som a um nível constante, sem estourar nos picos."
            />
          </div>
          <div className="border-t border-rule px-4 py-3">
            <label htmlFor="sa-gain" className="flex items-baseline justify-between">
              <span className="label-col">Volume enviado</span>
              <span className="font-mono text-[0.75rem] text-ink">{prefs.gainPct}%</span>
            </label>
            <input
              id="sa-gain"
              type="range"
              min={0}
              max={400}
              step={25}
              value={prefs.gainPct}
              onChange={(e) => onChange({ gainPct: Number(e.target.value) })}
              className="mt-2 w-full accent-[var(--color-signal)]"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
