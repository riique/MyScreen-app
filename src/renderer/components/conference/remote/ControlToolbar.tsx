import { Keyboard, Maximize2, MousePointer2, Send, X } from "lucide-react";
import { useState } from "react";
import { MAX_TEXT_BYTES, type InputEvent } from "@shared/remote/protocol";
import type { ViewerState } from "./useRemoteControlViewer";

/**
 * Barra fina no topo do quadro controlado: de quem é a tela, a latência
 * MEDIDA (sem medida aparece `--`), tela cheia, enviar texto e soltar.
 */
export function ControlToolbar({
  state,
  hidden,
  onFullscreen,
  onStop,
  send,
}: {
  state: Extract<ViewerState, { phase: "active" }>;
  hidden: boolean;
  onFullscreen: () => void;
  onStop: () => void;
  send: (ev: InputEvent) => void;
}) {
  const [textOpen, setTextOpen] = useState(false);
  const pausedText =
    state.why === "elevated"
      ? `${state.targetName} está numa janela de administrador. Para você mexer nela, ${state.targetName} precisa clicar em "Liberar" no MyScreen (ao lado de "está controlando").`
      : state.why === "protected"
        ? `O MyScreen de ${state.targetName} está em primeiro plano, e as teclas não chegam nele. Clique em outra janela da tela de ${state.targetName}.`
        : state.paused
          ? `${state.targetName} pausou o controle.`
          : state.blocked
            ? `Esse ponto é uma janela do MyScreen de ${state.targetName}, mesmo que não apareça na transmissão. Ela não aceita seus cliques.`
            : null;

  const faded = hidden && !textOpen;

  return (
    <div
      // A faixa ocupa a largura do quadro: só a barra e o formulário pegam o
      // mouse, o resto deixa passar para a tela controlada.
      className={`pointer-events-none absolute inset-x-2 top-2 z-10 flex flex-col items-center gap-1.5 transition-opacity duration-300 ${faded ? "opacity-0" : ""}`}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className={`${faded ? "" : "pointer-events-auto"} flex max-w-full items-center gap-1 rounded-md bg-black/70 py-1 pr-1 pl-2.5 text-[0.75rem] text-white backdrop-blur-sm`}>
        <MousePointer2 size={13} strokeWidth={2} aria-hidden className="shrink-0 text-[#7dd3a8]" />
        <span
          className="truncate font-medium"
          title="Com a tela focada, todo o teclado vai para o PC remoto (inclusive Windows, Alt+Tab e Ctrl+C/V). Clique fora da tela para voltar ao seu."
        >
          Controlando a tela de {state.targetName}
        </span>
        <span aria-hidden className="mx-1 h-3 w-px bg-white/25" />
        <span className="shrink-0 font-mono text-white/75 [font-variant-numeric:tabular-nums]" title="Ida e volta da rede, medida">
          {state.rttMs === null ? "--" : `${state.rttMs} ms`}
        </span>
        <span aria-hidden className="mx-1 h-3 w-px bg-white/25" />
        <ToolbarButton label="Enviar texto" pressed={textOpen} onClick={() => setTextOpen((v) => !v)}>
          <Keyboard size={14} strokeWidth={1.75} aria-hidden />
        </ToolbarButton>
        <ToolbarButton label="Tela cheia" onClick={onFullscreen}>
          <Maximize2 size={14} strokeWidth={1.75} aria-hidden />
        </ToolbarButton>
        <button
          type="button"
          onClick={onStop}
          className="ml-0.5 flex h-7 items-center gap-1 rounded bg-white/15 px-2 font-semibold transition-colors hover:bg-[#d92d20]"
        >
          <X size={13} strokeWidth={2} aria-hidden />
          Soltar
        </button>
      </div>
      {pausedText ? (
        <p role="status" className="rounded-md bg-[#b54708]/90 px-2.5 py-1 text-[0.75rem] font-medium text-white">
          {pausedText}
        </p>
      ) : null}
      {textOpen ? <SendText send={send} onClose={() => setTextOpen(false)} /> : null}
    </div>
  );
}

function ToolbarButton({
  children,
  label,
  pressed,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={`flex size-7 items-center justify-center rounded transition-colors hover:bg-white/15 ${pressed ? "bg-white/20" : ""}`}
    >
      {children}
    </button>
  );
}

/** Corta em pedaços de até 1 KiB de UTF-8 sem partir um caractere no meio. */
export function chunkText(text: string, max = MAX_TEXT_BYTES): string[] {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of text) {
    const n = enc.encode(ch).byteLength;
    if (bytes + n > max && cur) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * "Enviar texto": digitado no PC remoto caractere a caractere. Serve quando
 * os teclados têm layouts diferentes, ou para colar um comando longo.
 */
function SendText({ send, onClose }: { send: (ev: InputEvent) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text) return;
    for (const chunk of chunkText(text.slice(0, 20_000))) send({ t: "text", text: chunk });
    setText("");
    onClose();
  };
  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        e.stopPropagation();
      }}
      className="pointer-events-auto flex w-[min(28rem,100%)] flex-col gap-2 rounded-md bg-black/80 p-2.5 text-white backdrop-blur-sm"
    >
      <label htmlFor="rc-send-text" className="text-[0.75rem] text-white/80">
        Texto para digitar no PC remoto (onde estiver o cursor de lá)
      </label>
      <textarea
        id="rc-send-text"
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(e);
        }}
        className="resize-none rounded border border-white/20 bg-black/40 px-2 py-1.5 font-mono text-[0.8125rem] text-white outline-none focus:border-white/50"
      />
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onClose} className="rounded px-2.5 py-1 text-[0.75rem] text-white/80 hover:text-white">
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!text}
          className="flex items-center gap-1.5 rounded bg-white px-2.5 py-1 text-[0.75rem] font-semibold text-black disabled:opacity-40"
        >
          <Send size={12} strokeWidth={2} aria-hidden />
          Digitar (Ctrl+Enter)
        </button>
      </div>
    </form>
  );
}
