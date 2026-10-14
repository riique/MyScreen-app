import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Estado como valor de coluna, nunca como cor solta. Um carimbo nomeia o
 * estado em mono e maiuscula, com o fio que o separa da celula vizinha. Os
 * tres estados do sistema sao PENDENTE, ATIVO e TRAVADO — e cada um tambem
 * carrega forma e texto, entao o estado nunca depende so de cor.
 *
 * O texto do carimbo usa ink-3 (grafite, 4.9:1) e nunca ink-4: ink-4 mede
 * 2.7:1 e o token file proibe copy nele. Um estado que so se distingue por um
 * cinza quase invisivel nao distingue nada.
 */
export type StampState = "pendente" | "ativo" | "travado";

const STATE: Record<StampState, { label: string; className: string }> = {
  pendente: { label: "PENDENTE", className: "border-rule-2 text-ink-3" },
  ativo: { label: "ATIVO", className: "border-signal bg-signal-wash text-signal" },
  travado: { label: "TRAVADO", className: "border-rule-2 text-ink-3" },
};

export function Stamp({
  state,
  children,
  className,
}: {
  state: StampState;
  /** Sobrescreve o rotulo padrao quando o estado tem um nome proprio. */
  children?: ReactNode;
  className?: string;
}) {
  const { label, className: tone } = STATE[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[2px] font-mono text-[10px] font-medium uppercase tracking-[0.08em]",
        tone,
        className,
      )}
    >
      {state === "ativo" ? (
        <span aria-hidden className="size-[5px] rounded-full bg-signal" />
      ) : null}
      {children ?? label}
    </span>
  );
}
