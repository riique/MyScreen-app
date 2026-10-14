
import { useEffect, useRef, useState } from "react";

export type Amendment<T> = {
  /** Valor anterior, enquanto a emenda ainda esta visivel na folha. */
  previous: T | null;
  /** Verdadeiro no instante da troca, para o assentamento da tinta. */
  amended: boolean;
};

/**
 * A folha de corte registra a emenda: quando o valor de uma celula muda, o valor
 * antigo NAO some. Ele fica em grafite e riscado, como o editor marca a linha
 * que acabou de cortar, e some depois de `holdMs`.
 *
 * A emenda e a interacao-assinatura do MyScreen e repete em toda superficie:
 * uma mudanca de valor nao e um pop, e um registro. Por isso o valor anterior e
 * parte do layout, e nao um toast.
 *
 * `holdMs` em 0 segura a emenda ate a proxima troca.
 */
export function useAmendment<T>(value: T, holdMs = 4500): Amendment<T> {
  const [previous, setPrevious] = useState<T | null>(null);
  const [amended, setAmended] = useState(false);
  const current = useRef<T>(value);
  const primed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!primed.current) {
      // A primeira montagem da celula nao e uma emenda: e a folha em branco.
      primed.current = true;
      current.current = value;
      return;
    }
    if (Object.is(current.current, value)) return;

    const before = current.current;
    current.current = value;
    setPrevious(before);
    setAmended(true);

    if (holdMs > 0) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setPrevious(null);
        setAmended(false);
      }, holdMs);
    }
  }, [value, holdMs]);

  // Desmontar com a emenda no ar deixaria um timer escrevendo em estado morto.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  return { previous, amended };
}
