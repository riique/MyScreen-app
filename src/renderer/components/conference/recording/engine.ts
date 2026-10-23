import { Track, type Participant, type Room } from "livekit-client";

/**
 * Gravação local da sala, uma fonte por arquivo.
 *
 * Cada fonte (a câmera ou a tela de alguém) vira um MediaRecorder próprio. O
 * vídeo não é gravado direto da trilha: ele é desenhado num canvas e o canvas
 * é que é gravado. Assim a gravação sobrevive a tudo que troca a trilha no meio
 * — câmera desligada e religada, tela parada e compartilhada de novo, pessoa
 * que cai e volta —, num arquivo só, com um quadro de aviso nos buracos.
 *
 * O áudio é uma mixagem própria de cada arquivo (Web Audio), refeita a cada
 * meio segundo com as trilhas que existem agora. Nada passa pelo volume que a
 * pessoa escolheu para ouvir: grava-se o som como chegou.
 */

export type RecordSource = Track.Source.Camera | Track.Source.ScreenShare;

/** "call": a chamada inteira. "own": só o som de quem está sendo gravado. */
export type RecordAudio = "call" | "own";

export interface RecordTarget {
  identity: string;
  source: RecordSource;
  /** "Tela de Ana", "Ana": vira o nome do arquivo e o texto do quadro de aviso. */
  label: string;
}

export interface RecordingInfo {
  key: string;
  label: string;
  source: RecordSource;
  startedAt: number;
  file: string;
}

export function recordKey(identity: string, source: Track.Source): string {
  return `${identity}:${source}`;
}

const MIME_CANDIDATES: { type: string; ext: "mp4" | "webm" }[] = [
  { type: "video/mp4;codecs=avc1.640028,mp4a.40.2", ext: "mp4" },
  { type: "video/mp4;codecs=avc1,mp4a.40.2", ext: "mp4" },
  { type: "video/mp4;codecs=avc1,opus", ext: "mp4" },
  { type: "video/mp4", ext: "mp4" },
  { type: "video/webm;codecs=vp9,opus", ext: "webm" },
  { type: "video/webm;codecs=vp8,opus", ext: "webm" },
  { type: "video/webm", ext: "webm" },
];

/** MP4 (H.264) quando o Chromium sabe: abre em qualquer player do Windows. */
export function pickFormat(): { type: string; ext: "mp4" | "webm" } {
  return MIME_CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.type)) ?? { type: "", ext: "webm" };
}

const FPS = 30;
const CHUNK_MS = 1000;
const AUDIO_SYNC_MS = 500;
const VIDEO_BITRATE = { camera: 5_000_000, screen: 8_000_000 } as const;

type AudioSource = { node: MediaStreamAudioSourceNode; sink: HTMLAudioElement | null; users: number };

