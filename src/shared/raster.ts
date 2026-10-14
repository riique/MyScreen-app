/**
 * Ícones desenhados em código: o app não tem identidade visual além do nome
 * (PRODUCT.md), então o ícone é o quadrado azul de líder com uma tela e
 * barras de som, como o do MyScreen Áudio. Rasterizado por distância com
 * supersampling 4×4 — sem dependência de imagem.
 *
 * Saída RGBA, linha a linha. Usado pelo processo principal (bandeja, janela,
 * botões da miniatura) e pelo script que gera o `.ico` do instalador.
 */

type Rgba = [number, number, number, number];
type Sdf = (x: number, y: number) => number;
type Layer = { sdf: Sdf; color: Rgba; erase?: boolean };

const SIGNAL: Rgba = [0x1b, 0x3a, 0x7d, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const ALERT: Rgba = [0xc2, 0x3b, 0x2a, 255];

function roundRect(cx: number, cy: number, hw: number, hh: number, r: number): Sdf {
  return (x, y) => {
    const qx = Math.abs(x - cx) - hw + r;
    const qy = Math.abs(y - cy) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
}

function circle(cx: number, cy: number, r: number): Sdf {
  return (x, y) => Math.hypot(x - cx, y - cy) - r;
}

/** Segmento com espessura (cápsula). */
function segment(ax: number, ay: number, bx: number, by: number, r: number): Sdf {
  return (x, y) => {
    const pax = x - ax;
    const pay = y - ay;
    const bax = bx - ax;
    const bay = by - ay;
    const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
    return Math.hypot(pax - bax * h, pay - bay * h) - r;
  };
}

/** Contorno de uma forma, com espessura `w`. */
function stroke(sdf: Sdf, w: number): Sdf {
  return (x, y) => Math.abs(sdf(x, y)) - w / 2;
}

/** Arco inferior (meia-lua) de um anel. */
function lowerArc(cx: number, cy: number, r: number, w: number): Sdf {
  const ring = stroke(circle(cx, cy, r), w);
  const capL = circle(cx - r, cy, w / 2);
  const capR = circle(cx + r, cy, w / 2);
  // Acima do centro, só as pontas arredondadas; abaixo, o anel.
  return (x, y) => (y < cy ? Math.min(capL(x, y), capR(x, y)) : ring(x, y));
}

function rasterize(size: number, layers: Layer[]): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          // Coordenadas normalizadas 0..1.
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          let c: Rgba | null = null;
          for (const layer of layers) {
            if (layer.sdf(u, v) <= 0) c = layer.erase ? null : layer.color;
          }
          if (c) {
            const ca = c[3] / 255;
            r += c[0] * ca;
            g += c[1] * ca;
            b += c[2] * ca;
            a += ca;
          }
        }
      }
      const k = (y * size + x) * 4;
      const n = S * S;
      if (a > 0) {
        px[k] = Math.round(r / a);
        px[k + 1] = Math.round(g / a);
        px[k + 2] = Math.round(b / a);
      }
      px[k + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

/** O ícone do app: quadrado azul, tela branca com três barras de som. */
export function appIcon(size: number): Uint8Array {
  const bars = [0.45, 0.8, 0.6];
  const layers: Layer[] = [
    { sdf: roundRect(0.5, 0.5, 0.5, 0.5, 0.2), color: SIGNAL },
    // Moldura da tela.
    { sdf: stroke(roundRect(0.5, 0.44, 0.3, 0.2, 0.05), 0.07), color: WHITE },
    // Pé.
    { sdf: segment(0.5, 0.66, 0.5, 0.74, 0.03), color: WHITE },
    { sdf: segment(0.38, 0.76, 0.62, 0.76, 0.03), color: WHITE },
  ];
  bars.forEach((h, i) => {
    const x = 0.4 + i * 0.1;
    const half = 0.12 * h;
    layers.push({ sdf: segment(x, 0.44 - half, x, 0.44 + half, 0.028), color: WHITE });
  });
  return rasterize(size, layers);
}

export type Glyph = "mic" | "mic-off" | "cam" | "cam-off" | "leave";

/** Pictogramas brancos para os botões da miniatura da barra de tarefas. */
export function glyph(kind: Glyph, size: number): Uint8Array {
  const layers: Layer[] = [];
  const slash = (): void => {
    layers.push({ sdf: segment(0.15, 0.15, 0.85, 0.85, 0.11), color: WHITE, erase: true });
    layers.push({ sdf: segment(0.15, 0.15, 0.85, 0.85, 0.05), color: WHITE });
  };
  if (kind === "mic" || kind === "mic-off") {
    layers.push({ sdf: roundRect(0.5, 0.36, 0.13, 0.24, 0.13), color: WHITE });
    layers.push({ sdf: lowerArc(0.5, 0.45, 0.25, 0.07), color: WHITE });
    layers.push({ sdf: segment(0.5, 0.72, 0.5, 0.86, 0.035), color: WHITE });
    layers.push({ sdf: segment(0.36, 0.88, 0.64, 0.88, 0.035), color: WHITE });
    if (kind === "mic-off") slash();
  } else if (kind === "cam" || kind === "cam-off") {
    layers.push({ sdf: roundRect(0.4, 0.5, 0.28, 0.2, 0.06), color: WHITE });
    layers.push({
      sdf: (x, y) => Math.max(0.68 - x, Math.abs(y - 0.5) - (x - 0.68) * 0.9 - 0.06, x - 0.92),
      color: WHITE,
    });
    if (kind === "cam-off") slash();
  } else {
    layers.push({ sdf: circle(0.5, 0.5, 0.46), color: ALERT });
    layers.push({ sdf: segment(0.34, 0.34, 0.66, 0.66, 0.06), color: WHITE });
    layers.push({ sdf: segment(0.66, 0.34, 0.34, 0.66, 0.06), color: WHITE });
  }
  return rasterize(size, layers);
}

/** RGBA → BGRA, o formato do `nativeImage.createFromBitmap` no Windows. */
export function rgbaToBgra(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2];
    out[i + 1] = rgba[i + 1];
    out[i + 2] = rgba[i];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}
