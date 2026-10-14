/**
 * Números da captura e do palco, iguais aos do site. Puros, para teste.
 */

export type ScreenResolution = "720p" | "1080p" | "1440p";

/**
 * Orçamento de bits da tela por resolução, em 30 FPS. 60 FPS ganha 50% a mais
 * (o dobro de quadros disputando o mesmo orçamento).
 */
export const SCREEN_BITRATE: Record<ScreenResolution, number> = {
  "720p": 3_500_000,
  "1080p": 6_000_000,
  "1440p": 9_000_000,
};

export function screenBitrate(resolution: ScreenResolution, fps: number): number {
  const factor = fps >= 60 ? 1.5 : 1;
  return Math.round(SCREEN_BITRATE[resolution] * factor);
}

export const RESOLUTION: Record<ScreenResolution, { width: number; height: number }> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
};

export const GRID_GAP = 12;
export const ASPECT = 16 / 9;

/**
 * Grade de câmeras: o número de colunas que dá o MAIOR quadro 16:9 possível
 * dentro da caixa. Devolve o tamanho do quadro.
 */
export function bestGridTile(n: number, w: number, h: number, gap = GRID_GAP): { w: number; h: number; cols: number } {
  let best = { w: 0, h: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const maxW = (w - gap * (cols - 1)) / cols;
    const maxH = (h - gap * (rows - 1)) / rows;
    const tw = Math.max(0, Math.min(maxW, maxH * ASPECT));
    if (tw > best.w) best = { w: tw, h: tw / ASPECT, cols };
  }
  return best;
}

/**
 * Palco dividido: colunas que dão a maior imagem 16:9 visível em cada célula
 * (a célula ocupa a fatia inteira; o vídeo cresce com `contain`).
 */
export function bestSplitColumns(n: number, w: number, h: number, gap = GRID_GAP): number {
  let bestCols = 1;
  let bestW = -1;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = (w - gap * (cols - 1)) / cols;
    const cellH = (h - gap * (rows - 1)) / rows;
    const visible = Math.min(cellW, cellH * ASPECT);
    if (visible > bestW) {
      bestW = visible;
      bestCols = cols;
    }
  }
  return bestCols;
}

/** HWND de um id do desktopCapturer (`window:<HWND>:0`); null para telas. */
export function hwndFromSourceId(id: string): bigint | null {
  const m = /^window:(\d+):\d+$/.exec(id);
  if (!m) return null;
  try {
    return BigInt(m[1]);
  } catch {
    return null;
  }
}
