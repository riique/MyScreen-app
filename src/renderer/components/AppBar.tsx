import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A cabeça da janela: marca à esquerda, ações à direita, e a faixa inteira é
 * a área de arrastar. Os botões nativos do Windows ficam sobrepostos à direita
 * (`titlebar-pad` reserva o espaço deles).
 */
export function AppBar({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        "app-drag titlebar-pad flex h-12 shrink-0 items-center justify-between gap-4 border-b border-rule bg-sheet pl-4",
        className,
      )}
    >
      <span className="text-[1rem] font-semibold tracking-[-0.02em] text-ink">
        My<span className="text-signal">Screen</span>
      </span>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </header>
  );
}