function liveTrack(participant: Participant | undefined, source: Track.Source): MediaStreamTrack | null {
  const pub = participant?.getTrackPublication(source);
  const track = pub?.track?.mediaStreamTrack;
  if (!pub || !track || pub.isMuted || track.readyState !== "live") return null;
  return track;
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

class SourceRecorder {
  readonly startedAt = Date.now();
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly video = document.createElement("video");
  private videoTrack: MediaStreamTrack | null = null;
  private readonly dest: MediaStreamAudioDestinationNode;
  private readonly connected = new Set<MediaStreamTrack>();
  private readonly recorder: MediaRecorder;
  private readonly drawTimer: ReturnType<typeof setInterval>;
  private readonly audioTimer: ReturnType<typeof setInterval>;
  /** Os pedaços vão em ordem: `arrayBuffer()` é assíncrono. */
  private writing: Promise<void> = Promise.resolve();
  private done: Promise<string | null> | null = null;

  constructor(
    private readonly engine: RecordingEngine,
    readonly target: RecordTarget,
    readonly fileId: string,
    readonly file: string,
    format: { type: string },
    private readonly audioMode: RecordAudio,
    onFailed: (message: string) => void,
  ) {
    const first = liveTrack(engine.participant(target.identity), target.source);
    const settings = first?.getSettings();
    const fallback = target.source === Track.Source.ScreenShare ? { w: 1920, h: 1080 } : { w: 1280, h: 720 };
    this.canvas.width = even(Math.min(3840, settings?.width ?? fallback.w));
    this.canvas.height = even(Math.min(2160, settings?.height ?? fallback.h));
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;

    this.video.muted = true;
    this.video.playsInline = true;

    this.dest = engine.audioContext.createMediaStreamDestination();
    this.syncAudio();
    this.draw();

    const stream = new MediaStream([
      ...this.canvas.captureStream(FPS).getVideoTracks(),
      ...this.dest.stream.getAudioTracks(),
    ]);
    this.recorder = new MediaRecorder(stream, {
      ...(format.type ? { mimeType: format.type } : {}),
      videoBitsPerSecond: target.source === Track.Source.ScreenShare ? VIDEO_BITRATE.screen : VIDEO_BITRATE.camera,
      audioBitsPerSecond: 192_000,
    });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const blob = event.data;
      this.writing = this.writing.then(async () => {
        window.myscreen.recording.write(this.fileId, new Uint8Array(await blob.arrayBuffer()));
      });
    };
    this.recorder.onerror = (event) => {
      const error = (event as Event & { error?: DOMException }).error;
      onFailed(`A gravação de ${target.label} parou: ${error?.message ?? "erro do gravador"}.`);
    };
    this.recorder.start(CHUNK_MS);

    this.drawTimer = setInterval(() => this.draw(), 1000 / FPS);
    this.audioTimer = setInterval(() => this.syncAudio(), AUDIO_SYNC_MS);
  }

  /** O quadro de agora: o vídeo da fonte, ou um aviso enquanto ela não tem imagem. */
  private draw() {
    const { ctx, canvas, video } = this;
    const track = liveTrack(this.engine.participant(this.target.identity), this.target.source);
    if (track !== this.videoTrack) {
      this.videoTrack = track;
      video.srcObject = track ? new MediaStream([track]) : null;
      if (track) void video.play().catch(() => {});
    }

    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (track && video.readyState >= 2 && video.videoWidth > 0) {
      // Contain: tela que mudou de formato no meio fica com faixas, nunca cortada.
      const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const w = video.videoWidth * scale;
      const h = video.videoHeight * scale;
      ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      return;
    }
    const isScreen = this.target.source === Track.Source.ScreenShare;
    const size = Math.round(canvas.height / 22);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.fillText(this.target.label, canvas.width / 2, canvas.height / 2 - size * 0.8);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `400 ${Math.round(size * 0.7)}px system-ui, sans-serif`;
    ctx.fillText(
      isScreen ? "Sem compartilhamento de tela agora" : "Câmera desligada",
      canvas.width / 2,
      canvas.height / 2 + size * 0.6,
    );
  }

  /** Liga na mixagem deste arquivo as trilhas que ele deve ouvir agora. */
  private syncAudio() {
    const wanted = new Set(this.engine.audioTracksFor(this.target, this.audioMode));
    for (const track of this.connected) {
      if (wanted.has(track)) continue;
      this.engine.releaseAudio(track, this.dest);
      this.connected.delete(track);
    }
    for (const track of wanted) {
      if (this.connected.has(track)) continue;
      this.engine.useAudio(track, this.dest);
      this.connected.add(track);
    }
  }

  stop(): Promise<string | null> {
    if (this.done) return this.done;
    clearInterval(this.drawTimer);
    clearInterval(this.audioTimer);
    this.done = new Promise<void>((resolve) => {
      if (this.recorder.state === "inactive") return resolve();
      this.recorder.addEventListener("stop", () => resolve(), { once: true });
      this.recorder.stop();
    })
      .then(() => this.writing)
      .then(() => window.myscreen.recording.close(this.fileId))
      .finally(() => {
        for (const track of this.connected) this.engine.releaseAudio(track, this.dest);
        this.connected.clear();
        for (const t of this.recorder.stream.getTracks()) t.stop();
        this.video.srcObject = null;
      });
    return this.done;
  }
}

export class RecordingEngine {
  private ctx: AudioContext | null = null;
  private readonly audio = new Map<MediaStreamTrack, AudioSource>();
  private readonly active = new Map<string, SourceRecorder>();

