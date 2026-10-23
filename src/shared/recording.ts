/**
 * Nomes e tempos das gravações, sem dependência de Electron nem de DOM.
 */

/** Rótulo vira parte de nome de arquivo do Windows: sem reservados, curto. */
export function safeFileLabel(label: string): string {
  const clean = label
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80);
  return clean || "Gravação";
}

/** "MyScreen 2026-10-23 14-05-09 - Tela de Ana" (sem extensão). */
export function recordingBaseName(label: string, date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}-${p(
    date.getMinutes(),
  )}-${p(date.getSeconds())}`;
  return `MyScreen ${stamp} - ${safeFileLabel(label)}`;
}

/** 0:07, 12:30, 1:02:03. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Nome de arquivo recebido de outro PC: sem pastas nem reservados, extensão preservada. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot).replace(/[^\w.]/g, "") : "";
  const stem = safeFileLabel(dot > 0 && ext ? base.slice(0, dot) : base);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? `_${stem}${ext}` : `${stem}${ext}`;
}
