import path from "node:path";

/**
 * Resolve um caminho de URL (`/assets/x.js`) dentro de `root`. Devolve null
 * se o resultado escapar da raiz — `..`, barras invertidas, caminho absoluto
 * de outra unidade, byte nulo. É a única porta do protocolo app:// para o disco.
 */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = decoded.replace(/^[/\\]+/, "");
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  const rel = path.relative(base, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Rota da SPA (sem extensão) cai no index.html. */
export function isSpaRoute(urlPath: string): boolean {
  return path.extname(urlPath) === "";
}
