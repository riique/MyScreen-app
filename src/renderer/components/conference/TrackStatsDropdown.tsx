
import { isTrackReference, type TrackReferenceOrPlaceholder } from "@livekit/components-react";
import {
  isLocalTrack,
  type AudioReceiverStats,
  type AudioSenderStats,
  type Track,
  type VideoReceiverStats,
  type VideoSenderStats,
} from "livekit-client";
import { useEffect, useRef, useState } from "react";

/**
 * Este painel é a afirmação mais honesta do produto, e ele precisa fazer isso de
 * verdade: cada campo que o WebRTC não mediu aparece como `--`, e latência e
 * qualidade desconhecida aparecem como `n/d`. Número inventado seria mais bonito
 * e seria mentira — e quem está debugando uma chamada ruim confia justamente
 * nesta tela.
 */

type AnyReceiverStats = AudioReceiverStats | VideoReceiverStats;
type AnySenderStats = AudioSenderStats | VideoSenderStats;

/**
 * `getReceiverStats` e `getSenderStats` não existem na `Track` base, só nas
 * especializações de áudio e vídeo. O `in` estreita o tipo sem `as any` e sem
 * perder a forma do retorno — um cast aqui desligaria a checagem exatamente na
 * fronteira que precisa dela.
 */
function hasReceiverStats(
  track: Track,
): track is Track & { getReceiverStats(): Promise<AnyReceiverStats | undefined> } {
  return "getReceiverStats" in track && typeof track.getReceiverStats === "function";
}

function hasSenderStats(
  track: Track,
): track is Track & {
  getSenderStats(): Promise<AnySenderStats | AnySenderStats[] | undefined>;
} {
  return "getSenderStats" in track && typeof track.getSenderStats === "function";
}

type QualityTone = "excellent" | "good" | "poor" | "lost" | "unknown";

const QUALITY_TEXT: Record<QualityTone, string> = {
  excellent: "Excelente",
  good: "Boa",
  poor: "Instável",
  lost: "Conexão perdida",
  unknown: "n/d",
};

const QUALITY_CLASS: Record<QualityTone, string> = {
  excellent: "text-ink",
  good: "text-ink",
  poor: "text-warn",
  lost: "text-alert",
  unknown: "text-ink-3",
};

const QUALITY_DOT_CLASS: Record<QualityTone, string> = {
  excellent: "bg-signal",
  good: "bg-signal",
  poor: "bg-warn-dot",
  lost: "bg-alert",
  unknown: "bg-rule-2",
};

function toQualityTone(quality: string | undefined): QualityTone {
  if (quality === "excellent" || quality === "good" || quality === "poor" || quality === "lost") {
    return quality;
  }
  return "unknown";
}

type StatsData = {
  fps: number | null;
  resolution: string;
  bitrate: string;
  latencyMs: number | null;
  jitterMs: number | null;
  codec: string;
  quality: QualityTone;
  packetsLost: number;
  framesDropped: number;
  framesReceived: number;
  pliCount: number;
  nackCount: number;
  firCount: number;
  decoder: string;
};

const INITIAL_STATS: StatsData = {
  fps: null,
  resolution: "--",
  bitrate: "--",
  latencyMs: null,
  jitterMs: null,
  codec: "--",
  quality: "unknown",
  packetsLost: 0,
  framesDropped: 0,
  framesReceived: 0,
  pliCount: 0,
  nackCount: 0,
  firCount: 0,
  decoder: "--",
};

interface TrackStatsDropdownProps {
  trackRef: TrackReferenceOrPlaceholder | undefined;
  open: boolean;
  onClose: () => void;
}

