import { useEffect, useRef, useState } from "react";
import type { RemoteConsentRequest } from "@shared/ipc";
import { CONSENT_TIMEOUT_MS } from "@shared/remote/protocol";
import { PANIC_SHORTCUT_LABEL } from "./labels";

/**
 * "Fulano quer controlar seu computador". Modal; "Recusar" tem o foco por
 * padrão (Enter recusa); sem resposta em 30 s vale como recusa. Mostra o nome
 * E o sufixo da identidade, que não muda: dois "Ana" na sala são distinguíveis.
 */
export function ConsentDialog({
  request,
  onDecide,
}: {
  request: RemoteConsentRequest;
  onDecide: (allow: boolean) => void;
}) {
  const refuseRef = useRef<HTMLButtonElement>(null);
  const [left, setLeft] = useState(Math.round(CONSENT_TIMEOUT_MS / 1000));

  useEffect(() => {
    refuseRef.current?.focus();
    const started = Date.now();
    const id = setInterval(() => {
      setLeft(Math.max(0, Math.round((CONSENT_TIMEOUT_MS - (Date.now() - started)) / 1000)));
    }, 500);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDecide(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearInterval(id);
      document.removeEventListener("keydown", onKey);
    };
  }, [request.reqId, onDecide]);

  const name = request.name.slice(0, 64);
  const suffix = request.identity.slice(-8);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-scrim p-6">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="rc-consent-title"
        aria-describedby="rc-consent-body"
        className="w-full max-w-[30rem] border border-rule-2 bg-sheet shadow-overlay [border-radius:var(--radius-sheet)]"
      >
        <div className="border-b border-rule px-6 py-4">
          <h2 id="rc-consent-title" className="text-[1.0625rem] font-semibold tracking-[-0.015em] text-ink">
            {name} quer controlar seu computador
          </h2>
          <p className="mt-0.5 font-mono text-[0.75rem] text-ink-3">
            {name} · {suffix}
          </p>
        </div>
        <div id="rc-consent-body" className="space-y-3 px-6 py-4 text-[0.875rem] leading-[1.55] text-ink-2">
          <p>
            {name} vai poder mover o mouse e digitar na tela <strong className="text-ink">“{request.sourceName}”</strong>.
            Você vê tudo o que acontece e pode parar a qualquer momento com{" "}
            <kbd className="font-mono text-[0.8125rem] text-ink">{PANIC_SHORTCUT_LABEL}</kbd> ou pelo botão vermelho no topo da
            tela.
          </p>
          <p className="text-[0.8125rem] text-ink-3">
            Janelas do MyScreen não recebem cliques nem teclas de {name}. Janelas de administrador, a tela de bloqueio e o
            Ctrl+Alt+Del ficam fora do alcance.
          </p>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-rule px-6 py-3.5">
          <span className="font-mono text-[0.75rem] text-ink-3 [font-variant-numeric:tabular-nums]" aria-live="off">
            Recusa sozinho em {left} s
          </span>
          <div className="flex gap-2">
            <button
              ref={refuseRef}
              type="button"
              onClick={() => onDecide(false)}
              className="border border-rule-2 bg-sheet px-4 py-2 text-[0.8125rem] font-semibold text-ink transition-colors hover:border-rule-3 hover:bg-band [border-radius:var(--radius-cell)]"
            >
              Recusar
            </button>
            <button
              type="button"
              onClick={() => onDecide(true)}
              className="border border-[#b42318] bg-[#b42318] px-4 py-2 text-[0.8125rem] font-semibold text-white transition-colors hover:bg-[#912018] [border-radius:var(--radius-cell)]"
            >
              Permitir controle
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
