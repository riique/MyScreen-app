import { Pause, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { ControlBarBridge, ControlBarState } from "@shared/ipc";
import { PANIC_SHORTCUT_LABEL } from "@/components/conference/remote/labels";

declare global {
  interface Window {
    myscreenBar?: ControlBarBridge;
  }
}

/**
 * A barra vermelha no topo do monitor controlado. Janela própria, sempre no
 * topo e fora da captura: quem controla não a vê e não clica nela.
 */
export function ControlBar() {
  const bridge = window.myscreenBar;
  const [state, setState] = useState<ControlBarState | null>(null);

  useEffect(() => bridge?.onState(setState), [bridge]);

  if (!bridge) return null;
  const name = state?.name ?? "Alguém";
  const paused = state?.paused ?? false;

  return (
    <div
      className="flex h-screen w-screen items-center gap-2 overflow-hidden bg-[#b42318] pr-1.5 pl-3.5 text-white select-none"
      title={`Parar: ${PANIC_SHORTCUT_LABEL}`}
    >
      <span aria-hidden className={`size-2.5 shrink-0 rounded-full bg-white ${paused ? "" : "animate-pulse"}`} />
      <p className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold">
        {paused ? `Controle de ${name} pausado` : `${name} está controlando`}
        {state?.elevated && !paused ? (
          <span className="font-normal text-white/85"> · janela de administrador: sem acesso</span>
        ) : null}
      </p>
      <button
        type="button"
        onClick={() => bridge.pause(!paused)}
        className="flex h-8 items-center gap-1.5 rounded px-2.5 text-[0.75rem] font-semibold transition-colors hover:bg-white/15"
      >
        {paused ? <Play size={13} strokeWidth={2} aria-hidden /> : <Pause size={13} strokeWidth={2} aria-hidden />}
        {paused ? "Retomar" : "Pausar"}
      </button>
      <button
        type="button"
        onClick={() => bridge.stop()}
        className="flex h-8 items-center gap-1.5 rounded bg-white px-3 text-[0.75rem] font-bold text-[#b42318] transition-colors hover:bg-white/90"
      >
        <Square size={11} strokeWidth={2.5} aria-hidden className="fill-current" />
        Parar
      </button>
    </div>
  );
}
