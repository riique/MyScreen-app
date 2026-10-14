
import { ArrowRight, Mic, MicOff, Video, VideoOff, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Field, Sheet, SheetHead, Stamp, inputClass } from "@/components/sheet";

/** O VU empurra estado para o React a 10 Hz; 60 Hz de re-render é caro e invisível. */
const METER_THROTTLE_MS = 100;
/** Abaixo disso o ruído de fundo da sala já passa. */
const MIC_LIVE_THRESHOLD = 5;

export interface GreenRoomJoinConfig {
  nickname: string;
  password?: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
}

interface GreenRoomProps {
  roomId: string;
  roomTitle: string;
  isLocked: boolean;
  initialNickname?: string;
  /**
   * Precisa resolver `true` para travar o lobby. Só o valor estritamente `true`
   * conta: qualquer outro resolutions deixa a pessoa dentro da sala sem token e
   * com um botão travado.
   */
  onJoin: (config: GreenRoomJoinConfig) => Promise<boolean | void>;
}

export function GreenRoom({
  roomId,
  roomTitle,
  isLocked,
  initialNickname = "",
  onJoin,
}: GreenRoomProps) {
  const [nickname, setNickname] = useState(initialNickname);
  const [password, setPassword] = useState("");
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [joining, setJoining] = useState(false);

  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState("");
  const [selectedVideoId, setSelectedVideoId] = useState("");

  const [audioLevel, setAudioLevel] = useState(0);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [hasPermissionError, setHasPermissionError] = useState(false);
  const [permissionErrorMessage, setPermissionErrorMessage] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<"busy" | "privacy" | "other" | null>(null);

  // A régua chega da home já posicionada: mexer aqui é mexer na mesma fila.

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  // Espelhos síncronos do mute: desligar o microfone NÃO pode reabrir a câmera
  // por efeito colateral, e refazer o getUserMedia para isso seria o caminho
  // mais curto para assustar quem está entrando na reunião.
  const audioEnabledRef = useRef(audioEnabled);
  const videoEnabledRef = useRef(videoEnabled);
  const mountedRef = useRef(true);
  const meterTrackRef = useRef<HTMLDivElement>(null);
  const meterBarRef = useRef<HTMLDivElement>(null);
  const micIconRef = useRef<SVGSVGElement | null>(null);
  const lastMeterPushRef = useRef(0);

  // Sem permissão de mídia não existe track viva. Mostrar as teclas acesas aqui
  // seria a interface afirmar "Captando" com nada atrás — e a honestidade do
  // estado é a promessa central deste produto, não um detalhe de ícone.
  const micLive = audioEnabled && !hasPermissionError;
  const camLive = videoEnabled && !hasPermissionError;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function teardownAudioGraph() {
    analyserSourceRef.current?.disconnect();
    analyserSourceRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }

  async function resumeAudioContext(ctx: AudioContext): Promise<boolean> {
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // Sem gesto do usuário o Chrome mantém o contexto suspenso; a régua
        // abaixo avisa e oferece o clique em vez de fingir que está medindo.
      }
    }
    return ctx.state === "running";
  }

  /**
   * A pré-visualização é refazida só quando o DEVICE muda. Um mute novo não
   * entra nesta dependência de propósito: é um `track.enabled = false` na track
   * viva, sem reabrir nada.
   */
  useEffect(() => {
    let active = true;

    async function setupPreview() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: selectedVideoId ? { deviceId: { exact: selectedVideoId } } : true,
          audio: selectedAudioId ? { deviceId: { exact: selectedAudioId } } : true,
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;

        for (const track of stream.getAudioTracks()) track.enabled = audioEnabledRef.current;
        for (const track of stream.getVideoTracks()) track.enabled = videoEnabledRef.current;

        if (videoRef.current) videoRef.current.srcObject = stream;

        setHasPermissionError(false);
        setPermissionErrorMessage(null);
        setPermissionError(null);

        const list = await navigator.mediaDevices.enumerateDevices();
        if (!active) return;
        const aDevs = list.filter((d) => d.kind === "audioinput");
        const vDevs = list.filter((d) => d.kind === "videoinput");
        setAudioDevices(aDevs);
        setVideoDevices(vDevs);
        if (!selectedAudioId && aDevs.length > 0) setSelectedAudioId(aDevs[0].deviceId);
        if (!selectedVideoId && vDevs.length > 0) setSelectedVideoId(vDevs[0].deviceId);

        const AudioCtor =
          window.AudioContext ??
          (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtor) throw new Error("Web Audio API indisponível neste navegador.");

        const audioCtx = new AudioCtor();
        audioContextRef.current = audioCtx;
        setAudioBlocked(audioCtx.state !== "running");
        void resumeAudioContext(audioCtx).then((running) => {
          if (active && mountedRef.current) setAudioBlocked(!running);
        });

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;

        const micTrack = stream.getAudioTracks()[0];
        if (!micTrack) return;
        const source = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
        source.connect(analyser);
        analyserSourceRef.current = source;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const checkVolume = (timestamp: number) => {
          if (!active) return;
          analyser.getByteFrequencyData(dataArray);

          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const level = Math.min(100, sum / dataArray.length);
          const isCapturing = level > MIC_LIVE_THRESHOLD;

          // 60 Hz no DOM: a barra é o instrumento, não o estado do React.
          if (meterBarRef.current) meterBarRef.current.style.width = `${level}%`;
          micIconRef.current?.classList.toggle("text-signal", isCapturing);
          micIconRef.current?.classList.toggle("text-ink-3", !isCapturing);

          if (timestamp - lastMeterPushRef.current >= METER_THROTTLE_MS) {
            lastMeterPushRef.current = timestamp;
            const rounded = Math.round(level);
            meterTrackRef.current?.setAttribute("aria-valuenow", String(rounded));
            setAudioLevel(rounded);
          }

          animFrameRef.current = requestAnimationFrame(checkVolume);
        };
        animFrameRef.current = requestAnimationFrame(checkVolume);
      } catch (error) {
        if (!active) return;
        console.warn("Permissão de mídia negada ou dispositivo indisponível:", error);
        setHasPermissionError(true);
        if (error instanceof DOMException && error.name === "NotReadableError") {
          setPermissionError("busy");
          setPermissionErrorMessage(
            "A câmera ou o microfone está em uso por outro aplicativo (Teams, OBS, Discord). Feche-o ou entre na sala com a câmera desligada.",
          );
        } else if (error instanceof DOMException && error.name === "NotAllowedError") {
          // O app já concede a permissão: quem bloqueia aqui é o Windows.
          setPermissionError("privacy");
          setPermissionErrorMessage(
            "O Windows está bloqueando a câmera ou o microfone. Em Configurações → Privacidade, libere “Permitir que aplicativos da área de trabalho acessem” a câmera e o microfone.",
          );
        } else if (error instanceof DOMException && error.name === "NotFoundError") {
          setPermissionError("other");
          setPermissionErrorMessage("Nenhuma câmera ou microfone foi encontrado neste computador.");
        } else {
          setPermissionError("other");
          setPermissionErrorMessage("Não foi possível acessar a câmera ou o microfone no momento.");
        }
      }
    }

    // O Chrome só deixa o AudioContext rodar depois de um gesto real.
    const handleFirstGesture = () => {
      window.removeEventListener("pointerdown", handleFirstGesture);
      window.removeEventListener("keydown", handleFirstGesture);
      gestureCleanupRef.current = null;
      if (audioContextRef.current) {
        void resumeAudioContext(audioContextRef.current).then((running) => {
          if (active && mountedRef.current) setAudioBlocked(!running);
        });
      }
    };
    window.addEventListener("pointerdown", handleFirstGesture, { once: true });
    window.addEventListener("keydown", handleFirstGesture, { once: true });
    gestureCleanupRef.current = () => {
      window.removeEventListener("pointerdown", handleFirstGesture);
      window.removeEventListener("keydown", handleFirstGesture);
    };

    void setupPreview();

    return () => {
      active = false;
      if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
      gestureCleanupRef.current?.();
      gestureCleanupRef.current = null;
      teardownAudioGraph();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [selectedAudioId, selectedVideoId]);

  function toggleAudio() {
    const next = !audioEnabled;
    audioEnabledRef.current = next;
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = next;
    });
    setAudioEnabled(next);
  }

  function toggleVideo() {
    const next = !videoEnabled;
    videoEnabledRef.current = next;
    streamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = next;
    });
    setVideoEnabled(next);
  }

  async function handleJoinClick(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (joining || !nickname.trim()) return;
    setJoining(true);

    const entered =
      (await onJoin({
        nickname: nickname.trim(),
        password: password.trim() || undefined,
        // Sem permissão de mídia não há track viva: pedir enabled=true aqui
        // descreveria um microfone que não existe.
        audioEnabled: hasPermissionError ? false : audioEnabled,
        videoEnabled: hasPermissionError ? false : videoEnabled,
        audioDeviceId: selectedDeviceId(selectedAudioId, audioDevices),
        videoDeviceId: selectedDeviceId(selectedVideoId, videoDevices),
      })) === true;

    if (!entered) setJoining(false);
  }

  return (
    <Sheet>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_23rem]">
        {/* O monitor de pré-visualização. Escuro como o da sala: é contra um
            fundo neutro que se avalia o que a câmera está vendo. */}
        <div className="border-b border-rule p-4 sm:p-5 lg:border-b-0 lg:border-r">
          <div className="relative aspect-video overflow-hidden border border-rule-2 bg-monitor">
            <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
            {!camLive ? (
              <div className="absolute inset-0 flex items-center justify-center px-4">
                <span className="text-center font-mono text-[0.75rem] uppercase tracking-[0.12em] text-monitor-ink">
                  {hasPermissionError ? "Sem permissão de câmera" : "Câmera desligada"}
                </span>
              </div>
            ) : null}
          </div>

          {/* O VU. A régua é o instrumento: a barra anda a 60 Hz, o valor
              acessível a 10 Hz, e o estado também é escrito por extenso. */}
          <div className="mt-4">
            <div className="flex items-baseline justify-between">
              <span className="label-col">
                Nível do microfone
              </span>
              <span className="font-mono text-[0.75rem] text-ink-3">
                {!micLive ? "Indisponível" : audioLevel > MIC_LIVE_THRESHOLD ? "Captando áudio" : "Silêncio"}
              </span>
            </div>
            <div
              ref={meterTrackRef}
              role="meter"
              aria-label="Nível do microfone"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={audioLevel}
              aria-valuetext={
                !micLive
                  ? "Indisponível"
                  : audioLevel > MIC_LIVE_THRESHOLD
                    ? "Captando áudio"
                    : "Silêncio"
              }
              className="mt-2 h-2 w-full border border-rule bg-band"
            >
              <div ref={meterBarRef} className="h-full bg-signal" style={{ width: "0%" }} />
            </div>
            {audioBlocked ? (
              <p className="mt-2 flex items-start gap-1.5 text-[0.75rem] leading-[1.5] text-ink-3">
                <Volume2 size={13} strokeWidth={1.5} aria-hidden className="mt-px shrink-0" />
                Clique ou pressione uma tecla para ativar a medição de áudio.
              </p>
            ) : null}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <ToggleCell
              on={micLive}
              onClick={toggleAudio}
              disabled={joining || hasPermissionError}
              icon={
                micLive ? (
                  <Mic ref={micIconRef} size={15} strokeWidth={1.5} className="text-ink-3" aria-hidden />
                ) : (
                  <MicOff size={15} strokeWidth={1.5} aria-hidden />
                )
              }
              label={micLive ? "Captando" : hasPermissionError ? "Sem acesso" : "Mudo"}
              pressedLabel="Silenciar microfone"
              unpressedLabel="Ativar microfone"
            />
            <ToggleCell
              on={camLive}
              onClick={toggleVideo}
              disabled={joining || hasPermissionError}
              icon={
                camLive ? (
                  <Video size={15} strokeWidth={1.5} aria-hidden />
                ) : (
                  <VideoOff size={15} strokeWidth={1.5} aria-hidden />
                )
              }
              label={camLive ? "Câmera" : hasPermissionError ? "Sem acesso" : "Desligada"}
              pressedLabel="Desligar câmera"
              unpressedLabel="Ligar câmera"
            />
          </div>
        </div>

        {/* Identidade e acesso. */}
        <form onSubmit={handleJoinClick} aria-busy={joining} className="p-4 sm:p-5">
          <SheetHead
            title="Lobby pré-reunião"
            id={roomId}
            action={
              <Stamp state={isLocked ? "travado" : "pendente"}>
                {isLocked ? "Com senha" : "Aberta"}
              </Stamp>
            }
          />
          <p className="mt-2 text-[0.8125rem] leading-[1.5] text-ink-2">{roomTitle}</p>

          {permissionErrorMessage ? (
            <p
              role="alert"
              className="mt-4 border border-alert-line bg-alert-wash px-3 py-2.5 text-[0.8125rem] leading-[1.5] text-alert"
            >
              {permissionErrorMessage}
              {permissionError === "privacy" ? (
                <span className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => window.myscreen.app.openPrivacySettings("webcam")}
                    className="border border-alert-line bg-sheet px-2.5 py-1 text-[0.75rem] font-semibold text-alert transition-colors hover:bg-alert-wash-2 [border-radius:var(--radius-cell)]"
                  >
                    Abrir privacidade da câmera
                  </button>
                  <button
                    type="button"
                    onClick={() => window.myscreen.app.openPrivacySettings("microphone")}
                    className="border border-alert-line bg-sheet px-2.5 py-1 text-[0.75rem] font-semibold text-alert transition-colors hover:bg-alert-wash-2 [border-radius:var(--radius-cell)]"
                  >
                    Abrir privacidade do microfone
                  </button>
                </span>
              ) : null}
            </p>
          ) : null}

          <div className="mt-5 space-y-4">
            <Field label="Seu nome ou apelido" htmlFor="greenroom-nickname">
              <input
                id="greenroom-nickname"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="Ex: Henrique"
                autoComplete="nickname"
                maxLength={64}
                required
                disabled={joining}
                className={inputClass}
              />
            </Field>

            {isLocked ? (
              <Field label="Senha da reunião" htmlFor="greenroom-password">
                <input
                  id="greenroom-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Digite a senha da sala"
                  autoComplete="current-password"
                  required
                  disabled={joining}
                  className={inputClass}
                />
              </Field>
            ) : null}

            <Field label="Microfone" htmlFor="greenroom-audio-device">
              <select
                id="greenroom-audio-device"
                value={selectedAudioId}
                onChange={(e) => setSelectedAudioId(e.target.value)}
                disabled={joining || audioDevices.length === 0}
                className={inputClass}
              >
                {audioDevices.length === 0 ? (
                  <option value="">Nenhum dispositivo listado</option>
                ) : null}
                {audioDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Microfone ${d.deviceId.slice(0, 4)}`}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Câmera" htmlFor="greenroom-video-device">
              <select
                id="greenroom-video-device"
                value={selectedVideoId}
                onChange={(e) => setSelectedVideoId(e.target.value)}
                disabled={joining || videoDevices.length === 0}
                className={inputClass}
              >
                {videoDevices.length === 0 ? (
                  <option value="">Nenhum dispositivo listado</option>
                ) : null}
                {videoDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Câmera ${d.deviceId.slice(0, 4)}`}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <button
            type="submit"
            disabled={!nickname.trim() || joining}
            className="mt-6 flex w-full items-center justify-center gap-2 border border-signal bg-signal px-4 py-2.5 text-[0.875rem] font-semibold text-on-signal transition-colors hover:bg-signal-2 disabled:pointer-events-none disabled:opacity-40 [border-radius:var(--radius-sheet)]"
          >
            {joining ? "Conectando..." : "Entrar na reunião"}
            <ArrowRight size={15} strokeWidth={1.5} aria-hidden />
          </button>

          <p className="mt-3 text-[0.75rem] leading-[1.5] text-ink-3">
            Ao entrar, você poderá compartilhar sua tela com áudio e sua câmera
            simultaneamente.
          </p>
        </form>
      </div>

    </Sheet>
  );
}

/**
 * `enumerateDevices` só devolve `deviceId` de verdade depois que a permissão foi
 * concedida. Sem permissão, a string é vazia e mandá-la como `deviceId` para o
 * `getUserMedia` do SFU rejeitaria o join — melhor não mandar id nenhum.
 */
function selectedDeviceId(id: string, devices: MediaDeviceInfo[]): string | undefined {
  if (!id) return undefined;
  return devices.some((d) => d.deviceId === id) ? id : undefined;
}

function ToggleCell({
  on,
  onClick,
  icon,
  label,
  pressedLabel,
  unpressedLabel,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  pressedLabel: string;
  unpressedLabel: string;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={on ? pressedLabel : unpressedLabel}
      className={`flex items-center justify-center gap-2 border px-3 py-2.5 text-[0.8125rem] font-medium transition-colors disabled:pointer-events-none disabled:opacity-55 [border-radius:var(--radius-sheet)] ${
        on
          ? "border-signal-line bg-signal-wash text-signal"
          : "border-rule-2 bg-sheet text-ink-2 hover:border-rule-3 hover:bg-band"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
