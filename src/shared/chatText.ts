/**
 * O texto de uma mensagem do chat vira uma lista de pedaços para o React
 * desenhar — nunca HTML. Entende o básico que todo chat entende:
 *
 *   ```bloco de código```   `código`   **negrito**   *itálico* / _itálico_
 *   ~~riscado~~   links (https://…, www.…)   quebras de linha
 *
 * Dentro de código nada é interpretado, nem link.
 */

export type ChatInline =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; children: ChatInline[] }
  | { kind: "italic"; children: ChatInline[] }
  | { kind: "strike"; children: ChatInline[] }
  | { kind: "break" };

export type ChatBlock = { kind: "codeblock"; text: string } | { kind: "paragraph"; children: ChatInline[] };

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
// Pontuação colada no fim de um link é quase sempre da frase, não do link.
const TRAILING_PUNCT = /[.,;:!?…]+$/;

/** Só http(s): `javascript:` e companhia nunca viram link. */
export function linkHref(raw: string): string | null {
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function trimLink(raw: string): string {
  let text = raw.replace(TRAILING_PUNCT, "");
  // Parêntese de fechamento sem abertura dentro do link: é da frase.
  while (text.endsWith(")") && (text.match(/\(/g)?.length ?? 0) < (text.match(/\)/g)?.length ?? 0)) {
    text = text.slice(0, -1);
  }
  return text;
}

function linkify(text: string): ChatInline[] {
  const out: ChatInline[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const raw = trimLink(match[0]);
    const href = linkHref(raw);
    const start = match.index ?? 0;
    if (!href || raw.length === 0) continue;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "link", text: raw, href });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const MARKS: { open: string; kind: "bold" | "italic" | "strike" }[] = [
  { open: "**", kind: "bold" },
  { open: "~~", kind: "strike" },
  { open: "*", kind: "italic" },
  { open: "_", kind: "italic" },
];

/** Ênfase só abre colada numa palavra e fecha colada noutra: "2 * 3 * 4" fica como está. */
function findClose(text: string, mark: string, from: number): number {
  let i = text.indexOf(mark, from);
  while (i !== -1) {
    const before = text[i - 1];
    const after = text[i + mark.length];
    const tight = before !== undefined && !/\s/.test(before);
    // `_` no meio de palavra (nome_de_arquivo) não fecha nada.
    const wordInside = mark === "_" && after !== undefined && /\w/.test(after);
    if (tight && i > from && !wordInside) return i;
    i = text.indexOf(mark, i + 1);
  }
  return -1;
}

function parseEmphasis(text: string): ChatInline[] {
  const out: ChatInline[] = [];
  let buffer = "";
  let i = 0;
  const flush = () => {
    if (buffer) out.push(...linkify(buffer));
    buffer = "";
  };
  while (i < text.length) {
    // Link inteiro passa direto: `_` e `*` dentro de URL não são ênfase.
    const rest = text.slice(i);
    const url = /^(?:https?:\/\/|www\.)[^\s<>"'`]+/i.exec(rest);
    if (url && (i === 0 || /[\s(]/.test(text[i - 1]))) {
      buffer += url[0];
      i += url[0].length;
      continue;
    }
    const mark = MARKS.find((m) => text.startsWith(m.open, i));
    const prev = text[i - 1];
    const next = text[i + (mark?.open.length ?? 0)];
    const opens =
      mark &&
      next !== undefined &&
      !/\s/.test(next) &&
      (prev === undefined || !/\w/.test(prev) || mark.open.length === 2);
    if (mark && opens) {
      const close = findClose(text, mark.open, i + mark.open.length);
      if (close !== -1) {
        flush();
        const inner = text.slice(i + mark.open.length, close);
        out.push({ kind: mark.kind, children: parseEmphasis(inner) });
        i = close + mark.open.length;
        continue;
      }
    }
    buffer += text[i];
    i++;
  }
  flush();
  return out;
}

function parseInline(text: string): ChatInline[] {
  const out: ChatInline[] = [];
  const lines = text.split("\n");
  lines.forEach((line, n) => {
    if (n > 0) out.push({ kind: "break" });
    // `código` primeiro: o que está dentro dele fica literal.
    const parts = line.split(/(`[^`\n]+`)/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        out.push({ kind: "code", text: part.slice(1, -1) });
      } else {
        out.push(...parseEmphasis(part));
      }
    }
  });
  return out;
}

export function parseChatText(text: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const parts = text.split(/```/);
  // Um ``` sem par fica como texto, colado no trecho anterior.
  if (parts.length % 2 === 0) {
    const tail = parts.splice(parts.length - 2, 2);
    parts.push(tail.join("```"));
  }
  parts.forEach((part, n) => {
    if (n % 2 === 1) {
      // A primeira linha pode ser só o nome da linguagem (```ts).
      const body = part.replace(/^[\w+-]*\n/, "").replace(/\n$/, "");
      blocks.push({ kind: "codeblock", text: body });
      return;
    }
    const trimmed = part.replace(/^\n+|\n+$/g, "");
    if (trimmed) blocks.push({ kind: "paragraph", children: parseInline(trimmed) });
  });
  return blocks;
}

/** Mensagem que é só emoji (até 3) aparece grande, como em todo chat. */
export function isEmojiOnly(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 24) return false;
  const emoji = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;
  return emoji.test(t);
}

/** "1,2 MB", "830 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}
