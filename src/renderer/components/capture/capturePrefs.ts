/**
 * A última escolha de captura, perguntada no diálogo de compartilhar tela.
 * `localStorage` porque é preferência da pessoa nesta máquina, não da sala.
 *
 * O tipo de conteúdo é sempre vídeo e jogos (fluidez) e o som é sempre o do
 * sistema inteiro menos o MyScreen: não são mais perguntados.
 *
 * Toda propriedade é conferida na volta; um valor antigo fora do conjunto
 * (4K, 15 FPS) cai no padrão em vez de descartar a escolha toda.
 */
const KEY = "myscreen:capture";
const AUDIO_KEY = "myscreen:system-audio";

export type CaptureSettings = {
  resolution: "720p" | "1080p" | "1440p";
  frameRate: "30" | "60";
  /** Esconde as janelas do MyScreen da captura (WDA_EXCLUDEFROMCAPTURE). */
  hideSelf: boolean;
  /** Último id escolhido, para pré-selecionar na próxima vez. */
  lastSourceId: string | null;
};

export const DEFAULT_CAPTURE: CaptureSettings = {
  resolution: "1080p",
  frameRate: "60",
  hideSelf: true,
  lastSourceId: null,
};

const RESOLUTIONS = ["720p", "1080p", "1440p"];
const FRAME_RATES = ["30", "60"];

export function parseCapture(raw: string | null): CaptureSettings | null {
  if (!raw) return null;
  try {
    const c: unknown = JSON.parse(raw);
    if (typeof c !== "object" || c === null) return null;
    const v = c as Record<string, unknown>;
    return {
      resolution: RESOLUTIONS.includes(v.resolution as string)
        ? (v.resolution as CaptureSettings["resolution"])
        : DEFAULT_CAPTURE.resolution,
      frameRate: FRAME_RATES.includes(v.frameRate as string)
        ? (v.frameRate as CaptureSettings["frameRate"])
        : DEFAULT_CAPTURE.frameRate,
      hideSelf: typeof v.hideSelf === "boolean" ? v.hideSelf : DEFAULT_CAPTURE.hideSelf,
      lastSourceId:
        typeof v.lastSourceId === "string" && /^(screen|window):[\d:-]+$/.test(v.lastSourceId)
          ? v.lastSourceId
          : null,
    };
  } catch {
    return null;
  }
}

export function readCapture(): CaptureSettings {
  try {
    return parseCapture(localStorage.getItem(KEY)) ?? DEFAULT_CAPTURE;
  } catch {
    return DEFAULT_CAPTURE;
  }
}

export function writeCapture(settings: CaptureSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Quota negada não pode impedir alguém de compartilhar.
  }
}

export type SystemAudioPrefs = {
  normalize: boolean;
  /** 0–400 */
  gainPct: number;
  excludeDiscord: boolean;
};

export const DEFAULT_SYSTEM_AUDIO: SystemAudioPrefs = { normalize: true, gainPct: 100, excludeDiscord: false };

export function parseSystemAudio(raw: string | null): SystemAudioPrefs {
  try {
    const v = JSON.parse(raw ?? "null") as Record<string, unknown> | null;
    if (!v || typeof v !== "object") return DEFAULT_SYSTEM_AUDIO;
    const gain = Number(v.gainPct);
    return {
      normalize: typeof v.normalize === "boolean" ? v.normalize : DEFAULT_SYSTEM_AUDIO.normalize,
      gainPct: Number.isFinite(gain) && gain >= 0 && gain <= 400 ? gain : DEFAULT_SYSTEM_AUDIO.gainPct,
      excludeDiscord: typeof v.excludeDiscord === "boolean" ? v.excludeDiscord : DEFAULT_SYSTEM_AUDIO.excludeDiscord,
    };
  } catch {
    return DEFAULT_SYSTEM_AUDIO;
  }
}

export function readSystemAudio(): SystemAudioPrefs {
  try {
    return parseSystemAudio(localStorage.getItem(AUDIO_KEY));
  } catch {
    return DEFAULT_SYSTEM_AUDIO;
  }
}

export function writeSystemAudio(prefs: SystemAudioPrefs): void {
  try {
    localStorage.setItem(AUDIO_KEY, JSON.stringify(prefs));
  } catch {
    // Sem storage, vale só para esta sessão.
  }
}
