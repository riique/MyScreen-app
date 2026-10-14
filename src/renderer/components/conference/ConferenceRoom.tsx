import {
  LiveKitRoom,
  RoomAudioRenderer,
  isTrackReference,
  useChat,
  useConnectionState,
  useIsMuted,
  useIsSpeaking,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import {
  AudioPresets,
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  ParticipantEvent,
  RemoteTrackPublication,
  RoomEvent,
  Track,
  VideoPresets,
  VideoQuality,
  supportsAudioOutputSelection,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
} from "livekit-client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AudioCapabilities, CaptureSource, SystemAudioMode } from "@shared/ipc";
import { RESOLUTION, SCREEN_BITRATE, screenBitrate } from "@shared/media";
import { ChatSidebar } from "./ChatSidebar";
import { MediaControls } from "./MediaControls";
import { ParticipantsList } from "./ParticipantsList";
import { SettingsModal, type MediaSettings } from "./SettingsModal";
import { ShareDialog } from "./ShareDialog";
import { SystemAudioControl } from "./SystemAudioControl";
import { TrackStatsDropdown } from "./TrackStatsDropdown";
import {
  readCapture,
  readSystemAudio,
  writeCapture,
  writeSystemAudio,
  type CaptureSettings,
  type SystemAudioPrefs,
} from "@/components/capture/capturePrefs";
import { ThemeToggle } from "@/components/ThemeToggle";
import { cn } from "@/lib/utils";
import { usePlatform } from "@/platform";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronUp,
  Columns2,
  ExternalLink,
  Link2,
  Maximize2,
  MessageSquare,
  MicOff,
  MonitorUp,
  PictureInPicture2,
  Pin,
  PinOff,
  Users,
  Video,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

/** Nomes de erro de mídia que valem uma explicação, e não um "erro desconhecido". */
const MEDIA_ERROR_NAMES = new Set([
  "NotReadableError",
  "NotAllowedError",
  "NotFoundError",
  "OverconstrainedError",
  "NotSupportedError",
  "AbortError",
]);

function getErrorName(error: unknown): string | undefined {
  return error instanceof Error && MEDIA_ERROR_NAMES.has(error.name) ? error.name : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ConferenceRoomProps {
  roomId: string;
  token: string;
  serverUrl: string;
  initialAudioEnabled?: boolean;
  initialVideoEnabled?: boolean;
  initialAudioDeviceId?: string;
  initialVideoDeviceId?: string;
  onLeave: () => void;
  onReconnect: () => void;
}

/**
 * A sala é uma folha com um instrumento montado nela: papel pautado em volta,
 * monitor escuro no meio — é contra um fundo neutro que se avalia imagem.
 */
export function ConferenceRoom({
  roomId,
  token,
  serverUrl,
  initialAudioEnabled = true,
  initialVideoEnabled = true,
  initialAudioDeviceId,
  initialVideoDeviceId,
  onLeave,
  onReconnect,
}: ConferenceRoomProps) {
  const [fatalError, setFatalError] = useState<string | null>(null);
  // Uma saída pedida pelo usuário não é queda de conexão.
  const userInitiatedLeave = useRef(false);

  function handleOnError(error: Error) {
    console.error("LiveKit Room disconnected:", error);
    if (userInitiatedLeave.current) return;
    const name = getErrorName(error);
    setFatalError(
      name
        ? `Não foi possível abrir um dispositivo (${name}). Você entrou sem ele — pode tentar de novo em Configurações de mídia.`
        : "A conexão com a conferência foi interrompida.",
    );
  }

  function handleOnDisconnected(reason?: DisconnectReason) {
    console.info("LiveKit encerrado. Motivo:", reason ?? "desconhecido");
    if (userInitiatedLeave.current) return;
    setFatalError("A conexão com a conferência foi interrompida.");
  }

  const leave = useCallback(() => {
    userInitiatedLeave.current = true;
    onLeave();
  }, [onLeave]);

  return (
    <div className="flex h-full flex-col">
      <LiveKitRoom
        token={token}
        serverUrl={serverUrl}
        connect
        audio={
          initialAudioEnabled
            ? {
                deviceId: initialAudioDeviceId,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              }
            : false
        }
        video={initialVideoEnabled ? { deviceId: initialVideoDeviceId } : false}
        onError={handleOnError}
        onConnected={() => setFatalError(null)}
        onDisconnected={handleOnDisconnected}
        options={{
          // Sem adaptiveStream: a assinatura fica sempre na camada mais alta, e
          // redimensionar a janela não troca a resolução recebida.
          adaptiveStream: false,
          dynacast: true,
          webAudioMix: true,
          stopLocalTrackOnUnpublish: true,
          videoCaptureDefaults: { resolution: VideoPresets.h1080.resolution },
          publishDefaults: {
            videoEncoding: { maxBitrate: 3_000_000, maxFramerate: 30, priority: "high" },
            screenShareEncoding: {
              maxBitrate: SCREEN_BITRATE["1080p"],
              maxFramerate: 30,
              priority: "high",
            },
            degradationPreference: "maintain-resolution",
          },
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <RoomAudioRenderer />
        <ConferenceStage roomId={roomId} token={token} onLeave={leave} />
      </LiveKitRoom>

      {fatalError ? (
        <div role="alert" className="fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4">
          <div className="flex w-full max-w-[34rem] flex-wrap items-center justify-between gap-3 border border-alert-line bg-sheet px-4 py-3 shadow-overlay [border-radius:var(--radius-sheet)]">
            <p className="min-w-0 flex-1 text-[0.875rem] text-alert">{fatalError}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onReconnect}
                className="border border-rule-2 bg-sheet px-3 py-1.5 text-[0.8125rem] font-semibold text-ink transition-colors hover:bg-band [border-radius:var(--radius-cell)]"
              >
                Reconectar
              </button>
              <button
                type="button"
                onClick={leave}
                className="border border-transparent px-3 py-1.5 text-[0.8125rem] text-ink-2 transition-colors hover:text-ink [border-radius:var(--radius-sheet)]"
              >
                Início
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type SystemAudioHandle = { track: MediaStreamTrack; close(): void };

function ConferenceStage({ roomId, token, onLeave }: { roomId: string; token: string; onLeave: () => void }) {
  const platform = usePlatform();
  const room = useRoomContext();
  const {
    localParticipant,
    isMicrophoneEnabled: isMicOn,
    isCameraEnabled: isCamOn,
    isScreenShareEnabled: isScreenSharing,
  } = useLocalParticipant();
  const connectionState = useConnectionState();

  const [settings, setSettings] = useState<MediaSettings>(() => {
    const prefs = readCapture();
    return {
      screenFps: Number(prefs.frameRate),
      screenResolution: prefs.resolution,
      screenContentType: "motion",
      systemAudio: true,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
  });
  // Espelho síncrono: dois ajustes seguidos não podem partir do mesmo estado velho.
  const settingsRef = useRef<MediaSettings>(settings);
  const [capture, setCapture] = useState<CaptureSettings>(readCapture);
  const [audioPrefs, setAudioPrefs] = useState<SystemAudioPrefs>(readSystemAudio);
  const [audioCaps, setAudioCaps] = useState<AudioCapabilities | null>(null);

  const [panel, setPanel] = useState<Panel | null>(null);
  // Qual trilha o painel de estatísticas mede; null segue a que está em foco.
  const [statsKey, setStatsKey] = useState<string | null>(null);

  // O chat vive aqui, e não no painel: o painel desmonta ao fechar.
  const chat = useChat();
  const [chatDraft, setChatDraft] = useState("");
  const [chatSeen, setChatSeen] = useState(0);
  const chatCount = chat.chatMessages.length;
  useEffect(() => {
    if (panel === "chat") setChatSeen(chatCount);
  }, [panel, chatCount]);
  const chatUnread = panel === "chat" ? 0 : Math.max(0, chatCount - chatSeen);

  // Mensagem nova com a janela fora de foco: notificação do Windows.
  const notifiedCount = useRef(chatCount);
  useEffect(() => {
    const fresh = chat.chatMessages.slice(notifiedCount.current);
    notifiedCount.current = chat.chatMessages.length;
    if (document.hasFocus()) return;
    for (const msg of fresh) {
      if (msg.from?.isLocal) continue;
      window.myscreen.room.notify(`${msg.from?.name || "Participante"} no chat`, msg.message.slice(0, 300));
    }
  }, [chat.chatMessages]);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string[]>([]);
  const [dockHidden, setDockHidden] = useState(readDockHidden);
  const [unstableConnection, setUnstableConnection] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [screenShareError, setScreenShareError] = useState<string | null>(null);
  const [systemAudioActive, setSystemAudioActive] = useState(false);
  const [audioPaused, setAudioPaused] = useState(false);
  const [devices, setDevices] = useState({
    audioInputs: [] as MediaDeviceInfo[],
    videoInputs: [] as MediaDeviceInfo[],
    audioOutputs: [] as MediaDeviceInfo[],
  });

  useEffect(() => {
    void platform.audioCapabilities().then(setAudioCaps);
  }, [platform]);

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  const screenShareRefs = tracks.filter(isTrackReference).filter((t) => t.source === Track.Source.ScreenShare);
  const cameraTiles = tracks.filter((t) => t.source === Track.Source.Camera);
  const cameraRefs = cameraTiles.filter(isTrackReference);

  const loadDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        audioInputs: list.filter((d) => d.kind === "audioinput"),
        videoInputs: list.filter((d) => d.kind === "videoinput"),
        audioOutputs: list.filter((d) => d.kind === "audiooutput"),
      });
    } catch (error) {
      console.error("Could not enumerate devices:", error);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /* --- Som do PC (módulo nativo) ---------------------------------------- */
  const systemAudioRef = useRef<SystemAudioHandle | null>(null);
  const stopSystemAudio = useCallback(() => {
    const handle = systemAudioRef.current;
    systemAudioRef.current = null;
    setSystemAudioActive(false);
    setAudioPaused(false);
    if (handle) handle.close();
    const audio = localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
    if (audio?.track) void localParticipant.unpublishTrack(audio.track);
  }, [localParticipant]);

  const endSharing = useCallback(() => {
    stopSystemAudio();
    window.myscreen.room.setSharing({ active: false, sourceName: "", displayId: null, hideSelf: false, hasSystemAudio: false });
  }, [stopSystemAudio]);

  // A tela pode parar sem passar pelo botão (janela capturada fechou, barra
  // flutuante, atalho): o som do PC e a barra param junto.
  useEffect(() => {
    const onUnpublished = (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.ScreenShare) endSharing();
    };
    localParticipant.on(ParticipantEvent.LocalTrackUnpublished, onUnpublished);
    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackUnpublished, onUnpublished);
      endSharing();
    };
  }, [localParticipant, endSharing]);

  useEffect(() => {
    const offError = window.myscreen.audio.onError((message) =>
      setScreenShareError(`O som do PC falhou e está tentando de novo: ${message}`),
    );
    const offPause = window.myscreen.room.onAudioPauseChanged(setAudioPaused);
    return () => {
      offError();
      offPause();
    };
  }, []);

  // O token do LiveKit expira; sem trocar o token da engine, o SFU derruba a
  // sala na renovação seguinte mesmo com tudo saudável.
  useEffect(() => {
    const engine = (room as unknown as { engine?: { token: string } }).engine;
    if (engine) engine.token = token;
  }, [room, token]);

  useEffect(() => {
    function onQuality(quality: ConnectionQuality, participant: Participant) {
      if (participant.isLocal && quality === ConnectionQuality.Poor) setUnstableConnection(true);
    }
    function onAudioPlayback(playing: boolean) {
      setAudioBlocked(!playing);
    }
    function onDevices() {
      void loadDevices();
    }
    // Toda trilha de vídeo recebida fica presa na camada mais alta.
    function pinHighQuality(publication: RemoteTrackPublication) {
      if (publication.kind === Track.Kind.Video) publication.setVideoQuality(VideoQuality.HIGH);
    }
    function onSubscribed(_track: unknown, publication: RemoteTrackPublication) {
      pinHighQuality(publication);
    }
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        pinHighQuality(publication);
      }
    }

    room
      .on(RoomEvent.ConnectionQualityChanged, onQuality)
      .on(RoomEvent.AudioPlaybackStatusChanged, onAudioPlayback)
      .on(RoomEvent.MediaDevicesChanged, onDevices)
      .on(RoomEvent.TrackSubscribed, onSubscribed)
      .on(RoomEvent.TrackPublished, pinHighQuality);

    return () => {
      room
        .off(RoomEvent.ConnectionQualityChanged, onQuality)
        .off(RoomEvent.AudioPlaybackStatusChanged, onAudioPlayback)
        .off(RoomEvent.MediaDevicesChanged, onDevices)
        .off(RoomEvent.TrackSubscribed, onSubscribed)
        .off(RoomEvent.TrackPublished, pinHighQuality);
    };
  }, [room, loadDevices]);

  const toggleMic = useCallback(async () => {
    const current = settingsRef.current;
    try {
      await localParticipant.setMicrophoneEnabled(!localParticipant.isMicrophoneEnabled, {
        deviceId: current.audioInputId,
        echoCancellation: current.echoCancellation,
        noiseSuppression: current.noiseSuppression,
        autoGainControl: current.autoGainControl,
      });
    } catch (error) {
      console.error("Erro ao alternar microfone:", error);
      throw new Error(mediaFailure(error, "microfone"));
    }
  }, [localParticipant]);

  const toggleCam = useCallback(async () => {
    try {
      await localParticipant.setCameraEnabled(!localParticipant.isCameraEnabled, {
        deviceId: settingsRef.current.videoInputId,
      });
    } catch (error) {
      console.error("Erro ao alternar câmera:", error);
      throw new Error(mediaFailure(error, "câmera"));
    }
  }, [localParticipant]);

  const stopScreenShare = useCallback(async () => {
    endSharing();
    try {
      await localParticipant.setScreenShareEnabled(false);
    } catch (error) {
      console.error("Erro ao parar a tela:", error);
    }
  }, [localParticipant, endSharing]);

  /**
   * Compartilha a fonte escolhida no seletor do app. O vídeo sai do
   * `getDisplayMedia` (que o processo principal resolve para a fonte
   * escolhida); o som do PC sai do módulo nativo, publicado à parte como
   * ScreenShareAudio. Sem nativo, o plano B é o loopback do Chromium.
   */
  const startScreenShare = useCallback(
    async (next: CaptureSettings, source: CaptureSource, nextAudio: SystemAudioPrefs) => {
      writeCapture(next);
      writeSystemAudio(nextAudio);
      setCapture(next);
      setAudioPrefs(nextAudio);
      const merged: MediaSettings = {
        ...settingsRef.current,
        screenFps: Number(next.frameRate),
        screenResolution: next.resolution,
        screenContentType: "motion",
        systemAudio: true,
      };
      settingsRef.current = merged;
      setSettings(merged);

      // Trocar de fonte com a tela no ar: para a anterior primeiro.
      if (localParticipant.isScreenShareEnabled) await stopScreenShare();

      const native = audioCaps?.native === true;
      // O som vai sempre completo: o sistema inteiro, menos o MyScreen.
      const loopback = !native;

      const { width, height } = RESOLUTION[merged.screenResolution];
      const contentHint = merged.screenContentType === "detail" ? "detail" : "motion";
      const publishOptions: TrackPublishOptions = {
        screenShareEncoding: {
          maxBitrate: screenBitrate(merged.screenResolution, merged.screenFps),
          maxFramerate: merged.screenFps,
          priority: "high",
        },
        // Uma camada só: quem assiste recebe sempre a tela inteira.
        simulcast: false,
        // Texto precisa de nitidez (cai a taxa); vídeo e jogo, de fluidez.
        degradationPreference: merged.screenContentType === "detail" ? "maintain-resolution" : "maintain-framerate",
      };
      const captureOptions = (withAudio: boolean): ScreenShareCaptureOptions => ({
        // Som do sistema CRU: sem AEC, supressão ou AGC, que apagariam música e jogo.
        audio: withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
        systemAudio: withAudio ? "include" : "exclude",
        suppressLocalAudioPlayback: false,
        contentHint,
        resolution: { width, height, frameRate: merged.screenFps },
      });

      try {
        await platform.selectCaptureSource(source.id, { loopbackAudio: loopback });
        await localParticipant.setScreenShareEnabled(true, captureOptions(loopback), publishOptions);
        setScreenShareError(null);
      } catch (error) {
        const name = getErrorName(error) ?? (error instanceof Error ? error.name : "Erro");
        const message = getErrorMessage(error);
        console.error("Erro ao compartilhar tela:", error);
        if (name === "AbortError" || (name === "NotAllowedError" && !/system/i.test(message))) return;
        // O plano B do som falhou: a tela ainda pode ir sem ele.
        if (loopback) {
          try {
            await platform.selectCaptureSource(source.id, { loopbackAudio: false });
            await localParticipant.setScreenShareEnabled(true, captureOptions(false), publishOptions);
            setScreenShareError(`O som do PC não pôde ser capturado (${name}). A tela está indo só com vídeo.`);
          } catch (fallbackError) {
            setScreenShareError(`Não foi possível compartilhar a tela: ${getErrorMessage(fallbackError)}`);
            return;
          }
        } else {
          setScreenShareError(`Não foi possível compartilhar a tela (${name}): ${message}`);
          return;
        }
      }

      window.myscreen.room.setSharing({
        active: true,
        sourceName: source.name,
        displayId: source.displayId,
        hideSelf: next.hideSelf,
        hasSystemAudio: false,
      });

      if (native) {
        const mode: SystemAudioMode = { kind: "system-except-self", alsoExcludeDiscord: nextAudio.excludeDiscord };
        try {
          const handle = await platform.openSystemAudio(
            mode,
            { normalize: nextAudio.normalize, gainPct: nextAudio.gainPct },
            (lostMessage) => {
              systemAudioRef.current = null;
              setSystemAudioActive(false);
              const pub = localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
              if (pub?.track) void localParticipant.unpublishTrack(pub.track);
              setScreenShareError(lostMessage);
            },
          );
          systemAudioRef.current = handle;
          await localParticipant.publishTrack(handle.track, {
            source: Track.Source.ScreenShareAudio,
            name: "screen_share_audio",
            audioPreset: AudioPresets.musicHighQualityStereo,
            forceStereo: true,
            dtx: false,
            red: false,
          });
          setSystemAudioActive(true);
          window.myscreen.room.setSharing({
            active: true,
            sourceName: source.name,
            displayId: source.displayId,
            hideSelf: next.hideSelf,
            hasSystemAudio: true,
          });
        } catch (error) {
          console.error("Erro ao abrir o som do PC:", error);
          stopSystemAudio();
          setScreenShareError(
            `Não foi possível abrir o som do PC (${getErrorMessage(error)}). A tela está no ar sem ele.`,
          );
        }
      } else if (loopback) {
        if (localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)) {
          setScreenShareError(
            "O som do PC está indo pelo captador do Chromium, que também pega a voz da chamada. Use fone de ouvido para não fazer eco.",
          );
        }
      }
    },
    [platform, localParticipant, audioCaps, stopScreenShare, stopSystemAudio],
  );

  const resumeAudioPlayback = useCallback(async () => {
    try {
      await room.startAudio();
      setAudioBlocked(false);
    } catch (error) {
      console.error("Não foi possível retomar o áudio:", error);
    }
  }, [room]);

  /**
   * Aplica um patch nos ajustes de mídia, ou não aplica nada: cada grupo volta
   * atrás sozinho se o Chromium recusar.
   */
  const applyMediaSettings = useCallback(
    async (patch: Partial<MediaSettings>) => {
      const previous = settingsRef.current;
      const next = { ...previous, ...patch };
      const rollback = () => {
        settingsRef.current = previous;
        setSettings(previous);
      };

      const touchesProcessors =
        patch.echoCancellation !== undefined ||
        patch.noiseSuppression !== undefined ||
        patch.autoGainControl !== undefined;

      // `applyConstraints` e NÃO `restartTrack`, que perde o `deviceId`.
      if (touchesProcessors) {
        const track = localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
        if (track instanceof LocalAudioTrack) {
          try {
            await track.applyConstraints({
              echoCancellation: next.echoCancellation,
              noiseSuppression: next.noiseSuppression,
              autoGainControl: next.autoGainControl,
            });
          } catch (error) {
            console.error("Erro ao aplicar aprimoramentos de microfone:", error);
            rollback();
            return;
          }
        }
      }

      if (patch.audioInputId !== undefined || "audioInputId" in patch) {
        try {
          const switched = await room.switchActiveDevice("audioinput", patch.audioInputId ?? "default");
          if (!switched) throw new Error("O microfone selecionado foi recusado.");
        } catch (error) {
          console.error("Erro ao trocar o microfone:", error);
          rollback();
          return;
        }
      }
      if (patch.videoInputId !== undefined || "videoInputId" in patch) {
        try {
          const switched = await room.switchActiveDevice("videoinput", patch.videoInputId ?? "default");
          if (!switched) throw new Error("A câmera selecionada foi recusada.");
        } catch (error) {
          console.error("Erro ao trocar a câmera:", error);
          rollback();
          return;
        }
      }
      if (patch.audioOutputId !== undefined || "audioOutputId" in patch) {
        if (supportsAudioOutputSelection() || "setSinkId" in AudioContext.prototype) {
          try {
            await room.switchActiveDevice("audiooutput", patch.audioOutputId ?? "default");
          } catch (error) {
            console.error("Erro ao trocar a saída de áudio:", error);
            rollback();
            return;
          }
        }
      }

      settingsRef.current = next;
      setSettings(next);
    },
    [localParticipant, room],
  );

  const handleLeave = useCallback(() => {
    endSharing();
    void room.disconnect();
    onLeave();
  }, [room, onLeave, endSharing]);

  /* --- Tela cheia --------------------------------------------------------- */
  const shellRef = useRef<HTMLDivElement>(null);
  const [fullscreenEl, setFullscreenEl] = useState<Element | null>(null);
  const [canFullscreen, setCanFullscreen] = useState(false);

  useEffect(() => {
    setCanFullscreen(Boolean(document.fullscreenEnabled));
    const onChange = () => setFullscreenEl(document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback((element: Element | null) => {
    if (!element) return;
    if (document.fullscreenElement === element) {
      void document.exitFullscreen();
      return;
    }
    void element.requestFullscreen().catch((error: unknown) => {
      console.error("Tela cheia recusada:", error);
    });
  }, []);

  /** Um erro de microfone/câmera vira aviso na régua, nunca promessa rejeitada solta. */
  const guard = useCallback(
    (action: () => Promise<void>) => () => {
      action().catch((error: unknown) => setControlError(getErrorMessage(error)));
    },
    [],
  );

  /* --- Integração com o Windows -------------------------------------------
     A bandeja, os botões da miniatura e os atalhos globais seguem o estado
     da sala; o que eles pedem chega aqui. */
  useEffect(() => {
    window.myscreen.room.setState({ inRoom: true, micOn: isMicOn, camOn: isCamOn, sharing: isScreenSharing });
  }, [isMicOn, isCamOn, isScreenSharing]);
  useEffect(
    () => () => window.myscreen.room.setState({ inRoom: false, micOn: false, camOn: false, sharing: false }),
    [],
  );

  const actionsRef = useRef({ toggleMic, toggleCam, stopScreenShare, handleLeave, guard });
  actionsRef.current = { toggleMic, toggleCam, stopScreenShare, handleLeave, guard };
  useEffect(() => {
    const offShortcut = window.myscreen.room.onShortcut((action) => {
      const a = actionsRef.current;
      if (action === "mic") a.guard(a.toggleMic)();
      else if (action === "cam") a.guard(a.toggleCam)();
      else if (action === "stop-share") void a.stopScreenShare();
    });
    const offLeave = window.myscreen.room.onLeaveRequest(() => actionsRef.current.handleLeave());
    const offStop = window.myscreen.room.onStopShareRequest(() => void actionsRef.current.stopScreenShare());
    return () => {
      offShortcut();
      offLeave();
      offStop();
    };
  }, []);

  /* --- Composição do palco ----------------------------------------------- */
  const allTiles: TrackReferenceOrPlaceholder[] = [...screenShareRefs, ...cameraTiles];
  const pinnedTiles = pinned
    .map((key) => allTiles.find((t) => tileKey(t) === key))
    .filter((t): t is TrackReferenceOrPlaceholder => t !== undefined);
  const focusTiles = pinnedTiles.length > 0 ? pinnedTiles : screenShareRefs[0] ? [screenShareRefs[0]] : [];
  const focusKeys = focusTiles.map(tileKey);
  const focus = focusTiles[0];
  const strip = focus ? allTiles.filter((t) => !focusKeys.includes(tileKey(t))) : [];

  const togglePin = useCallback((key: string) => {
    setPinned((current) => (current.includes(key) ? current.filter((k) => k !== key) : [key]));
  }, []);

  const focusKeysJoined = focusKeys.join("|");
  const addSideBySide = useCallback(
    (key: string) => {
      const base = focusKeysJoined ? focusKeysJoined.split("|") : [];
      setPinned(base.includes(key) ? base : [...base, key]);
    },
    [focusKeysJoined],
  );

  /* --- Janelas separadas --------------------------------------------------
     `window.open("")` vira uma BrowserWindow com moldura nativa (o processo
     principal acrescenta "Sempre no topo" e "Mover para o monitor" no botão
     direito). O vídeo usa a MESMA trilha já recebida, sem nova assinatura. */
  const popouts = useRef(new Map<string, Popout>());

  const openPopout = useCallback((trackRef: TrackReferenceOrPlaceholder, label: string) => {
    const key = tileKey(trackRef);
    const existing = popouts.current.get(key);
    if (existing && !existing.win.closed) {
      existing.win.focus();
      return;
    }
    const track = trackRef.publication?.track?.mediaStreamTrack;
    if (!track) {
      setControlError("Este quadro ainda não tem vídeo para abrir em outra janela.");
      return;
    }
    const isScreen = trackRef.source === Track.Source.ScreenShare;
    const win = window.open(
      "",
      `myscreen-${key.replace(/[^a-z0-9]/gi, "-")}`,
      isScreen ? "popup,width=1280,height=720" : "popup,width=640,height=360",
    );
    if (!win) {
      setControlError("Não foi possível abrir a nova janela.");
      return;
    }
    const video = mountPopout(win, label, trackRef.participant.isLocal && !isScreen);
    video.srcObject = new MediaStream([track]);
    popouts.current.set(key, { win, video, track });
  }, []);

  useEffect(() => {
    for (const [key, popout] of popouts.current) {
      const tile = allTiles.find((t) => tileKey(t) === key);
      const track = tile?.publication?.track?.mediaStreamTrack;
      if (popout.win.closed || !tile) {
        if (!popout.win.closed) popout.win.close();
        popouts.current.delete(key);
      } else if (track && track !== popout.track) {
        popout.video.srcObject = new MediaStream([track]);
        popout.track = track;
      }
    }
  });

  useEffect(() => {
    const map = popouts.current;
    const closeAll = () => {
      for (const { win } of map.values()) if (!win.closed) win.close();
      map.clear();
    };
    window.addEventListener("pagehide", closeAll);
    return () => {
      window.removeEventListener("pagehide", closeAll);
      closeAll();
    };
  }, []);

  const toggleDock = useCallback(() => {
    setDockHidden((hidden) => {
      writeDockHidden(!hidden);
      return !hidden;
    });
  }, []);

  const participantCount = useParticipants().length;
  const roomLabel = room.name || roomId;

  const reconnecting =
    connectionState === ConnectionState.Reconnecting || connectionState === ConnectionState.SignalReconnecting;

  // Só trilhas com mídia de verdade: câmera desligada não tem o que medir.
  const statsOptions = [...screenShareRefs, ...cameraRefs].filter((t) => t.publication?.track);
  const statsTrack =
    statsOptions.find((t) => tileKey(t) === statsKey) ??
    (focus && isTrackReference(focus) ? focus : undefined) ??
    screenShareRefs[0] ??
    cameraRefs[0];

  const notices = [
    screenShareError ? { key: "screen", text: screenShareError, dismiss: () => setScreenShareError(null) } : null,
    controlError ? { key: "control", text: controlError, dismiss: () => setControlError(null) } : null,
    unstableConnection
      ? {
          key: "net",
          text: "Conexão instável: a qualidade da sua rede caiu.",
          dismiss: () => setUnstableConnection(false),
        }
      : null,
  ].filter((n): n is { key: string; text: string; dismiss: () => void } => n !== null);

  const closeShareDialog = useCallback(() => setIsShareDialogOpen(false), []);

  const updateAudioPrefs = useCallback((patch: Partial<SystemAudioPrefs>) => {
    setAudioPrefs((prev) => {
      const next = { ...prev, ...patch };
      writeSystemAudio(next);
      return next;
    });
    window.myscreen.audio.update({ normalize: patch.normalize, gainPct: patch.gainPct });
  }, []);

  const tileProps = {
    pinnedKeys: pinned,
    canSideBySide: focus !== undefined,
    onSideBySide: addSideBySide,
    onPopout: openPopout,
    fullscreenEl,
    onTogglePin: togglePin,
    onToggleFullscreen: toggleFullscreen,
  };

  return (
    <div ref={shellRef} className="fixed inset-0 z-50 flex flex-col overscroll-none bg-paper text-ink">
      {/* --- Barra superior (área de arrastar da janela) ----------------- */}
      <header className="app-drag titlebar-pad flex h-12 shrink-0 items-center justify-between gap-3 border-b border-rule bg-sheet pl-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-[0.9375rem] font-semibold tracking-[-0.02em]">
            My<span className="text-signal">Screen</span>
          </span>
          <span aria-hidden className="h-4 w-px bg-rule-2" />
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className={cn("size-2 shrink-0 rounded-full", reconnecting ? "animate-pulse bg-warn-dot" : "bg-signal")}
            />
            <span className="truncate font-mono text-[0.8125rem] text-ink-2">{roomLabel}</span>
          </span>
          {reconnecting ? (
            <span className="text-[0.75rem] text-warn">
              {connectionState === ConnectionState.SignalReconnecting
                ? "Reconectando a sinalização..."
                : "Reconectando..."}
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <CopyLinkButton url={platform.inviteUrl(roomId)} />
          <span aria-hidden className="mx-1 h-4 w-px bg-rule-2" />
          <BarToggle
            label="Pessoas"
            open={panel === "people"}
            onClick={() => setPanel((p) => (p === "people" ? null : "people"))}
            badge={participantCount}
          >
            <Users size={17} strokeWidth={1.75} aria-hidden />
          </BarToggle>
          <BarToggle
            label="Chat"
            open={panel === "chat"}
            onClick={() => setPanel((p) => (p === "chat" ? null : "chat"))}
            badge={chatUnread > 0 ? chatUnread : undefined}
            badgeTone="signal"
          >
            <MessageSquare size={17} strokeWidth={1.75} aria-hidden />
          </BarToggle>
          <BarToggle
            label="Estatísticas"
            open={panel === "stats"}
            onClick={() => setPanel((p) => (p === "stats" ? null : "stats"))}
          >
            <Activity size={17} strokeWidth={1.75} aria-hidden />
          </BarToggle>
          <span aria-hidden className="mx-1 h-4 w-px bg-rule-2" />
          <ThemeToggle />
        </div>
      </header>

      {/* --- Avisos ------------------------------------------------------ */}
      {notices.length > 0 || audioBlocked ? (
        <div className="shrink-0 border-b border-rule bg-band">
          {notices.map((n) => (
            <Notice key={n.key} text={n.text} onDismiss={n.dismiss} />
          ))}
          {audioBlocked ? (
            <Notice
              text="A reprodução de áudio foi bloqueada."
              onDismiss={() => setAudioBlocked(false)}
              action={
                <button
                  type="button"
                  onClick={resumeAudioPlayback}
                  className="border border-rule-2 bg-sheet px-2.5 py-1 text-[0.75rem] font-semibold text-ink transition-colors hover:border-rule-3 [border-radius:var(--radius-cell)]"
                >
                  Retomar áudio
                </button>
              }
            />
          ) : null}
        </div>
      ) : null}

      {/* --- Palco + painel --------------------------------------------- */}
      <div className="relative flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
          {focusTiles.length > 1 ? (
            <SplitStage tiles={focusTiles} tileProps={tileProps} onExit={() => setPinned([])} />
          ) : focus ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
              <div className="flex min-h-0 min-w-0 flex-1">
                <Tile trackRef={focus} variant="stage" {...tileProps} />
              </div>
              {strip.length > 0 ? (
                <div className="flex h-[9rem] shrink-0 gap-3 overflow-x-auto lg:h-auto lg:w-[15rem] lg:flex-col lg:overflow-x-visible lg:overflow-y-auto xl:w-[17rem]">
                  {strip.map((t) => (
                    <div key={tileKey(t)} className="aspect-video h-full shrink-0 lg:h-auto lg:w-full">
                      <Tile trackRef={t} variant="strip" {...tileProps} />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : cameraTiles.length > 0 ? (
            <CameraGrid tiles={cameraTiles} tileProps={tileProps} />
          ) : (
            <EmptyStage onShare={() => setIsShareDialogOpen(true)} />
          )}
        </main>

        {panel ? (
          <div className="flex min-h-0 w-[22rem] shrink-0 flex-col border-l border-rule bg-sheet">
            {panel === "chat" ? (
              <ChatSidebar
                isOpen
                onClose={() => setPanel(null)}
                chatMessages={chat.chatMessages}
                send={chat.send}
                isSending={chat.isSending}
                draft={chatDraft}
                onDraftChange={setChatDraft}
              />
            ) : panel === "people" ? (
              <ParticipantsList isOpen onClose={() => setPanel(null)} />
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <StatsPicker
                  options={statsOptions}
                  selected={statsTrack ? tileKey(statsTrack) : null}
                  onSelect={setStatsKey}
                />
                <TrackStatsDropdown
                  key={statsTrack ? tileKey(statsTrack) : "none"}
                  trackRef={statsTrack}
                  open
                  onClose={() => setPanel(null)}
                />
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* --- Doca recolhível -------------------------------------------- */}
      {dockHidden ? (
        <button
          type="button"
          onClick={toggleDock}
          aria-label="Mostrar controles"
          title="Mostrar controles"
          className={cn(DOCK_HANDLE, "bottom-0 z-20")}
        >
          <ChevronUp size={16} strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
      <footer hidden={dockHidden} className="relative shrink-0 border-t border-rule bg-sheet px-3 pt-3 pb-3">
        <button
          type="button"
          onClick={toggleDock}
          aria-label="Esconder controles"
          title="Esconder controles"
          className={cn(DOCK_HANDLE, "-top-6")}
        >
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <MediaControls
          isMicOn={isMicOn}
          isCamOn={isCamOn}
          isScreenSharing={isScreenSharing}
          isFullscreen={fullscreenEl === shellRef.current && fullscreenEl !== null}
          canFullscreen={canFullscreen}
          onToggleMic={guard(toggleMic)}
          onToggleCam={guard(toggleCam)}
          onToggleScreenShare={() => (isScreenSharing ? void stopScreenShare() : setIsShareDialogOpen(true))}
          onToggleFullscreen={() => toggleFullscreen(shellRef.current)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onLeave={handleLeave}
          extra={
            systemAudioActive ? (
              <SystemAudioControl
                prefs={audioPrefs}
                paused={audioPaused}
                onChange={updateAudioPrefs}
                onPausedChange={(p) => {
                  setAudioPaused(p);
                  window.myscreen.audio.update({ paused: p });
                }}
              />
            ) : null
          }
        />
      </footer>

      <SettingsModal
        open={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onApply={applyMediaSettings}
        devices={devices}
      />

      <ShareDialog
        open={isShareDialogOpen}
        initial={capture}
        audioPrefs={audioPrefs}
        capabilities={audioCaps}
        onClose={closeShareDialog}
        onConfirm={(next, source, nextAudio) => {
          setIsShareDialogOpen(false);
          void startScreenShare(next, source, nextAudio);
        }}
      />
    </div>
  );
}

/** Mensagem específica para cada falha de dispositivo no Windows. */
function mediaFailure(error: unknown, what: "microfone" | "câmera"): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotReadableError") return `A ${what === "câmera" ? "câmera" : "placa de som"} está em uso por outro aplicativo.`;
  if (name === "NotAllowedError")
    return `O Windows bloqueou o ${what === "câmera" ? "acesso à câmera" : "microfone"}. Libere em Configurações → Privacidade.`;
  if (name === "NotFoundError") return `Nenhum${what === "câmera" ? "a câmera" : " microfone"} encontrado.`;
  return `Não foi possível usar ${what === "câmera" ? "a câmera" : "o microfone"} selecionado.`;
}

type Panel = "chat" | "people" | "stats";

type Popout = { win: Window; video: HTMLVideoElement; track: MediaStreamTrack };

/**
 * Monta a página da janela separada: só o vídeo, em fundo preto. Duplo clique
 * alterna a tela cheia, e o cursor some depois de um tempo parado.
 */
function mountPopout(win: Window, title: string, mirror: boolean): HTMLVideoElement {
  const doc = win.document;
  doc.title = `${title} · MyScreen`;
  doc.body.replaceChildren();
  doc.body.style.cssText = "margin:0;background:#000;overflow:hidden;height:100vh";

  const video = doc.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = `display:block;width:100vw;height:100vh;object-fit:contain${
    mirror ? ";transform:scaleX(-1)" : ""
  }`;
  doc.body.append(video);

  video.addEventListener("dblclick", () => {
    if (doc.fullscreenElement) void doc.exitFullscreen();
    else void doc.documentElement.requestFullscreen().catch(() => {});
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    doc.body.style.cursor = "";
    clearTimeout(timer);
    timer = setTimeout(() => {
      doc.body.style.cursor = "none";
    }, FULLSCREEN_IDLE_MS);
  };
  doc.addEventListener("pointermove", wake);
  wake();

  return video;
}

const DOCK_HANDLE =
  "absolute left-3 flex h-6 w-16 items-center justify-center border border-b-0 border-rule-2 bg-sheet/85 text-ink-2 backdrop-blur-md transition-colors hover:bg-band hover:text-ink [border-radius:var(--radius-cell)_var(--radius-cell)_0_0]";

const DOCK_HIDDEN_KEY = "myscreen:dock-hidden";

function readDockHidden(): boolean {
  try {
    return localStorage.getItem(DOCK_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDockHidden(hidden: boolean) {
  try {
    localStorage.setItem(DOCK_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // Sem storage, a escolha vale só para esta sessão.
  }
}

function tileKey(t: TrackReferenceOrPlaceholder): string {
  return `${t.participant.identity}:${t.source}`;
}

/** O nome que o quadro mostra: "Sua tela", "Tela de Ana", "Ana (você)". */
function trackLabel(t: TrackReferenceOrPlaceholder): string {
  const { participant } = t;
  const name = participant.name || participant.identity || (participant.isLocal ? "Você" : "Participante");
  if (t.source === Track.Source.ScreenShare) return participant.isLocal ? "Sua tela" : `Tela de ${name}`;
  return participant.isLocal && name !== "Você" ? `${name} (você)` : name;
}

/**
 * Escolhe de qual trilha o painel mostra as estatísticas: cada câmera e cada
 * tela da sala é um botão.
 */
function StatsPicker({
  options,
  selected,
  onSelect,
}: {
  options: TrackReferenceOrPlaceholder[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  if (options.length === 0) {
    return <p className="mb-3 text-[0.8125rem] text-ink-3">Nenhuma câmera ou tela no ar para medir.</p>;
  }
  return (
    <div role="radiogroup" aria-label="Trilha medida" className="mb-3 flex flex-wrap gap-1.5">
      {options.map((t) => {
        const key = tileKey(t);
        const active = key === selected;
        const Icon = t.source === Track.Source.ScreenShare ? MonitorUp : Video;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(key)}
            className={cn(
              "flex h-8 max-w-full min-w-0 items-center gap-1.5 border px-2.5 text-[0.75rem] font-medium transition-colors [border-radius:var(--radius-cell)]",
              active
                ? "border-signal-line bg-signal-wash text-signal"
                : "border-rule text-ink-2 hover:border-rule-3 hover:bg-band hover:text-ink",
            )}
          >
            <Icon size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span className="truncate">
              {trackLabel(t)}
              <span className="sr-only">{t.source === Track.Source.ScreenShare ? " (tela)" : " (câmera)"}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

type TileShared = {
  pinnedKeys: string[];
  canSideBySide: boolean;
  onSideBySide: (key: string) => void;
  onPopout: (trackRef: TrackReferenceOrPlaceholder, label: string) => void;
  fullscreenEl: Element | null;
  onTogglePin: (key: string) => void;
  onToggleFullscreen: (element: Element | null) => void;
};

/* ---------------------------------------------------------------------------
   Grade de câmeras

   Mede o palco e escolhe o número de colunas que dá o MAIOR quadro 16:9
   possível. Um, dois ou nove participantes: o palco é sempre preenchido, e
   redimensionar a janela recalcula na hora.
   ------------------------------------------------------------------------ */
const GRID_GAP = 12;
const ASPECT = 16 / 9;

/* ---------------------------------------------------------------------------
   Palco dividido

   Os quadros fixados lado a lado repartem o palco inteiro em células iguais.
   Diferente da grade de câmeras, a célula não é um 16:9 encolhido: ela ocupa
   toda a fatia, e o vídeo (contain) cresce até onde o formato dele deixa. O
   número de colunas é o que dá a maior imagem 16:9 visível em cada célula, então
   num monitor largo duas telas ficam lado a lado, e num estreito, empilhadas.
   ------------------------------------------------------------------------ */
function SplitStage({
  tiles,
  tileProps,
  onExit,
}: {
  tiles: TrackReferenceOrPlaceholder[];
  tileProps: TileShared;
  onExit: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = tiles.length;
  let bestCols = 1;
  let bestW = -1;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = (box.w - GRID_GAP * (cols - 1)) / cols;
    const cellH = (box.h - GRID_GAP * (rows - 1)) / rows;
    const visible = Math.min(cellW, cellH * ASPECT);
    if (visible > bestW) {
      bestW = visible;
      bestCols = cols;
    }
  }
  const rows = Math.ceil(n / bestCols);

  return (
    <div className="group/split relative flex min-h-0 flex-1">
      <div
        ref={ref}
        className="grid min-h-0 min-w-0 flex-1"
        style={{
          gap: GRID_GAP,
          gridTemplateColumns: `repeat(${bestCols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
        {tiles.map((t) => (
          <div key={tileKey(t)} className="flex min-h-0 min-w-0">
            <Tile trackRef={t} variant="stage" {...tileProps} />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onExit}
        className="absolute top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-md bg-black/55 px-2.5 py-1.5 text-[0.75rem] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity duration-150 group-hover/split:opacity-100 hover:bg-black/75 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <X size={13} strokeWidth={2} aria-hidden />
        Desfazer divisão
      </button>
    </div>
  );
}

function CameraGrid({
  tiles,
  tileProps,
}: {
  tiles: TrackReferenceOrPlaceholder[];
  tileProps: TileShared;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = tiles.length;
  let best = { w: 0, h: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const maxW = (box.w - GRID_GAP * (cols - 1)) / cols;
    const maxH = (box.h - GRID_GAP * (rows - 1)) / rows;
    const w = Math.max(0, Math.min(maxW, maxH * ASPECT));
    if (w > best.w) best = { w, h: w / ASPECT };
  }

  return (
    <div
      ref={ref}
      className="flex min-h-0 flex-1 flex-wrap content-center items-center justify-center"
      style={{ gap: GRID_GAP }}
    >
      {box.w > 0
        ? tiles.map((t) => (
            <div
              key={tileKey(t)}
              className="transition-[width,height] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{ width: Math.floor(best.w), height: Math.floor(best.h) }}
            >
              <Tile trackRef={t} variant="grid" {...tileProps} />
            </div>
          ))
        : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Quadro

   O vídeo fica sobre o fundo do monitor, escuro nos dois temas: é contra preto
   que se avalia imagem. Tela compartilhada nunca é cortada (contain); câmera
   preenche o quadro na grade e na faixa, e aparece inteira no destaque.
   ------------------------------------------------------------------------ */
function Tile({
  trackRef,
  variant,
  pinnedKeys,
  canSideBySide,
  onSideBySide,
  onPopout,
  fullscreenEl,
  onTogglePin,
  onToggleFullscreen,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  variant: "stage" | "grid" | "strip";
} & TileShared) {
  const ref = useRef<HTMLDivElement>(null);
  const participant = trackRef.participant;
  const key = tileKey(trackRef);
  const isScreen = trackRef.source === Track.Source.ScreenShare;
  const isPinned = pinnedKeys.includes(key);
  const isFullscreen = fullscreenEl !== null && fullscreenEl === ref.current;

  const speaking = useIsSpeaking(participant);
  const micMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
    publication: participant.getTrackPublication(Track.Source.Microphone),
  });
  const videoMuted = useIsMuted(trackRef);
  const hasVideo = isTrackReference(trackRef) && !videoMuted;

  const name = participant.name || participant.identity || (participant.isLocal ? "Você" : "Participante");
  const label = trackLabel(trackRef);
  const small = variant === "strip";

  // Em tela cheia, nome e ações só aparecem quando o mouse mexe, e somem (com
  // o cursor) depois de um tempo parado: o quadro é para ser assistido.
  const [chromeAwake, setChromeAwake] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!isFullscreen || !el) {
      setChromeAwake(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setChromeAwake(true);
      clearTimeout(timer);
      timer = setTimeout(() => setChromeAwake(false), FULLSCREEN_IDLE_MS);
    };
    wake();
    el.addEventListener("pointermove", wake);
    el.addEventListener("pointerdown", wake);
    el.addEventListener("keydown", wake);
    return () => {
      clearTimeout(timer);
      el.removeEventListener("pointermove", wake);
      el.removeEventListener("pointerdown", wake);
      el.removeEventListener("keydown", wake);
    };
  }, [isFullscreen]);
  const chromeHidden = isFullscreen && !chromeAwake;

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [canPip, setCanPip] = useState(false);
  useEffect(() => {
    setCanPip(Boolean(document.pictureInPictureEnabled));
  }, []);

  const openPip = () => {
    const video = ref.current?.querySelector("video");
    if (!video) return;
    void video.requestPictureInPicture().catch((error: unknown) => {
      console.error("Janela flutuante recusada:", error);
    });
  };

  return (
    <div
      ref={ref}
      onDoubleClick={() => onToggleFullscreen(ref.current)}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      className={cn(
        "group relative flex h-full w-full items-center justify-center overflow-hidden bg-monitor ring-1 ring-rule [border-radius:var(--radius-sheet)]",
        "outline outline-2 -outline-offset-2 transition-[outline-color] duration-200",
        speaking && !isScreen ? "outline-signal" : "outline-transparent",
        isFullscreen && "[border-radius:0]",
        chromeHidden && "cursor-none",
      )}
    >
      {hasVideo ? (
        <VideoTrack
          trackRef={trackRef}
          className={cn(
            "h-full w-full",
            isScreen || variant === "stage" || isFullscreen ? "object-contain" : "object-cover",
            participant.isLocal && !isScreen && "-scale-x-100",
          )}
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            "flex items-center justify-center rounded-full bg-white/10 font-semibold text-white/85",
            small ? "size-10 text-[0.875rem]" : "size-16 text-[1.375rem] sm:size-20 sm:text-[1.75rem]",
          )}
        >
          {initials(name)}
        </span>
      )}

      {/* Identificação: sempre legível sobre qualquer imagem. */}
      <div
        className={cn(
          "pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 text-[0.75rem] font-medium text-white backdrop-blur-sm transition-opacity duration-300",
          chromeHidden && "opacity-0",
        )}
      >
        {isScreen ? (
          <MonitorUp size={12} strokeWidth={2} aria-hidden className="shrink-0" />
        ) : micMuted ? (
          <MicOff size={12} strokeWidth={2} aria-hidden className="shrink-0 text-[#ff9b8a]" />
        ) : null}
        <span className="truncate">{label}</span>
        {!isScreen && micMuted ? <span className="sr-only">, microfone mudo</span> : null}
      </div>

      {/* Ações do quadro: aparecem no hover e no foco; no toque, sempre. Em
          tela cheia, só enquanto o mouse se mexe. */}
      <div
        className={cn(
          "absolute top-2 right-2 flex gap-1 transition-opacity duration-150",
          isFullscreen
            ? chromeHidden
              ? "pointer-events-none opacity-0 duration-300"
              : "opacity-100"
            : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
        )}
      >
        {isScreen && !participant.isLocal ? (
          <ScreenVolume participant={participant as RemoteParticipant} />
        ) : null}
        {variant === "strip" && canSideBySide ? (
          <TileAction
            label={`Pôr ${label} lado a lado no destaque`}
            onClick={() => onSideBySide(key)}
          >
            <Columns2 size={14} strokeWidth={1.75} aria-hidden />
          </TileAction>
        ) : null}
        <TileAction
          label={isPinned ? `Soltar ${label}` : `Fixar ${label} em destaque`}
          onClick={() => onTogglePin(key)}
        >
          {isPinned ? (
            <PinOff size={14} strokeWidth={1.75} aria-hidden />
          ) : (
            <Pin size={14} strokeWidth={1.75} aria-hidden />
          )}
        </TileAction>
        <TileAction
          label={isFullscreen ? "Sair da tela cheia" : `Tela cheia: ${label}`}
          onClick={() => onToggleFullscreen(ref.current)}
        >
          <Maximize2 size={14} strokeWidth={1.75} aria-hidden />
        </TileAction>
      </div>

      {menu ? (
        <TileMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Abrir em nova janela",
              icon: <ExternalLink size={14} strokeWidth={1.75} aria-hidden />,
              disabled: !hasVideo,
              onSelect: () => onPopout(trackRef, label),
            },
            canPip
              ? {
                  label: "Janela flutuante",
                  icon: <PictureInPicture2 size={14} strokeWidth={1.75} aria-hidden />,
                  disabled: !hasVideo,
                  onSelect: openPip,
                }
              : null,
            variant === "strip" && canSideBySide
              ? {
                  label: "Pôr lado a lado no destaque",
                  icon: <Columns2 size={14} strokeWidth={1.75} aria-hidden />,
                  onSelect: () => onSideBySide(key),
                }
              : null,
            {
              label: isPinned ? "Soltar do destaque" : "Fixar em destaque",
              icon: isPinned ? (
                <PinOff size={14} strokeWidth={1.75} aria-hidden />
              ) : (
                <Pin size={14} strokeWidth={1.75} aria-hidden />
              ),
              onSelect: () => onTogglePin(key),
            },
            {
              label: isFullscreen ? "Sair da tela cheia" : "Tela cheia",
              icon: <Maximize2 size={14} strokeWidth={1.75} aria-hidden />,
              onSelect: () => onToggleFullscreen(ref.current),
            },
          ]}
        />
      ) : null}
    </div>
  );
}

const SCREEN_VOLUME_KEY = "myscreen:screen-volume";

function readScreenVolume(): number {
  try {
    const raw = localStorage.getItem(SCREEN_VOLUME_KEY);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
  } catch {
    return 1;
  }
}

/**
 * Volume do som da tela compartilhada, só para quem assiste. Não mexe na voz
 * de ninguém: só na faixa de áudio da tela. A escolha vale para as próximas
 * telas também (fica no navegador).
 */
function ScreenVolume({ participant }: { participant: RemoteParticipant }) {
  const [volume, setVolume] = useState(readScreenVolume);
  const lastAudible = useRef(volume > 0 ? volume : 1);

  useEffect(() => {
    participant.setVolume(volume, Track.Source.ScreenShareAudio);
  }, [participant, volume]);

  const apply = (v: number) => {
    setVolume(v);
    if (v > 0) lastAudible.current = v;
    try {
      localStorage.setItem(SCREEN_VOLUME_KEY, String(v));
    } catch {
      // Sem storage, o volume vale só para esta sessão.
    }
  };

  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const percent = Math.round(volume * 100);

  return (
    <div
      className="flex items-center rounded-md bg-black/55 text-white backdrop-blur-sm"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label={volume === 0 ? "Ativar som da tela" : "Silenciar som da tela"}
        title={volume === 0 ? "Ativar som da tela" : "Silenciar som da tela"}
        onClick={() => apply(volume === 0 ? lastAudible.current : 0)}
        className="flex size-8 items-center justify-center rounded-md transition-colors hover:bg-black/40"
      >
        <Icon size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        onChange={(event) => apply(Number(event.target.value) / 100)}
        aria-label="Volume do som da tela"
        aria-valuetext={`${percent}%`}
        title={`Som da tela: ${percent}%`}
        className="mr-2.5 h-1 w-20 cursor-pointer accent-white"
      />
    </div>
  );
}

const FULLSCREEN_IDLE_MS = 2500;

type TileMenuItem = {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onSelect: () => void;
};

/**
 * Menu do botão direito num quadro. Fica dentro do próprio quadro (com
 * `position: fixed`) para continuar visível quando o quadro está em tela cheia.
 */
function TileMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: (TileMenuItem | null)[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Encosta o menu para dentro da janela quando o clique foi perto da borda.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="fixed z-[70] min-w-[13rem] border border-rule-2 bg-sheet py-1 text-ink shadow-overlay [border-radius:var(--radius-sheet)]"
      style={pos}
    >
      {items
        .filter((item): item is TileMenuItem => item !== null)
        .map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
              item.onSelect();
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[0.8125rem] transition-colors hover:bg-band focus:bg-band focus:outline-none disabled:pointer-events-none disabled:opacity-40"
          >
            <span className="shrink-0 text-ink-2">{item.icon}</span>
            {item.label}
          </button>
        ))}
    </div>
  );
}

function TileAction({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className="flex size-8 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75"
    >
      {children}
    </button>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function EmptyStage({ onShare }: { onShare: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 border border-dashed border-rule-2 px-6 text-center [border-radius:var(--radius-sheet)]">
      <div>
        <p className="text-[1.0625rem] font-semibold tracking-[-0.01em] text-ink">
          Ninguém está transmitindo ainda
        </p>
        <p className="mt-1.5 max-w-[40ch] text-[0.875rem] leading-[1.55] text-ink-2">
          Compartilhe a tela inteira ou uma janela. O som do PC vai junto, sem a voz da
          chamada — ou só o som da janela escolhida.
        </p>
      </div>
      <button
        type="button"
        onClick={onShare}
        className="inline-flex items-center gap-2 border border-signal bg-signal px-5 py-2.5 text-[0.875rem] font-semibold text-on-signal transition-colors hover:border-signal-2 hover:bg-signal-2 [border-radius:var(--radius-sheet)]"
      >
        <MonitorUp size={17} strokeWidth={1.75} aria-hidden />
        Compartilhar tela
      </button>
    </div>
  );
}

function BarToggle({
  children,
  label,
  open,
  onClick,
  badge,
  badgeTone = "plain",
}: {
  children: React.ReactNode;
  label: string;
  open: boolean;
  onClick: () => void;
  badge?: number;
  badgeTone?: "plain" | "signal";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={open}
      aria-label={badge !== undefined ? `${label} (${badge})` : label}
      title={label}
      className={cn(
        "flex h-9 items-center gap-1.5 border px-2.5 text-[0.8125rem] transition-colors [border-radius:var(--radius-cell)]",
        open
          ? "border-signal-line bg-signal-wash text-signal"
          : "border-transparent text-ink-2 hover:border-rule hover:bg-band hover:text-ink",
      )}
    >
      {children}
      {badge !== undefined ? (
        <span
          className={cn(
            "font-mono text-[0.75rem] [font-variant-numeric:tabular-nums]",
            badgeTone === "signal" &&
              "min-w-4 rounded-full bg-signal px-1 text-center text-[0.6875rem] font-semibold text-on-signal",
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

type CopyState = "idle" | "copied" | "error";

function CopyLinkButton({ url }: { url: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("área de transferência indisponível");
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState("error");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        title="Copiar link de convite"
        className={cn(
          "flex h-9 items-center gap-1.5 border px-2.5 text-[0.8125rem] font-medium transition-colors [border-radius:var(--radius-cell)]",
          state === "copied"
            ? "border-signal-line bg-signal-wash text-signal"
            : state === "error"
              ? "border-alert-line bg-alert-wash text-alert"
              : "border-rule-2 bg-sheet text-ink hover:border-rule-3 hover:bg-band",
        )}
      >
        {state === "copied" ? (
          <Check size={16} strokeWidth={2} aria-hidden />
        ) : (
          <Link2 size={16} strokeWidth={1.75} aria-hidden />
        )}
        <span className="hidden sm:inline">
          {state === "copied" ? "Copiado" : state === "error" ? "Falhou" : "Convidar"}
        </span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied"
          ? "Link de convite copiado."
          : state === "error"
            ? `Não foi possível copiar. O link é ${url}`
            : ""}
      </span>
    </>
  );
}

function Notice({
  text,
  action,
  onDismiss,
}: {
  text: string;
  action?: React.ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-rule px-4 py-2 last:border-b-0 sm:px-5"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn-dot" />
      <p className="min-w-0 flex-1 text-[0.8125rem] text-ink-2">{text}</p>
      {action}
      <button
        type="button"
        aria-label="Dispensar aviso"
        onClick={onDismiss}
        className="shrink-0 p-1 text-ink-3 transition-colors hover:text-ink"
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
