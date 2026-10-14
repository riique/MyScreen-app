
import {
  Maximize,
  Mic,
  MicOff,
  Minimize,
  MonitorUp,
  MonitorX,
  PhoneOff,
  Settings2,
  Video,
  VideoOff,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A doca da chamada: uma fila só, centrada, com o que a pessoa toca de olho no
 * vídeo. Microfone e câmera desligados ficam marcados em vermelho de alerta —
 * é o estado que mais causa "você está mudo" numa chamada, então ele precisa
 * ser visto de relance. Compartilhar tela ligado ganha o azul cheio.
 *
 * O estado nunca é só cor: o ícone troca (mic riscado, câmera riscada) e o
 * rótulo acessível diz o que o clique faz.
 */
export interface MediaControlsProps {
  isMicOn: boolean;
  isCamOn: boolean;
  isScreenSharing: boolean;
  isFullscreen: boolean;
  canFullscreen: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onToggleScreenShare: () => void;
  onToggleFullscreen: () => void;
  onOpenSettings: () => void;
  onLeave: () => void;
  /** Controle extra ao lado do compartilhar (o som do PC, quando no ar). */
  extra?: ReactNode;
}

export function MediaControls({
  isMicOn,
  isCamOn,
  isScreenSharing,
  isFullscreen,
  canFullscreen,
  onToggleMic,
  onToggleCam,
  onToggleScreenShare,
  onToggleFullscreen,
  onOpenSettings,
  onLeave,
  extra,
}: MediaControlsProps) {
  return (
    <div className="flex items-center justify-center gap-1.5 sm:gap-2.5">
      <DockButton
        tone={isMicOn ? "idle" : "off"}
        onClick={onToggleMic}
        pressed={isMicOn}
        label={isMicOn ? "Silenciar microfone" : "Ativar microfone"}
      >
        {isMicOn ? <Mic {...ICON} /> : <MicOff {...ICON} />}
      </DockButton>

      <DockButton
        tone={isCamOn ? "idle" : "off"}
        onClick={onToggleCam}
        pressed={isCamOn}
        label={isCamOn ? "Desligar câmera" : "Ligar câmera"}
      >
        {isCamOn ? <Video {...ICON} /> : <VideoOff {...ICON} />}
      </DockButton>

      <DockButton
        tone={isScreenSharing ? "active" : "idle"}
        onClick={onToggleScreenShare}
        pressed={isScreenSharing}
        label={isScreenSharing ? "Parar de compartilhar a tela" : "Compartilhar tela"}
        wide
      >
        {isScreenSharing ? <MonitorX {...ICON} /> : <MonitorUp {...ICON} />}
        <span className="hidden text-[0.8125rem] font-semibold sm:inline">
          {isScreenSharing ? "Parar" : "Compartilhar"}
        </span>
      </DockButton>

      {extra}

      <span aria-hidden className="mx-0.5 hidden h-6 w-px bg-rule-2 sm:block" />

      {canFullscreen ? (
        <DockButton
          tone="idle"
          onClick={onToggleFullscreen}
          label={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
        >
          {isFullscreen ? <Minimize {...ICON} /> : <Maximize {...ICON} />}
        </DockButton>
      ) : null}

      <DockButton tone="idle" onClick={onOpenSettings} label="Configurações de mídia">
        <Settings2 {...ICON} />
      </DockButton>

      <button
        type="button"
        onClick={onLeave}
        aria-label="Sair da reunião"
        title="Sair da reunião"
        className="flex h-11 items-center gap-2 rounded-full bg-alert sm:ml-1 px-4 text-[0.8125rem] font-semibold text-sheet transition-[background-color,transform] hover:brightness-110 active:scale-[0.97] sm:px-5"
      >
        <PhoneOff {...ICON} />
        <span className="hidden sm:inline">Sair</span>
      </button>
    </div>
  );
}

const ICON = { size: 18, strokeWidth: 1.75, "aria-hidden": true } as const;

function DockButton({
  children,
  tone,
  onClick,
  label,
  pressed,
  wide = false,
}: {
  children: ReactNode;
  tone: "idle" | "off" | "active";
  onClick: () => void;
  label: string;
  pressed?: boolean;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn(
        "flex h-11 items-center justify-center gap-2 rounded-full border transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96]",
        wide ? "min-w-11 px-3.5 sm:px-4" : "w-11",
        tone === "idle" && "border-rule-2 bg-sheet text-ink hover:border-rule-3 hover:bg-band",
        tone === "off" &&
          "border-alert-line bg-alert-wash text-alert hover:border-alert-line-2 hover:bg-alert-wash-2",
        tone === "active" &&
          "border-signal bg-signal text-on-signal hover:border-signal-2 hover:bg-signal-2",
      )}
    >
      {children}
    </button>
  );
}
