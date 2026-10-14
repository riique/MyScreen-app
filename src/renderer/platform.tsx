import { createContext, useContext, type ReactNode } from "react";
import {
  AUDIO_PORT_MESSAGE,
  type ApiResult,
  type AudioCapabilities,
  type CaptureSource,
  type DesktopBridge,
  type RoomInfo,
  type SystemAudioMode,
  type SystemAudioOptions,
  type TokenResponse,
} from "@shared/ipc";
import { inviteUrl } from "@shared/room";

declare global {
  interface Window {
    myscreen: DesktopBridge;
  }
}

/**
 * Tudo que difere entre navegador e desktop passa por aqui (seção 6.1 do
 * plano). A sala só fala com `Platform`; este app implementa com
 * `window.myscreen`, e o site poderia implementar com as APIs do navegador.
 */
export interface Platform {
  kind: "web" | "desktop";
  api: {
    createRoom(input: { title: string; password?: string }): Promise<RoomInfo>;
    getRoom(id: string): Promise<RoomInfo>;
    token(input: { roomId: string; nickname: string; password?: string; participantIdentity?: string }): Promise<TokenResponse>;
  };
  listCaptureSources(): Promise<CaptureSource[]>;
  selectCaptureSource(id: string, options?: { loopbackAudio?: boolean }): Promise<void>;
  audioCapabilities(): Promise<AudioCapabilities>;
  openSystemAudio(
    mode: SystemAudioMode,
    options: SystemAudioOptions,
    onLost: (message: string) => void,
  ): Promise<{ track: MediaStreamTrack; close(): void }>;
  inviteUrl(roomId: string): string;
  serverUrl(): string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field: string | null,
    readonly retryAfter: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function unwrap<T>(result: ApiResult<T>): T {
  if (result.ok) return result.data;
  throw new ApiError(result.error, result.status, result.field, result.retryAfter);
}

let serverUrlCache = "";

/** Carrega a URL do servidor antes do primeiro render (para o link de convite). */
export async function loadServerUrl(): Promise<string> {
  serverUrlCache = (await window.myscreen.settings.get()).serverUrl;
  return serverUrlCache;
}

export function setServerUrlCache(url: string): void {
  serverUrlCache = url;
}

let sessionCounter = 0;

/**
 * Som do PC vindo do módulo nativo: o processo de áudio escreve PCM numa
 * MessagePort que vai direto ao AudioWorklet (thread de áudio), e o worklet
 * toca numa MediaStreamDestination — a faixa publicada como ScreenShareAudio.
 */
async function openNativeSystemAudio(
  mode: SystemAudioMode,
  options: SystemAudioOptions,
  onLost: (message: string) => void,
): Promise<{ track: MediaStreamTrack; close(): void }> {
  const bridge = window.myscreen;
  const id = `a${Date.now().toString(36)}-${++sessionCounter}`;
  const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
  let closed = false;
  const cleanups: (() => void)[] = [];

  const close = () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanups) fn();
    bridge.audio.stop();
    void ctx.close();
  };

  try {
    await ctx.audioWorklet.addModule(new URL("./pcm-worklet.js", document.baseURI).href);
    await ctx.resume();
    const node = new AudioWorkletNode(ctx, "myscreen-pcm", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    node.connect(dest);

    // A porta pode chegar antes de `start` resolver: escuta primeiro.
    const port = new Promise<MessagePort>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("a porta de áudio não chegou")), 10_000);
      const onMessage = (e: MessageEvent) => {
        if (e.source !== window || e.data?.type !== AUDIO_PORT_MESSAGE || e.data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        const [p] = e.ports;
        if (p) resolve(p);
        else reject(new Error("porta de áudio vazia"));
      };
      window.addEventListener("message", onMessage);
      cleanups.push(() => {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      });
    });

    unwrap(await bridge.audio.start(id, mode, options));
    const p = await port;
    node.port.postMessage({ type: "pcm-port", port: p }, [p]);

    cleanups.push(
      bridge.audio.onLost((message) => {
        if (closed) return;
        close();
        onLost(message);
      }),
    );

    const track = dest.stream.getAudioTracks()[0];
    return { track, close };
  } catch (error) {
    close();
    throw error;
  }
}

export const desktopPlatform: Platform = {
  kind: "desktop",
  api: {
    createRoom: async (input) => unwrap(await window.myscreen.api.createRoom(input)),
    getRoom: async (id) => unwrap(await window.myscreen.api.getRoom(id)),
    token: async (input) => unwrap(await window.myscreen.api.token(input)),
  },
  listCaptureSources: () => window.myscreen.capture.list(),
  selectCaptureSource: (id, options) => window.myscreen.capture.select(id, { loopbackAudio: options?.loopbackAudio === true }),
  audioCapabilities: () => window.myscreen.audio.capabilities(),
  openSystemAudio: openNativeSystemAudio,
  inviteUrl: (roomId) => inviteUrl(serverUrlCache, roomId),
  serverUrl: () => serverUrlCache,
};

const PlatformContext = createContext<Platform>(desktopPlatform);

export function PlatformProvider({ value, children }: { value: Platform; children: ReactNode }) {
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): Platform {
  return useContext(PlatformContext);
}
