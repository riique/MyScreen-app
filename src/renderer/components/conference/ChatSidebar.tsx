import { Download, FileText, ImagePlus, LoaderCircle, MessageSquare, Paperclip, Send, Smile, Trash2, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatBytes,
  isEmojiOnly,
  parseChatText,
  type ChatBlock,
  type ChatInline,
} from "@shared/chatText";
import { cn } from "@/lib/utils";
import type { ChatAttachment, ChatEntry, ChatSend } from "./useRoomChat";

const SEND_ERROR_MESSAGE =
  "Não foi possível enviar a mensagem. Verifique sua conexão e tente novamente.";

/** Arquivos vão pelo canal de dados da sala: grandes demais travariam o chat de todos. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
/** Mensagens seguidas da mesma pessoa, dentro deste tempo, dividem um cabeçalho só. */
const GROUP_MS = 5 * 60 * 1000;
/**
 * Atributo da legenda automática ("📎 foto.png") que acompanha arquivo mandado
 * sem texto. O app esconde a legenda e mostra o arquivo; o site, que ainda não
 * desenha anexos, mostra a legenda — ninguém fica sem saber que veio algo.
 */
export const AUTO_CAPTION_ATTR = "myscreen.autocaption";

const EMOJIS = [
  "😀", "😂", "🤣", "😊", "😍", "😎", "🤔", "😅", "😭", "😡", "😴", "🙄",
  "👍", "👎", "👏", "🙏", "💪", "👀", "🤝", "✌️", "👋", "🫡", "🤦", "🤷",
  "❤️", "🔥", "🎉", "✅", "❌", "⚠️", "💯", "⭐", "🚀", "💡", "☕", "🍕",
];

