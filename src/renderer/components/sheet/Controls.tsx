import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Choice } from "./Cell";

/* ---------------------------------------------------------------------------
   Ações

   Botão é um retângulo impresso com um fio, não uma cápsula com sombra. O
   radius do sistema é 3px; primário é o único lugar onde o azul de líder ocupa
   uma superfície inteira.
   ------------------------------------------------------------------------ */

type Tone = "primary" | "secondary" | "quiet" | "danger";

const TONE: Record<Tone, string> = {
  primary:
    "bg-signal text-on-signal border-signal hover:bg-signal-2 hover:border-signal-2 active:bg-signal-2",
  secondary:
    "bg-sheet text-ink border-rule-2 hover:bg-band hover:border-rule-3 active:bg-band-2",
  quiet: "bg-transparent text-ink-2 border-transparent hover:bg-band hover:text-ink",
  danger:
    "bg-sheet text-alert border-alert-line hover:bg-alert-wash hover:border-alert-line-2 active:bg-alert-wash-2",
};

const BASE =
  "inline-flex items-center justify-center gap-2 border px-4 py-2.5 text-[0.8125rem] font-semibold tracking-[-0.005em] transition-colors duration-150 [border-radius:var(--radius-sheet)] disabled:pointer-events-none disabled:opacity-40";

export function Button({
  children,
  className,
  tone = "secondary",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  tone?: "primary" | "secondary" | "quiet" | "danger";
} & Omit<React.ComponentProps<"button">, "className">) {
  return (
    <button className={cn(BASE, TONE[tone], className)} {...rest}>
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------------
   Campos

   O rótulo é cabeçalho de coluna, com fio abaixo, igual à célula de dado. Erro
   nomeia o problema e a recuperação — nunca "algo deu errado".
   ------------------------------------------------------------------------ */

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <label
        htmlFor={htmlFor}
        className="label-col block"
      >
        {label}
      </label>
      <div className="mt-2">{children}</div>
      {error ? (
        <p className="mt-2 text-[0.8125rem] leading-[1.5] text-alert" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-2 text-[0.8125rem] leading-[1.5] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "w-full border border-rule-2 bg-sheet px-3.5 py-2.5 text-[0.875rem] text-ink transition-colors placeholder:text-ink-3 hover:border-rule-3 focus:border-signal focus:shadow-[0_0_0_3px_var(--color-signal-wash)] focus:outline-none focus-visible:outline-none [border-radius:var(--radius-cell)]";

/* ---------------------------------------------------------------------------
   Linhas de escolha

   `Choice` sozinho é a célula marcada. `ChoiceRow` é a régua: as células em
   fila, separadas por fio, dentro de uma folha. É a forma que o seletor de
   resolução e FPS assume no produto inteiro.
   ------------------------------------------------------------------------ */

export function ChoiceRow({
  name,
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; hint?: string; disabled?: boolean }[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "grid border-y border-rule bg-sheet [border-radius:var(--radius-sheet)]",
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <Choice
          key={option.value}
          name={name}
          value={option.value}
          checked={option.value === value}
          onChange={onChange}
          label={option.label}
          hint={option.hint}
          disabled={option.disabled}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Caixa marcada

   Booleano numa folha é quadrado marcado à mão, não um switch. A caixa é a
   parte impressa; o estado mora no quadrado e no texto, nunca só na cor.
   ------------------------------------------------------------------------ */

export function CheckCell({
  name,
  checked,
  onChange,
  label,
  note,
  disabled = false,
  className,
}: {
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  note?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer gap-3 border-b border-rule px-5 py-3.5 transition-colors last:border-b-0 hover:bg-band has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[-3px] has-[:focus-visible]:outline-signal",
        disabled && "pointer-events-none opacity-45",
        className,
      )}
    >
      <input
        type="checkbox"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "mt-[3px] flex size-[15px] shrink-0 items-center justify-center border transition-colors [border-radius:2px]",
          checked ? "border-signal bg-signal" : "border-rule-2 bg-sheet",
        )}
      >
        {checked ? (
          <svg viewBox="0 0 12 12" className="size-[11px]" fill="none" aria-hidden>
            <path
              d="M2.5 6.2 4.7 8.4 9.5 3.6"
              stroke="var(--color-on-signal)"
              strokeWidth="1.6"
              strokeLinecap="square"
            />
          </svg>
        ) : null}
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            "block text-[0.875rem] font-medium leading-[1.4]",
            checked ? "text-ink" : "text-ink-2",
          )}
        >
          {label}
        </span>
        {note ? (
          <span className="mt-0.5 block max-w-[58ch] text-[0.8125rem] leading-[1.5] text-ink-3">
            {note}
          </span>
        ) : null}
      </span>
    </label>
  );
}
