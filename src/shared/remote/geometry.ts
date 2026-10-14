/**
 * Geometria do controle remoto. As coordenadas que viajam são 0..65535
 * relativas ao QUADRO DE VÍDEO — não ao elemento HTML (que tem tarja preta por
 * causa do `object-contain`), nem à tela de quem controla.
 */

import { COORD_MAX } from "./protocol";

export type Rect = { x: number; y: number; w: number; h: number };

/** Onde o vídeo aparece dentro do elemento com `object-fit: contain`. */
export function contentRect(elW: number, elH: number, vidW: number, vidH: number): Rect {
  if (elW <= 0 || elH <= 0 || vidW <= 0 || vidH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(elW / vidW, elH / vidH);
  const w = vidW * scale;
  const h = vidH * scale;
  return { x: (elW - w) / 2, y: (elH - h) / 2, w, h };
}

/**
 * Ponto do elemento → coordenada do quadro. Na tarja devolve null (não
 * envia), a não ser com `clamp`, usado quando um botão está apertado e o
 * soltar precisa chegar mesmo fora do quadro.
 */
export function toNormalized(px: number, py: number, r: Rect, clamp = false): [number, number] | null {
  if (r.w <= 0 || r.h <= 0) return null;
  let nx = (px - r.x) / r.w;
  let ny = (py - r.y) / r.h;
  if (nx < 0 || ny < 0 || nx > 1 || ny > 1) {
    if (!clamp) return null;
    nx = Math.min(1, Math.max(0, nx));
    ny = Math.min(1, Math.max(0, ny));
  }
  return [Math.round(nx * COORD_MAX), Math.round(ny * COORD_MAX)];
}

/** Coordenada do quadro → pixel físico do monitor compartilhado. 0 e 65535 caem no primeiro e no último pixel. */
export function toPhysical(x: number, y: number, display: Rect): [number, number] {
  const cx = Math.min(COORD_MAX, Math.max(0, x));
  const cy = Math.min(COORD_MAX, Math.max(0, y));
  return [
    display.x + Math.round((cx / COORD_MAX) * Math.max(0, display.w - 1)),
    display.y + Math.round((cy / COORD_MAX) * Math.max(0, display.h - 1)),
  ];
}

export function contains(r: Rect, px: number, py: number): boolean {
  return px >= r.x && py >= r.y && px < r.x + r.w && py < r.y + r.h;
}