export function TrackStatsDropdown({ trackRef, open, onClose }: TrackStatsDropdownProps) {
  const [stats, setStats] = useState<StatsData>(INITIAL_STATS);

  // A amostra anterior é memória de leitura, não estado de tela: existe para o
  // delta e nunca é renderizada. Ref, e não useState, porque um setState
  // dentro do ciclo de polled re-renderiza a folha a cada tique.
  const prevBytes = useRef<{ bytes: number; timestamp: number } | null>(null);
  const prevFrames = useRef<{ frames: number; timestamp: number } | null>(null);

  const reference = isTrackReference(trackRef) ? trackRef : null;
  const track = reference?.publication?.track;

  useEffect(() => {
    if (!open || !reference || !track) return;

    // Capturados antes do closure: a letra estreita o tipo de `track` e
    // `participant` aqui, e a inferência não atravessa a função async.
    const activeTrack = track;
    const participant = reference.participant;
    const connectionQuality = participant.connectionQuality;

    prevBytes.current = null;
    prevFrames.current = null;

    let isFetching = false;
    let cancelled = false;

    async function updateStats() {
      if (isFetching) return;
      isFetching = true;
      try {
        const receiver = hasReceiverStats(activeTrack)
          ? await activeTrack.getReceiverStats()
          : undefined;
        const senderResult =
          receiver === undefined && hasSenderStats(activeTrack)
            ? await activeTrack.getSenderStats()
            : undefined;
        const sender = Array.isArray(senderResult) ? senderResult[0] : senderResult;
        if (cancelled || (!receiver && !sender)) return;

        const next: StatsData = { ...INITIAL_STATS };
        const dimensions = isLocalTrack(activeTrack) ? activeTrack.dimensions : undefined;

        if (receiver?.type === "video") {
          next.framesReceived = receiver.framesReceived ?? 0;
          next.framesDropped = receiver.framesDropped ?? 0;
          next.decoder = receiver.decoderImplementation ?? "--";
          next.packetsLost = receiver.packetsLost ?? 0;
          next.pliCount = receiver.pliCount ?? 0;
          next.nackCount = receiver.nackCount ?? 0;
          next.firCount = receiver.firCount ?? 0;
          if (typeof receiver.jitter === "number") {
            next.jitterMs = Math.round(receiver.jitter * 1000);
          }
          if (receiver.frameWidth && receiver.frameHeight) {
            next.resolution = `${receiver.frameWidth} × ${receiver.frameHeight}`;
          }
          if (typeof receiver.mimeType === "string") {
            next.codec = receiver.mimeType.replace(/^video\//i, "").toUpperCase();
          }

          // FPS sai de `framesDecoded` entre duas amostras. Sem amostra anterior
          // não há taxa — e taxa inventada seria o erro mais caro aqui.
          const currentFrames = receiver.framesDecoded;
          const sampleTs = receiver.timestamp;
          const prevFrameSample = prevFrames.current;
          if (
            prevFrameSample &&
            typeof currentFrames === "number" &&
            typeof sampleTs === "number" &&
            sampleTs > prevFrameSample.timestamp &&
            currentFrames >= prevFrameSample.frames
          ) {
            const dTime = (sampleTs - prevFrameSample.timestamp) / 1000;
            if (dTime > 0) {
              next.fps = Math.max(0, Math.round((currentFrames - prevFrameSample.frames) / dTime));
            }
          }
          if (typeof currentFrames === "number" && typeof sampleTs === "number" && sampleTs > 0) {
            prevFrames.current = { frames: currentFrames, timestamp: sampleTs };
          }
        }

        if (sender?.type === "video") {
          if (typeof sender.framesPerSecond === "number" && sender.framesPerSecond > 0) {
            next.fps = Math.round(sender.framesPerSecond);
          }
          if (sender.frameWidth && sender.frameHeight) {
            next.resolution = `${sender.frameWidth} × ${sender.frameHeight}`;
          }
          if (typeof sender.packetsLost === "number") next.packetsLost = sender.packetsLost;
          if (typeof sender.jitter === "number") next.jitterMs = Math.round(sender.jitter * 1000);
          // RTT só existe no lado transmissor. No receptor ele simplesmente não
          // existe — daí o `n/d`, e não um zero.
          if (typeof sender.roundTripTime === "number") {
            next.latencyMs = Math.round(sender.roundTripTime * 1000);
          }
        }

        // Bitrate é delta de bytes por tempo. Contador absoluto não é taxa, e
        // mostrar bytes acumulados como "kbps" é o erro clássico deste painel.
        const byteCounter = receiver?.bytesReceived ?? sender?.bytesSent;
        const statTimestamp = receiver?.timestamp ?? sender?.timestamp;
        const prevByteSample = prevBytes.current;
        if (typeof byteCounter === "number" && typeof statTimestamp === "number") {
          if (prevByteSample && statTimestamp > prevByteSample.timestamp) {
            const dTime = (statTimestamp - prevByteSample.timestamp) / 1000;
            const dBytes = byteCounter - prevByteSample.bytes;
            if (dTime > 0 && dBytes >= 0) {
              const bps = (dBytes * 8) / dTime;
              next.bitrate =
                bps > 1_000_000
                  ? `${(bps / 1_000_000).toFixed(1)} Mbps`
                  : `${Math.round(bps / 1000)} kbps`;
            }
          }
          prevBytes.current = { bytes: byteCounter, timestamp: statTimestamp };
        } else if (activeTrack.currentBitrate) {
          next.bitrate = `${Math.round(activeTrack.currentBitrate / 1000)} kbps`;
        }

        if (next.resolution === "--" && dimensions?.width && dimensions?.height) {
          next.resolution = `${dimensions.width} × ${dimensions.height}`;
        }
        next.quality = toQualityTone(connectionQuality);

        if (!cancelled) setStats(next);
      } catch (err) {
        if (err instanceof Error && "code" in err) {
          console.debug(`Falha ao coletar estatísticas do track (${err.code}):`, err.message);
        } else {
          console.debug("Erro ao coletar estatísticas do track:", err);
        }
      } finally {
        isFetching = false;
      }
    }

    void updateStats();
    const id = setInterval(() => void updateStats(), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, reference, track]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Estatísticas do fluxo"
      className="border border-rule bg-sheet [border-radius:var(--radius-sheet)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-rule px-3 py-2">
        <h3 className="label-col">
          Estatísticas do fluxo
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar estatísticas"
          className="text-[0.6875rem] text-ink-3 transition-colors hover:text-ink"
        >
          Fechar
        </button>
      </div>

      <dl className="px-3 py-1">
        <Row label="Taxa de quadros" value={stats.fps === null ? "--" : `${stats.fps} FPS`} />
        <Row label="Resolução" value={stats.resolution} />
        <Row label="Taxa de bits" value={stats.bitrate} />
        <Row
          label="Latência (RTT)"
          value={stats.latencyMs === null ? "n/d" : `${stats.latencyMs} ms`}
        />
        {stats.jitterMs === null ? null : <Row label="Jitter" value={`${stats.jitterMs} ms`} />}
        <Row label="Codec" value={stats.codec} />
        <Row
          label="Perda de pacotes"
          value={`${stats.packetsLost} pacotes`}
          tone={stats.packetsLost > 0 ? "warn" : "plain"}
        />
        <Row
          label="Qualidade de conexão"
          value={QUALITY_TEXT[stats.quality]}
          tone={stats.quality === "unknown" ? "muted" : "plain"}
          className={QUALITY_CLASS[stats.quality]}
          dot={QUALITY_DOT_CLASS[stats.quality]}
        />
        <Row
          label="Quadros descartados"
          value={
            stats.framesReceived === 0
              ? "--"
              : `${stats.framesDropped} / ${stats.framesReceived}`
          }
        />
        <Row
          label="PLI / NACK / FIR"
          value={
            stats.framesReceived === 0
              ? "--"
              : `${stats.pliCount} / ${stats.nackCount} / ${stats.firCount}`
          }
        />
        <Row
          label="Decoder"
          value={stats.decoder}
          title={stats.decoder !== "--" ? stats.decoder : undefined}
        />
      </dl>
    </div>
  );
}

function Row({
  label,
  value,
  title,
  dot,
  tone = "plain",
  className = "",
}: {
  label: string;
  value: string;
  title?: string;
  dot?: string;
  tone?: "plain" | "warn" | "muted";
  className?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule py-1.5 last:border-b-0">
      <dt className="text-[0.75rem] text-ink-3">{label}</dt>
      <dd
        className={`flex items-center gap-1.5 font-mono text-[0.75rem] [font-variant-numeric:tabular-nums] ${
          tone === "warn" ? "text-warn" : tone === "muted" ? "text-ink-3" : "text-ink"
        } ${className}`}
        title={title}
      >
        {dot ? <span aria-hidden className={`size-[5px] rounded-full ${dot}`} /> : null}
        {value}
      </dd>
    </div>
  );
}
