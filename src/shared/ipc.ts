/**
 * Contrato entre o renderer e o processo principal. O preload expõe
 * exatamente esta forma em `window.myscreen` — funções estreitas, nunca o
 * `ipcRenderer` cru.
 */

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; field: string | null; status: number; retryAfter: number | null };

export interface RoomInfo {
  id: string;
  title: string;
  isLocked: boolean;
  exists: boolean;
}

export interface TokenResponse {
  token: string;
  livekitUrl: string;
  participantIdentity: string;
  participantName: string;
}

export interface CaptureSource {
  /** "screen:0:0" | "window:<HWND>:0" */
  id: string;
  kind: "screen" | "window";
  name: string;
  thumbnail: string;
  appIcon: string | null;
  displayId: string | null;
  /** "2560 × 1440" para telas, quando o monitor foi casado. */
  detail: string | null;
}

export type SystemAudioMode =
  | { kind: "off" }
  | { kind: "system-except-self"; alsoExcludeDiscord?: boolean }
  | { kind: "window-only"; sourceId: string };

export interface AudioCapabilities {
  /** Addon nativo carregou e o Windows tem loopback por processo. */
  native: boolean;
  /** Por que o nativo não está disponível, em pt-BR. */
  reason: string | null;
}

export interface SystemAudioOptions {
  normalize: boolean;
  /** 0–400 */
  gainPct: number;
}

export interface AudioLevel {
  level: number;
  agcDb: number;
}

export type ThemePreference = "light" | "dark" | "system";

export interface AppSettings {
  serverUrl: string;
  shortcutsEnabled: boolean;
  /** Último nome usado para entrar numa sala; pré-preenche o próximo. */
  nickname: string;
  /** Baixa sozinho quando há versão nova; desligado, espera o botão "Baixar". */
  autoDownloadUpdates: boolean;
}

export interface RoomState {
  inRoom: boolean;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
}

export interface SharingState {
  active: boolean;
  sourceName: string;
  displayId: string | null;
  hideSelf: boolean;
  hasSystemAudio: boolean;
}

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "uptodate"; checkedAt: number }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export type ShortcutAction = "mic" | "cam" | "stop-share";

export interface DesktopBridge {
  app: {
    info(): Promise<{ version: string; platform: string; isPackaged: boolean }>;
    consumePendingRoom(): Promise<string | null>;
    onNavigate(cb: (roomId: string) => void): () => void;
    setTheme(effective: "light" | "dark", preference: ThemePreference): void;
    openPrivacySettings(kind: "webcam" | "microphone"): void;
    openExternal(url: string): void;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<ApiResult<AppSettings>>;
  };
  api: {
    createRoom(input: { title: string; password?: string }): Promise<ApiResult<RoomInfo>>;
    getRoom(id: string): Promise<ApiResult<RoomInfo>>;
    token(input: {
      roomId: string;
      nickname: string;
      password?: string;
      participantIdentity?: string;
    }): Promise<ApiResult<TokenResponse>>;
    desktopInfo(): Promise<ApiResult<{ minVersion: string | null }>>;
  };
  capture: {
    list(): Promise<CaptureSource[]>;
    select(id: string, options: { loopbackAudio: boolean }): Promise<void>;
  };
  audio: {
    capabilities(): Promise<AudioCapabilities>;
    /** Abre a captura; a porta PCM chega por `window.postMessage` com `id`. */
    start(id: string, mode: SystemAudioMode, options: SystemAudioOptions): Promise<ApiResult<null>>;
    update(patch: Partial<SystemAudioOptions> & { paused?: boolean }): void;
    stop(): void;
    onLevel(cb: (level: AudioLevel) => void): () => void;
    onLost(cb: (message: string) => void): () => void;
    onError(cb: (message: string) => void): () => void;
  };
  room: {
    setState(state: RoomState): void;
    setSharing(state: SharingState): void;
    notify(title: string, body: string): void;
    onShortcut(cb: (action: ShortcutAction) => void): () => void;
    onLeaveRequest(cb: () => void): () => void;
    onStopShareRequest(cb: () => void): () => void;
    onAudioPauseChanged(cb: (paused: boolean) => void): () => void;
  };
  updates: {
    status(): Promise<UpdateStatus>;
    onStatus(cb: (status: UpdateStatus) => void): () => void;
    check(): void;
    download(): void;
    install(): void;
  };
}

/** Mensagem que o preload repassa ao mundo principal com a porta PCM. */
export const AUDIO_PORT_MESSAGE = "myscreen:audio-port";
