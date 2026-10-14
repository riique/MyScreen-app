import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { app, protocol } from "electron";
import { isSpaRoute, mimeFor, resolveInside } from "./paths";
import { APP_HOST, APP_SCHEME } from "./security";
import { getSettings } from "./settings";

/**
 * O renderer é servido por `app://myscreen` (nunca `file://`): origem
 * própria, contexto seguro para `getUserMedia`, e o disco só é lido de dentro
 * de `dist/renderer`.
 */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
    },
  ]);
}

function rendererRoot(): string {
  return path.join(app.getAppPath(), "dist", "renderer");
}

/**
 * CSP por cabeçalho, porque o servidor é configurável: a API passa pelo
 * processo principal, mas o LiveKit fala direto do renderer (wss) e pode
 * morar noutro host. `https:`/`wss:` cobre qualquer servidor seguro; o
 * servidor local (http) entra pelo nome.
 */
function contentSecurityPolicy(): string {
  const connect = ["'self'", "https:", "wss:"];
  const server = getSettings().serverUrl;
  if (server.startsWith("http://")) {
    const host = new URL(server).host;
    connect.push(server, `ws://${host}`, "ws://localhost:7880", "ws://127.0.0.1:7880");
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "media-src 'self' blob: mediastream:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join("; ");
}

async function serve(root: string, urlPath: string): Promise<Response> {
  let file = resolveInside(root, urlPath === "/" ? "/index.html" : urlPath);
  if (!file) return new Response("Proibido", { status: 403 });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("não é arquivo");
  } catch {
    if (!isSpaRoute(urlPath)) return new Response("Não encontrado", { status: 404 });
    file = path.join(root, "index.html");
  }
  const body = await readFile(file);
  const headers: Record<string, string> = {
    "Content-Type": mimeFor(file),
    "X-Content-Type-Options": "nosniff",
  };
  if (file.endsWith(".html")) {
    headers["Content-Security-Policy"] = contentSecurityPolicy();
    headers["Cache-Control"] = "no-cache";
  }
  return new Response(body, { status: 200, headers });
}

export function handleAppProtocol(): void {
  const root = rendererRoot();
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response("Não encontrado", { status: 404 });
    try {
      return await serve(root, url.pathname);
    } catch (error) {
      console.error("app:// falhou:", error);
      return new Response("Erro", { status: 500 });
    }
  });
}