  constructor(
    private readonly room: Room,
    private readonly onChange: () => void,
    private readonly onError: (message: string) => void,
  ) {}

  get audioContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: 48_000 });
    return this.ctx;
  }

  participant(identity: string): Participant | undefined {
    if (this.room.localParticipant.identity === identity) return this.room.localParticipant;
    return this.room.remoteParticipants.get(identity);
  }

  audioTracksFor(target: RecordTarget, mode: RecordAudio): MediaStreamTrack[] {
    const people: Participant[] =
      mode === "call"
        ? [this.room.localParticipant, ...this.room.remoteParticipants.values()]
        : [this.participant(target.identity)].filter((p): p is Participant => p !== undefined);
    const withScreen = mode === "call" || target.source === Track.Source.ScreenShare;
    const tracks: MediaStreamTrack[] = [];
    for (const p of people) {
      const mic = liveTrack(p, Track.Source.Microphone);
      if (mic) tracks.push(mic);
      const screen = withScreen ? liveTrack(p, Track.Source.ScreenShareAudio) : null;
      if (screen) tracks.push(screen);
    }
    return tracks;
  }

  useAudio(track: MediaStreamTrack, dest: AudioNode) {
    let entry = this.audio.get(track);
    if (!entry) {
      const stream = new MediaStream([track]);
      // O Chromium só entrega o som de uma trilha WebRTC ao Web Audio se ela
      // também estiver tocando num elemento — mudo, para não dobrar o som.
      let sink: HTMLAudioElement | null = null;
      if (!this.isLocalTrack(track)) {
        sink = new Audio();
        sink.muted = true;
        sink.srcObject = stream;
        void sink.play().catch(() => {});
      }
      entry = { node: this.audioContext.createMediaStreamSource(stream), sink, users: 0 };
      this.audio.set(track, entry);
    }
    entry.node.connect(dest);
    entry.users++;
  }

  releaseAudio(track: MediaStreamTrack, dest: AudioNode) {
    const entry = this.audio.get(track);
    if (!entry) return;
    try {
      entry.node.disconnect(dest);
    } catch {
      // Já desligado.
    }
    if (--entry.users > 0) return;
    entry.node.disconnect();
    if (entry.sink) entry.sink.srcObject = null;
    this.audio.delete(track);
  }

  private isLocalTrack(track: MediaStreamTrack): boolean {
    for (const pub of this.room.localParticipant.trackPublications.values()) {
      if (pub.track?.mediaStreamTrack === track) return true;
    }
    return false;
  }

  list(): RecordingInfo[] {
    return [...this.active.entries()].map(([key, r]) => ({
      key,
      label: r.target.label,
      source: r.target.source,
      startedAt: r.startedAt,
      file: r.file,
    }));
  }

  /** Chamado direto do clique: é o gesto que destrava o AudioContext. */
  async start(targets: RecordTarget[], mode: RecordAudio): Promise<void> {
    void this.audioContext.resume();
    const format = pickFormat();
    for (const target of targets) {
      const key = recordKey(target.identity, target.source);
      if (this.active.has(key)) continue;
      try {
        const { id, file } = await window.myscreen.recording.open(target.label, format.ext);
        const recorder = new SourceRecorder(this, target, id, file, format, mode, (message) => {
          this.onError(message);
          void this.stop(key);
        });
        this.active.set(key, recorder);
      } catch (error) {
        console.error("Erro ao começar a gravação:", error);
        this.onError(
          `Não foi possível gravar ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.onChange();
    }
  }

  async stop(key: string): Promise<string | null> {
    const recorder = this.active.get(key);
    if (!recorder) return null;
    this.active.delete(key);
    this.onChange();
    try {
      return await recorder.stop();
    } catch (error) {
      console.error("Erro ao fechar a gravação:", error);
      return recorder.file;
    }
  }

  stopAll(): Promise<(string | null)[]> {
    return Promise.all([...this.active.keys()].map((key) => this.stop(key)));
  }

  async dispose(): Promise<void> {
    await this.stopAll();
    for (const entry of this.audio.values()) {
      entry.node.disconnect();
      if (entry.sink) entry.sink.srcObject = null;
    }
    this.audio.clear();
    void this.ctx?.close();
    this.ctx = null;
  }
}
