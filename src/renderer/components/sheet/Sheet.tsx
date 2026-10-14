import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A folha: o suporte branco que levanta da mesa. E o unico container do
 * sistema. Bloco dentro de bloco e sempre errado — quem esta dentro de uma
 * folha usa `Band`, que e uma secao pautada, nao outra folha.
 */
export function Sheet({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "aside" | "form" | "li";
}) {
  return (
    <Tag
      className={cn(
        "border border-rule bg-sheet shadow-lift [border-radius:var(--radius-sheet)]",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/**
 * Uma banda: bloco pautado dentro da folha, com respiro de verdade em volta.
 * A lacuna entre bandas e o que impede a pagina de virar um fundo continuo sem
 * respiracao.
 */
export function Band({
  children,
  className,
  tone = "sheet",
  id,
}: {
  children: ReactNode;
  className?: string;
  tone?: "sheet" | "band" | "band-2";
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        "border-rule px-6 py-7 sm:px-8 sm:py-8",
        tone === "sheet" && "bg-sheet",
        tone === "band" && "bg-band",
        tone === "band-2" && "bg-band-2",
        className,
      )}
    >
      {children}
    </section>
  );
}

/** Fio de cabelo. `axis` decide a direcao; `weight` sobe para fio de bloco. */
export function Rule({
  axis = "x",
  weight = "hair",
  className,
}: {
  axis?: "x" | "y";
  weight?: "hair" | "block" | "heavy";
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "shrink-0",
        axis === "x" ? "h-px w-full" : "h-full w-px",
        weight === "hair" && "bg-rule",
        weight === "block" && "bg-rule-2",
        weight === "heavy" && "bg-rule-3",
        className,
      )}
    />
  );
}

/**
 * Cabecalho de coluna ou titulo de bloco. O rotulo e estrutura de dados, nunca
 * um kicker flutuando acima de um titulo: o titulo fala por si.
 */
export function SheetHead({
  title,
  id,
  meta,
  action,
  className,
}: {
  title: string;
  id?: string;
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule pb-3",
        className,
      )}
    >
      <div className="flex min-w-0 items-baseline gap-3">
        {id ? (
          <span className="font-mono text-[11px] text-ink-3">{id}</span>
        ) : null}
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        {meta ? <span className="text-[13px] text-ink-3">{meta}</span> : null}
      </div>
      {action}
    </div>
  );
}

/**
 * Titulo de pagina. Sem kicker: o peso e o tamanho carregam a hierarquia.
 *
 * A entrelinha vai como propriedade arbitraria de proposito: o tailwind-merge
 * descarta `leading-*` quando quem chama passa outro `text-[...]`, e o titulo
 * de duas linhas abria para 1.5.
 */
export function SheetTitle({
  children,
  className,
  as: Tag = "h1",
}: {
  children: ReactNode;
  className?: string;
  as?: "h1" | "h2" | "h3";
}) {
  return (
    <Tag
      className={cn(
        "font-semibold text-ink [text-wrap:balance]",
        "text-[1.875rem] tracking-[-0.028em] [line-height:1.1] sm:text-[2.375rem]",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** Corpo em medida de leitura. 70ch e o teto do olho, nao do container. */
export function SheetProse({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "max-w-[70ch] text-[0.9375rem] leading-[1.65] text-ink-2 [text-wrap:pretty]",
        className,
      )}
    >
      {children}
    </div>
  );
}
