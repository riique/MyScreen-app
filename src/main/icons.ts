import { nativeImage, type NativeImage } from "electron";
import { appIcon, glyph, rgbaToBgra, type Glyph } from "../shared/raster";

function fromRgba(rgba: Uint8Array, size: number, scaleFactor = 1): NativeImage {
  return nativeImage.createFromBitmap(Buffer.from(rgbaToBgra(rgba)), { width: size, height: size, scaleFactor });
}

const cache = new Map<string, NativeImage>();

/** Ícone do app em vários tamanhos (janela, bandeja, notificações). */
export function appImage(size = 256): NativeImage {
  const key = `app:${size}`;
  let img = cache.get(key);
  if (!img) {
    img = fromRgba(appIcon(size), size);
    cache.set(key, img);
  }
  return img;
}

/** Pictograma 16 px lógicos (32 px reais) para a miniatura da barra de tarefas. */
export function glyphImage(kind: Glyph): NativeImage {
  const key = `glyph:${kind}`;
  let img = cache.get(key);
  if (!img) {
    img = fromRgba(glyph(kind, 32), 32, 2);
    cache.set(key, img);
  }
  return img;
}
