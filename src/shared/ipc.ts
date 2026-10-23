import type { MediaPrefs } from "./media";

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
  /** HMAC do servidor sobre sala + identidade: só com ela a identidade é reusada. */
  identityProof: string | null;
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
  /** "Nunca aceitar pedidos de controle": o app nem anuncia que pode ser controlado. */
  remoteControlDisabled: boolean;
  /** Últimos estados de microfone e câmera, aparelhos e aprimoramentos. */
  media: MediaPrefs;
}

/** `media` também vai em pedaços: o main mescla com o que já está salvo. */
export type AppSettingsPatch = Partial<Omit<AppSettings, "media">> & { media?: Partial<MediaPrefs> };

export interface RoomState {
  inRoom: boolean;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
}

export interface SharingState {
  active: boolean;
  /** Tela inteira ou janela: só tela inteira pode ser controlada. */
  kind: "screen" | "window" | null;
  sourceName: string;
  displayId: string | null;
  /** A publicação de tela no SFU: a sessão de controle fica presa a ela. */
  trackSid: string | null;
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

// ---------------------------------------------------------------- controle remoto

/** O que quem controla copiou, pronto para mandar ao PC controlado. */
export type RichClipboard =
  | { kind: "same" }
  | { kind: "empty" }
  | { kind: "text"; key: string; text: string }
  | { kind: "image"; key: string; name: string; bytes: Uint8Array }
  | { kind: "files"; key: string; files: { name: string; bytes: Uint8Array }[]; skippedFolders: number }
  | { kind: "unsupported"; key: string; message: string };

/** Imagem/arquivos recebidos por byte stream, para o portão conferir e gravar. */
export interface ClipDelivery {
  sessionId: string;
  clipId: string;
  kind: "image" | "files";
  files: { name: string; bytes: Uint8Array }[];
}

export interface RemoteCapabilities {
  /** O injetor nativo carregou: este PC pode ser controlado. */
  available: boolean;
  reason: string | null;
}

/** Remetente de um pacote, como o SFU carimbou. */
export interface RemotePeer {
  identity: string;
  sid: string;
  name: string;
}

export interface RemoteConsentRequest {
  reqId: string;
  name: string;
  identity: string;
  sourceName: string;
}

export interface RemoteSessionInfo {
  identity: string;
  name: string;
  paused: boolean;
  elevated: boolean;
}

/** Mudança de sessão do lado controlado: começo, pausa, ou fim (com motivo). */
export interface RemoteSessionEvent {
  session: RemoteSessionInfo | null;
  ended: { reason: string; identity: string; name: string } | null;
}

export interface DesktopBridge {
  app: {
    info(): Promise<{ version: string; platform: string; isPackaged: boolean }>;
    consumePendingRoom(): Promise<string | null>;
    onNavigate(cb: (roomId: string) => void): () => void;
    setTheme(effective: "light" | "dark", preference: ThemePreference): void;
    openPrivacySettings(kind: "webcam" | "microphone"): void;
    openExternal(url: string): void;
    /** Link clicado no chat: qualquer http(s), no navegador padrão. */
    openLink(url: string): void;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: AppSettingsPatch): Promise<ApiResult<AppSettings>>;
  };
  api: {
    createRoom(input: { title: string; password?: string }): Promise<ApiResult<RoomInfo>>;
    getRoom(id: string): Promise<ApiResult<RoomInfo>>;
    token(input: {
      roomId: string;
      nickname: string;
      password?: string;
      participantIdentity?: string;
      identityProof?: string;
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
  remote: {
    capabilities(): Promise<RemoteCapabilities>;
    /** Mensagem `rc.ctl` já validada pelo esquema, com o remetente do SFU. */
    control(from: RemotePeer, msg: unknown): void;
    /** Pacote `rc.in` cru: quem interpreta é o processo principal. */
    input(from: RemotePeer, bytes: Uint8Array): void;
    decide(reqId: string, allow: boolean): void;
    peerSeen(identity: string, sid: string): void;
    peerGone(identity: string): void;
    roomLost(): void;
    stop(): void;
    pause(paused: boolean): void;
    /** Libera janelas de administrador (pede o UAC). Resolve se ficou liberado. */
    elevate(): Promise<boolean>;
    /** Lado de quem controla: liga/desliga o hook que manda TODA tecla ao PC remoto. */
    captureKeys(on: boolean): void;
    /** Lado de quem controla: o texto da área de transferência deste PC. */
    readClipboard(): Promise<string>;
    /** Lado de quem controla: texto, imagem ou arquivos copiados aqui (`same` se nada mudou desde `lastKey`). */
    readClipboardRich(lastKey: string | null): Promise<RichClipboard>;
    /** Lado controlado: imagem/arquivos chegaram de quem controla; o main decide se entram. */
    deliverClip(from: RemotePeer, clip: ClipDelivery): void;
    /** Tecla física engolida pelo hook (scancode do protocolo). */
    onHookKey(cb: (scancode: number, down: boolean) => void): () => void;
    /** O hook ligou (true) ou não está disponível/desligou (false). */
    onHookState(cb: (on: boolean) => void): () => void;
    /** O processo principal pede para mandar um `rc.ctl` a alguém. */
    onSend(cb: (to: string, msg: unknown) => void): () => void;
    onConsent(cb: (req: RemoteConsentRequest) => void): () => void;
    onConsentClosed(cb: (reqId: string) => void): () => void;
    onSession(cb: (event: RemoteSessionEvent) => void): () => void;
  };
  recording: {
    /** Cria o arquivo em Vídeos\MyScreen; o id identifica os pedaços seguintes. */
    open(label: string, ext: "mp4" | "webm"): Promise<{ id: string; file: string }>;
    write(id: string, bytes: Uint8Array): void;
    /** Fecha o arquivo; resolve com o caminho dele (null se já estava fechado). */
    close(id: string): Promise<string | null>;
    /** Mostra o arquivo no Explorer, ou abre a pasta das gravações. */
    reveal(file: string | null): void;
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
