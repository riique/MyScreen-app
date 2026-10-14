
import type { ReceivedChatMessage } from "@livekit/components-react";
import { MessageSquare, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const SEND_ERROR_MESSAGE =
  "Não foi possível enviar a mensagem. Verifique sua conexão e tente novamente.";

interface ChatSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  chatMessages: ReceivedChatMessage[];
  send: (message: string) => Promise<unknown>;
  isSending: boolean;
  /** O rascunho vive fora do painel: fechar o chat não apaga o que foi digitado. */
  draft: string;
  onDraftChange: React.Dispatch<React.SetStateAction<string>>;
}

/**
 * O chat é um livro de ocorrências, não uma pilha de balões.
 *
 * Balões redondos com cauda são a forma de conversa de fantasia, e esconderiam o
 * que importa num registro técnico: quem mandou, quando, e em ordem. Aqui cada
 * mensagem é uma linha pautada com autor e hora em mono à esquerda — dá para
 * varrer a coluna e achar a linha que importa.
 *
 * O histórico (`useChat`) e o rascunho moram no palco, que fica montado a
 * sala inteira. Se morassem aqui, fechar o painel desmontaria o hook e levaria
 * junto as mensagens já recebidas e as que chegassem com ele fechado.
 */
export function ChatSidebar({
  isOpen,
  onClose,
  chatMessages,
  send,
  isSending,
  draft,
  onDraftChange: setDraft,
}: ChatSidebarProps) {
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, isOpen]);

  if (!isOpen) return null;

  async function handleSend(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || isSending) return;

    setSendError(null);
    try {
      await send(text);
      // Só limpamos depois da confirmação: enquanto o envio está em voo o texto
      // fica visível, e o eco local do SDK só chega quando `send` conclui.
      setDraft("");
    } catch (error) {
      console.error("Falha ao enviar mensagem:", error);
      setSendError(SEND_ERROR_MESSAGE);
      // Devolve o texto sem apagar o que a pessoa tiver digitado na espera.
      setDraft((current) => (current.trim() ? current : text));
      inputRef.current?.focus();
    }
  }

  function handleDraftChange(value: string) {
    setDraft(value);
    if (sendError) setSendError(null);
  }

  return (
    <aside className="flex h-full w-full min-h-0 flex-col bg-sheet">
      <div className="flex items-center justify-between gap-3 border-b border-rule bg-band px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare size={14} strokeWidth={1.5} aria-hidden className="shrink-0 text-ink-3" />
          <h2 className="truncate text-[0.875rem] font-semibold text-ink">Bate-papo da reunião</h2>
          <span className="shrink-0 font-mono text-[0.75rem] text-ink-3">
            {chatMessages.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar bate-papo"
          className="shrink-0 border border-transparent px-1.5 py-1 text-ink-3 transition-colors hover:border-rule hover:bg-sheet hover:text-ink [border-radius:var(--radius-cell)]"
        >
          <X size={15} strokeWidth={1.5} aria-hidden />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {chatMessages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <p className="text-[0.875rem] font-medium text-ink-2">Nenhuma mensagem ainda</p>
            <p className="text-[0.8125rem] text-ink-3">
              Envie a primeira mensagem para a sala!
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-rule">
            {chatMessages.map((msg) => {
              // `isLocal` é a autoridade do SDK. Comparar `name`/`identity`
              // rotularia como suas as mensagens de outra pessoa sempre que os
              // apelidos coincidissem.
              const isMe = msg.from?.isLocal === true;
              return (
                <li key={msg.id || msg.timestamp} className="px-4 py-3">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[0.8125rem] font-medium text-ink">
                      {isMe ? "Você" : msg.from?.name || "Participante"}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[0.6875rem] text-ink-3">
                      {new Date(msg.timestamp).toLocaleTimeString("pt-BR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p
                    className={`mt-1 break-words text-[0.875rem] leading-[1.5] [text-wrap:pretty] ${
                      isMe ? "text-ink" : "text-ink-2"
                    }`}
                  >
                    {msg.message}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSend} className="border-t border-rule bg-band p-3">
        {sendError ? (
          <p
            role="alert"
            className="mb-2 border border-alert-line bg-alert-wash px-3 py-2 text-[0.8125rem] leading-[1.45] text-alert"
          >
            {sendError}
          </p>
        ) : null}
        <div className="flex items-stretch gap-2">
          <label htmlFor="chat-message-input" className="sr-only">
            Mensagem
          </label>
          <input
            id="chat-message-input"
            ref={inputRef}
            name="message"
            type="text"
            autoComplete="off"
            placeholder="Digite uma mensagem..."
            value={draft}
            onChange={(event) => handleDraftChange(event.target.value)}
            className="min-w-0 flex-1 border border-rule-2 bg-sheet px-3 py-2 text-[0.875rem] text-ink transition-colors hover:border-rule-3 focus:border-signal focus:outline-none [border-radius:var(--radius-cell)]"
          />
          <button
            type="submit"
            aria-label="Enviar mensagem"
            disabled={!draft.trim() || isSending}
            className="flex w-10 shrink-0 items-center justify-center border border-signal bg-signal text-on-signal transition-colors hover:bg-signal-2 disabled:pointer-events-none disabled:opacity-40 [border-radius:var(--radius-cell)]"
          >
            <Send size={15} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      </form>
    </aside>
  );
}
