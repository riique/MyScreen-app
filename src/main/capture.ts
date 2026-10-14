import { BrowserWindow, desktopCapturer, screen, session } from "electron";
import type { CaptureSource } from "../shared/ipc";
import { hwndFromSourceId } from "../shared/media";

/**
 * Seletor próprio de telas e janelas. O renderer lista as fontes, a pessoa
 * escolhe, o renderer diz qual (`select`) e chama `getDisplayMedia`, que cai
 * no handler abaixo e recebe exatamente aquela fonte.
 */

let chosen: { id: string; loopbackAudio: boolean } | null = null;

/** HWNDs das janelas do próprio MyScreen: não aparecem na lista. */
function ownHwnds(): Set<bigint> {
  const set = new Set<bigint>();
  for (const win of BrowserWindow.getAllWindows()) {
    const handle = win.getNativeWindowHandle();
    set.add(handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0)));
  }
  return set;
}

function displayDetail(displayId: string | null): { name: string | null; detail: string | null } {
  if (!displayId) return { name: null, detail: null };
  const display = screen.getAllDisplays().find((d) => String(d.id) === displayId);
  if (!display) return { name: null, detail: null };
  const w = Math.round(display.size.width * display.scaleFactor);
  const h = Math.round(display.size.height * display.scaleFactor);
  return { name: display.label || null, detail: `${w} × ${h}` };
}

export async function listCaptureSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  const own = ownHwnds();
  const primaryId = String(screen.getPrimaryDisplay().id);
  let screenIndex = 0;
  return sources
    .filter((s) => {
      const hwnd = hwndFromSourceId(s.id);
      return hwnd === null || !own.has(hwnd);
    })
    .map((s): CaptureSource => {
      const kind = s.id.startsWith("screen:") ? "screen" : "window";
      const displayId = s.display_id || null;
      if (kind === "screen") {
        screenIndex++;
        const { name, detail } = displayDetail(displayId);
        const primary = displayId === primaryId ? " (principal)" : "";
        return {
          id: s.id,
          kind,
          name: `${name ? name : `Tela ${screenIndex}`}${primary}`,
          thumbnail: s.thumbnail.toDataURL(),
          appIcon: null,
          displayId,
          detail,
        };
      }
      return {
        id: s.id,
        kind,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        displayId: null,
        detail: null,
      };
    })
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "screen" ? -1 : 1));
}

export function selectCaptureSource(id: string, loopbackAudio: boolean): void {
  if (!/^(screen|window):[\d:-]+$/.test(id)) throw new Error("fonte inválida");
  chosen = { id, loopbackAudio };
}

export function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const pick = chosen;
      chosen = null; // uma escolha vale para um getDisplayMedia só
      if (!pick) {
        callback({});
        return;
      }
      try {
        // Miniatura 0×0: aqui só importa o id, e gerar thumbnail de todas as
        // janelas atrasaria o início da captura.
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
        });
        const source = sources.find((s) => s.id === pick.id);
        if (!source) {
          callback({});
          return;
        }
        // O som normalmente NÃO vem daqui: sai do módulo nativo, que sabe
        // excluir o próprio MyScreen. `loopback` é o plano B, com risco de eco.
        callback(pick.loopbackAudio ? { video: source, audio: "loopback" } : { video: source });
      } catch (error) {
        console.error("Falha ao resolver a fonte de captura:", error);
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}
