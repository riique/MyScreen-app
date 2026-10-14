
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useAmendment } from "./useAmendment";

/**
 * A celula e a unidade de dado da folha. Cabecalho de coluna em mono e grafite,
 * fio abaixo do cabecalho, valor em mono e tinta, e — enquanto a emenda esta no
 * ar — o valor anterior em grafite, riscado, logo acima do novo.
 *
 * O valor e `string` de proposito: a emenda compara valor, entao a celula
 * carrega dado, nao `ReactNode` arbitrario. Para conteudo rico use `children`.
 */
export function Cell({
  label,
  value,
  note,
  className,
  emphasis = false,
  children,
}: {
  label: string;
  value: string;
  note?: string;
  className?: string;
  emphasis?: boolean;
  children?: ReactNode;
}) {
  const { previous, amended } = useAmendment(value);

  return (
    <div className={cn("min-w-0 px-5 py-5 sm:px-6", className)}>
      <span className="label-col">{label}</span>

      <div className="mt-2 min-h-[1.75rem]">
        {previous !== null && previous !== value ? (
          <span
            className="mr-2 font-mono text-[0.8125rem] leading-none text-ink-3 line-through decoration-ink-4"
            aria-hidden
          >
            {previous}
          </span>
        ) : null}
        <span
          className={cn(
            "font-mono leading-none [font-variant-numeric:tabular-nums]",
            emphasis ? "text-[1.0625rem] font-medium text-signal" : "text-[1.0625rem] text-ink",
            amended && "amended",
          )}
        >
          {value}
        </span>
      </div>

      {children}
      {note ? (
        <p className="mt-2 max-w-[42ch] text-[0.8125rem] leading-[1.5] text-ink-3 [text-wrap:pretty]">
          {note}
        </p>
      ) : null}

      {/* A troca de valor e uma informacao que so existe na imagem: para quem
          nao ve a emenda grafica, ela precisa existir em voz. */}
      <span className="sr-only" aria-live="polite">
        {amended && previous !== null && previous !== value
          ? `${label}: ${previous} alterado para ${value}`
          : ""}
      </span>
    </div>
  );
}

/**
 * Uma opcao de celula. Estado e valor de coluna, nao cor: a selecionada ganha
 * o fundo lavado e o fio do sinal, e continua sendo texto legivel. Radio
 * nativo, entao teclado e leitor de tela vem de graca.
 */
export function Choice({
  name,
  value,
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "group relative flex cursor-pointer flex-col justify-between gap-1 border-r border-rule px-4 py-3 transition-colors last:border-r-0",
        "hover:bg-band focus-within:bg-band has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[-3px] has-[:focus-visible]:outline-signal",
        checked ? "bg-signal-wash" : "bg-sheet",
        disabled && "pointer-events-none opacity-45",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="sr-only"
      />
      <span
        className={cn(
          "font-mono text-[0.8125rem] font-medium leading-none [font-variant-numeric:tabular-nums]",
          checked ? "text-signal" : "text-ink-2 group-hover:text-ink",
        )}
      >
        {label}
      </span>
      {hint ? (
        <span className="text-[0.75rem] leading-[1.35] text-ink-3">{hint}</span>
      ) : null}
    </label>
  );
}