interface ChatSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  chatMessages: ChatEntry[];
  send: ChatSend;
  /** Apaga para todos uma mensagem sua (da sala e do histórico). */
  onDelete: (id: string) => Promise<void>;
  loadFile: (attachment: ChatAttachment) => Promise<Blob>;
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
 * varrer a coluna e achar a linha que importa. Mensagens seguidas da mesma
 * pessoa dividem um cabeçalho.
 *
 * Texto com formatação leve (negrito, itálico, código, links clicáveis),
 * imagens e arquivos: colar (Ctrl+V), arrastar para o painel ou o clipe.
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
  onDelete,
  loadFile,
}: ChatSidebarProps) {
  const [sendError, setSendError] = useState<string | null>(null);
  const [pending, setPending] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [viewer, setViewer] = useState<{ url: string; name: string } | null>(null);
  // Apagar pede um segundo clique: a lixeira vira "Apagar?" por alguns segundos.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(null), 4000);
    return () => clearTimeout(t);
  }, [confirmDelete]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (isOpen) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, isOpen]);

  // A caixa cresce com o texto até umas seis linhas.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft, isOpen]);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const tooBig = files.filter((f) => f.size > MAX_FILE_BYTES);
    const ok = files.filter((f) => f.size <= MAX_FILE_BYTES && f.size > 0);
    setPending((cur) => {
      const next = [...cur, ...ok].slice(0, MAX_FILES);
      if (cur.length + ok.length > MAX_FILES) setSendError(`No máximo ${MAX_FILES} arquivos por mensagem.`);
      return next;
    });
    if (tooBig.length > 0) {
      setSendError(
        `${tooBig.map((f) => f.name).join(", ")}: grande demais. O limite é ${formatBytes(MAX_FILE_BYTES)} por arquivo.`,
      );
    }
    inputRef.current?.focus();
  }, []);

  if (!isOpen) return null;

  async function handleDelete(id: string) {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    setConfirmDelete(null);
    setDeleting(id);
    setSendError(null);
    try {
      await onDelete(id);
    } catch (error) {
      setSendError(error instanceof Error && error.message ? error.message : "Não foi possível apagar a mensagem.");
    } finally {
      setDeleting(null);
    }
  }

  async function handleSend(event?: React.SyntheticEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if ((!text && pending.length === 0) || isSending) return;

    setSendError(null);
    const files = pending;
    try {
      if (files.length > 0) {
        const caption = text || `📎 ${files.map((f) => f.name || "arquivo").join(", ")}`;
        await send(caption, {
          attachments: files,
          ...(text ? {} : { attributes: { [AUTO_CAPTION_ATTR]: "1" } }),
        });
      } else {
        await send(text);
      }
      // Só limpamos depois da confirmação: enquanto o envio está em voo o texto
      // fica visível, e o eco local do SDK só chega quando `send` conclui.
      setDraft("");
      setPending((cur) => cur.filter((f) => !files.includes(f)));
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

  function insertAtCursor(text: string) {
    const el = inputRef.current;
    if (!el) {
      setDraft((d) => d + text);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  }

  return (
    <aside
      className="relative flex h-full w-full min-h-0 flex-col bg-sheet"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
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
              Envie a primeira mensagem para a sala! Dá para colar imagens e arrastar arquivos.
            </p>
          </div>
        ) : (
          <ul aria-label="Mensagens">
            {chatMessages.map((msg, index) => {
              // `isLocal` vem do SDK (ao vivo) ou da identidade (histórico).
              // Comparar apelidos rotularia como suas as mensagens de outra
              // pessoa sempre que os nomes coincidissem.
              const isMe = msg.isLocal;
              const prev = chatMessages[index - 1];
              const grouped =
                prev !== undefined &&
                prev.fromIdentity === msg.fromIdentity &&
                msg.timestamp - prev.timestamp < GROUP_MS;
              const files = msg.files;
              const autoCaption = msg.attributes[AUTO_CAPTION_ATTR] === "1" && files.length > 0;
              const asking = confirmDelete === msg.id;
              return (
                <li
                  key={msg.id || msg.timestamp}
                  className={cn(
                    "group/msg relative px-4",
                    grouped ? "pt-0.5 pb-1.5" : "border-t border-rule pt-3 pb-1.5 first:border-t-0",
                    isMe && "border-l-2 border-l-signal-line",
                  )}
                >
                  {grouped ? null : (
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[0.8125rem] font-medium text-ink">
                        {isMe ? "Você" : msg.fromName || "Participante"}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[0.6875rem] text-ink-3">
                        {formatTime(msg.timestamp)}
                      </span>
                    </div>
                  )}
                  {autoCaption || !msg.message ? null : (
                    <MessageText text={msg.message} muted={!isMe} timestamp={grouped ? msg.timestamp : null} />
                  )}
                  {files.length > 0 ? (
                    <Attachments files={files} loadFile={loadFile} onOpenImage={(url, name) => setViewer({ url, name })} />
                  ) : null}
                  {isMe && msg.id ? (
                    <button
                      type="button"
                      onClick={() => void handleDelete(msg.id)}
                      disabled={deleting === msg.id}
                      aria-label={asking ? "Confirmar: apagar mensagem para todos" : "Apagar mensagem"}
                      title={asking ? "Clique de novo para apagar para todos" : "Apagar mensagem"}
                      className={cn(
                        "absolute right-2 inline-flex items-center gap-1 border px-1.5 py-0.5 text-[0.6875rem] font-semibold transition-[opacity,color,background-color] [border-radius:var(--radius-cell)]",
                        grouped ? "top-0" : "top-2.5",
                        asking || deleting === msg.id
                          ? "border-alert-line bg-alert-wash text-alert opacity-100"
                          : "border-rule bg-sheet text-ink-3 opacity-0 hover:text-alert focus-visible:opacity-100 group-hover/msg:opacity-100",
                      )}
                    >
                      {deleting === msg.id ? (
                        <LoaderCircle size={12} strokeWidth={2} aria-hidden className="animate-spin" />
                      ) : (
                        <Trash2 size={12} strokeWidth={1.75} aria-hidden />
                      )}
                      {asking ? "Apagar?" : null}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSend} className="relative border-t border-rule bg-band p-3">
        {sendError ? (
          <p
            role="alert"
            className="mb-2 border border-alert-line bg-alert-wash px-3 py-2 text-[0.8125rem] leading-[1.45] text-alert"
          >
            {sendError}
          </p>
        ) : null}

        {pending.length > 0 ? (
          <ul aria-label="Arquivos para enviar" className="mb-2 flex flex-wrap gap-2">
            {pending.map((file, i) => (
              <PendingFile
                key={`${file.name}-${file.size}-${i}`}
                file={file}
                onRemove={() => setPending((cur) => cur.filter((f) => f !== file))}
              />
            ))}
          </ul>
        ) : null}

        {emojiOpen ? (
          <EmojiPicker
            onPick={(emoji) => {
              insertAtCursor(emoji);
              setEmojiOpen(false);
            }}
            onClose={() => setEmojiOpen(false)}
          />
        ) : null}

        <div className="flex items-end gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <ComposerButton label="Anexar imagem ou arquivo" onClick={() => fileInputRef.current?.click()}>
            <Paperclip size={16} strokeWidth={1.5} aria-hidden />
          </ComposerButton>
          <ComposerButton label="Emoji" pressed={emojiOpen} onClick={() => setEmojiOpen((o) => !o)}>
            <Smile size={16} strokeWidth={1.5} aria-hidden />
          </ComposerButton>
          <label htmlFor="chat-message-input" className="sr-only">
            Mensagem
          </label>
          <textarea
            id="chat-message-input"
            ref={inputRef}
            name="message"
            rows={1}
            autoComplete="off"
            placeholder="Mensagem (Shift+Enter quebra a linha)"
            value={draft}
            onChange={(event) => handleDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void handleSend();
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length === 0) return;
              event.preventDefault();
              // Imagem colada vem sem nome útil ("image.png"): dá um com a hora.
              addFiles(files.map((f) => (f.name && f.name !== "image.png" ? f : renamePasted(f))));
            }}
            className="max-h-40 min-h-10 min-w-0 flex-1 resize-none border border-rule-2 bg-sheet px-3 py-2 text-[0.875rem] leading-[1.45] text-ink transition-colors hover:border-rule-3 focus:border-signal focus:outline-none [border-radius:var(--radius-cell)]"
          />
          <button
            type="submit"
            aria-label="Enviar mensagem"
            disabled={(!draft.trim() && pending.length === 0) || isSending}
            className="flex h-10 w-10 shrink-0 items-center justify-center border border-signal bg-signal text-on-signal transition-colors hover:bg-signal-2 disabled:pointer-events-none disabled:opacity-40 [border-radius:var(--radius-cell)]"
          >
            <Send size={15} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      </form>

      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-signal bg-signal-wash/90 text-signal [border-radius:var(--radius-sheet)]">
          <ImagePlus size={28} strokeWidth={1.5} aria-hidden />
          <p className="text-[0.875rem] font-semibold">Solte para anexar</p>
        </div>
      ) : null}

      {viewer ? <ImageViewer url={viewer.url} name={viewer.name} onClose={() => setViewer(null)} /> : null}
    </aside>
  );
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function renamePasted(file: File): File {
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return new File([file], `imagem ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`, {
    type: file.type,
  });
}

function ComposerButton({
  children,
  label,
  onClick,
  pressed,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn(
        "flex h-10 w-8 shrink-0 items-center justify-center text-ink-3 transition-colors hover:text-ink [border-radius:var(--radius-cell)]",
        pressed && "text-signal",
      )}
    >
      {children}
    </button>
  );
}

/* --- Texto ----------------------------------------------------------------- */

function MessageText({ text, muted, timestamp }: { text: string; muted: boolean; timestamp: number | null }) {
  const blocks = useMemo(() => parseChatText(text), [text]);
  const big = isEmojiOnly(text);
  return (
    <div
      className={cn(
        "relative mt-1 break-words text-[0.875rem] leading-[1.5] [text-wrap:pretty]",
        muted ? "text-ink-2" : "text-ink",
        big && "text-[1.75rem] leading-[1.25]",
      )}
      title={timestamp !== null ? formatTime(timestamp) : undefined}
    >
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: ChatBlock }) {
  if (block.kind === "codeblock") {
    return (
      <pre className="my-1 overflow-x-auto border border-rule bg-band px-2.5 py-2 font-mono text-[0.75rem] leading-[1.5] text-ink [border-radius:var(--radius-cell)]">
        <code>{block.text}</code>
      </pre>
    );
  }
  return (
    <p className="[&:not(:first-child)]:mt-1">
      <Inlines items={block.children} />
    </p>
  );
}

function Inlines({ items }: { items: ChatInline[] }) {
  return (
    <>
      {items.map((item, i) => (
        <Fragment key={i}>{renderInline(item)}</Fragment>
      ))}
    </>
  );
}

function renderInline(item: ChatInline): React.ReactNode {
  switch (item.kind) {
    case "text":
      return item.text;
    case "break":
      return <br />;
    case "code":
      return (
        <code className="border border-rule bg-band px-1 py-px font-mono text-[0.8em] text-ink [border-radius:4px]">
          {item.text}
        </code>
      );
    case "bold":
      return (
        <strong className="font-semibold text-ink">
          <Inlines items={item.children} />
        </strong>
      );
    case "italic":
      return (
        <em>
          <Inlines items={item.children} />
        </em>
      );
    case "strike":
      return (
        <s>
          <Inlines items={item.children} />
        </s>
      );
    case "link":
      return (
        <a
          href={item.href}
          onClick={(event) => {
            event.preventDefault();
            window.myscreen.app.openLink(item.href);
          }}
          title={item.href}
          className="font-medium text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal"
        >
          {item.text}
        </a>
      );
  }
}

/* --- Anexos ---------------------------------------------------------------- */

function useObjectUrl(file: Blob): string {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return url;
}

function kindOf(file: { type: string }): "image" | "video" | "audio" | "file" {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "file";
}

type LoadFile = (attachment: ChatAttachment) => Promise<Blob>;

function Attachments({
  files,
  loadFile,
  onOpenImage,
}: {
  files: ChatAttachment[];
  loadFile: LoadFile;
  onOpenImage: (url: string, name: string) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {files.map((file, i) =>
        file.file ? (
          <Attachment key={`${file.name}-${i}`} file={file.file} onOpenImage={onOpenImage} />
        ) : (
          <StoredAttachment key={file.remoteId ?? i} attachment={file} loadFile={loadFile} onOpenImage={onOpenImage} />
        ),
      )}
    </div>
  );
}

/**
 * Anexo do histórico: os bytes estão no servidor. Imagem baixa sozinha para
 * aparecer; o resto só quando a pessoa pede, para entrar na sala não baixar
 * todos os arquivos da conversa.
 */
function StoredAttachment({
  attachment,
  loadFile,
  onOpenImage,
}: {
  attachment: ChatAttachment;
  loadFile: LoadFile;
  onOpenImage: (url: string, name: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const name = attachment.name || "arquivo";
  const kind = kindOf(attachment);

  const load = useCallback(
    async (thenSave: boolean) => {
      setState("loading");
      try {
        const blob = await loadFile(attachment);
        const f = new File([blob], name, { type: attachment.type });
        setFile(f);
        setState("idle");
        if (thenSave) saveBlob(f, name);
      } catch {
        setState("error");
      }
    },
    [attachment, loadFile, name],
  );

  useEffect(() => {
    if (kind === "image") void load(false);
  }, [kind, load]);

  // Imagem, vídeo e áudio carregados viram o anexo de sempre (com player).
  if (file && kind !== "file") return <Attachment file={file} onOpenImage={onOpenImage} />;
  return (
    <button
      type="button"
      onClick={() => (file ? saveBlob(file, name) : void load(kind === "file"))}
      disabled={state === "loading"}
      title={state === "error" ? "Esse arquivo não está mais disponível" : kind === "file" ? `Salvar ${name}` : `Abrir ${name}`}
      className="flex min-w-0 items-center gap-2.5 border border-rule bg-sheet px-3 py-2 text-left text-ink transition-colors hover:border-rule-3 hover:bg-band [border-radius:var(--radius-cell)]"
    >
      <FileText size={18} strokeWidth={1.5} aria-hidden className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-medium">{name}</span>
        <span className="block font-mono text-[0.6875rem] text-ink-3">
          {state === "error" ? "indisponível" : formatBytes(attachment.size)}
        </span>
      </span>
      {state === "loading" ? (
        <LoaderCircle size={15} strokeWidth={1.75} aria-hidden className="shrink-0 animate-spin text-ink-3" />
      ) : (
        <Download size={15} strokeWidth={1.5} aria-hidden className="shrink-0 text-ink-3" />
      )}
    </button>
  );
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Attachment({ file, onOpenImage }: { file: File; onOpenImage: (url: string, name: string) => void }) {
  const url = useObjectUrl(file);
  const kind = kindOf(file);
  const name = file.name || "arquivo";
  if (kind === "image") {
    return (
      <button
        type="button"
        onClick={() => onOpenImage(url, name)}
        title={`${name} — clique para ampliar`}
        className="block max-w-full self-start overflow-hidden border border-rule bg-band [border-radius:var(--radius-cell)]"
      >
        <img src={url} alt={name} className="block max-h-60 max-w-full object-contain" draggable={false} />
      </button>
    );
  }
  if (kind === "video") {
    return (
      <div className="flex flex-col gap-1">
        <video src={url} controls className="max-h-60 max-w-full bg-black [border-radius:var(--radius-cell)]" />
        <FileCard url={url} name={name} size={file.size} compact />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="flex flex-col gap-1">
        <audio src={url} controls className="w-full" />
        <FileCard url={url} name={name} size={file.size} compact />
      </div>
    );
  }
  return <FileCard url={url} name={name} size={file.size} />;
}

function FileCard({ url, name, size, compact = false }: { url: string; name: string; size: number; compact?: boolean }) {
  return (
    <a
      href={url}
      download={name}
      title={`Salvar ${name}`}
      className={cn(
        "flex min-w-0 items-center gap-2.5 border border-rule bg-sheet text-ink transition-colors hover:border-rule-3 hover:bg-band [border-radius:var(--radius-cell)]",
        compact ? "px-2 py-1" : "px-3 py-2",
      )}
    >
      {compact ? null : <FileText size={18} strokeWidth={1.5} aria-hidden className="shrink-0 text-ink-3" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-medium">{name}</span>
        <span className="block font-mono text-[0.6875rem] text-ink-3">{formatBytes(size)}</span>
      </span>
      <Download size={15} strokeWidth={1.5} aria-hidden className="shrink-0 text-ink-3" />
    </a>
  );
}

function PendingFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith("image/");
  const url = useObjectUrl(file);
  return (
    <li className="relative flex max-w-full items-center gap-2 border border-rule-2 bg-sheet py-1 pr-7 pl-1 [border-radius:var(--radius-cell)]">
      {isImage ? (
        <img src={url} alt="" className="size-10 shrink-0 object-cover [border-radius:4px]" draggable={false} />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center bg-band [border-radius:4px]">
          <FileText size={18} strokeWidth={1.5} aria-hidden className="text-ink-3" />
        </span>
      )}
      <span className="min-w-0">
        <span className="block max-w-[9rem] truncate text-[0.75rem] font-medium text-ink">{file.name}</span>
        <span className="block font-mono text-[0.6875rem] text-ink-3">{formatBytes(file.size)}</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Tirar ${file.name}`}
        className="absolute top-1 right-1 p-0.5 text-ink-3 transition-colors hover:text-ink"
      >
        <X size={13} strokeWidth={1.75} aria-hidden />
      </button>
    </li>
  );
}

/** Imagem grande sobre a sala; Esc ou clique fora fecha. */
function ImageViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[110] flex flex-col items-center justify-center gap-3 bg-black/85 p-6 outline-none"
    >
      <img src={url} alt={name} className="max-h-[calc(100vh-7rem)] max-w-full object-contain" />
      <div className="flex items-center gap-2">
        <span className="max-w-[40ch] truncate text-[0.8125rem] text-white/80">{name}</span>
        <a
          href={url}
          download={name}
          className="inline-flex items-center gap-1.5 rounded-md bg-white/15 px-3 py-1.5 text-[0.8125rem] font-medium text-white transition-colors hover:bg-white/25"
        >
          <Download size={14} strokeWidth={1.75} aria-hidden />
          Salvar
        </a>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-md bg-white/15 px-3 py-1.5 text-[0.8125rem] font-medium text-white transition-colors hover:bg-white/25"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
          Fechar
        </button>
      </div>
    </div>
  );
}

function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (ref.current?.contains(target) || target.closest("[aria-label='Emoji']")) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Emojis"
      className="absolute bottom-full left-3 z-20 mb-1 grid grid-cols-8 gap-0.5 border border-rule-2 bg-sheet p-1.5 shadow-overlay [border-radius:var(--radius-sheet)]"
    >
      {EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          role="menuitem"
          onClick={() => onPick(emoji)}
          className="flex size-8 items-center justify-center text-[1.125rem] transition-colors hover:bg-band [border-radius:var(--radius-cell)]"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
