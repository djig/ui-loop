import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Box } from './types.js';

export interface RawImage {
  width: number;
  height: number;
  data: Buffer;
}

export function decodePng(buf: Buffer): RawImage {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

export function encodePng(img: RawImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = img.data;
  return PNG.sync.write(png);
}

/** Crop a sub-rectangle (clamped). */
export function crop(img: RawImage, box: Box): RawImage {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.height));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    img.data.copy(out, y * w * 4, src, src + w * 4);
  }
  return { width: w, height: h, data: out };
}

/** Box-filter downscale by factor `scale` (0 < scale ≤ 1). Returns input when scale is 1. */
export function downscale(img: RawImage, scale: number): RawImage {
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = Buffer.alloc(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const ys = Math.floor(y * sy);
    const ye = Math.min(img.height, Math.max(ys + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const xs = Math.floor(x * sx);
      const xe = Math.min(img.width, Math.max(xs + 1, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = ys; yy < ye; yy++) {
        let i = (yy * img.width + xs) * 4;
        for (let xx = xs; xx < xe; xx++) {
          r += img.data[i]!; g += img.data[i + 1]!; b += img.data[i + 2]!; a += img.data[i + 3]!;
          i += 4; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}

/** Scale so longest side ≤ maxSide. */
export function fitLongestSide(img: RawImage, maxSide: number): RawImage {
  const longest = Math.max(img.width, img.height);
  if (longest <= maxSide) return img;
  return downscale(img, maxSide / longest);
}

/**
 * Pad `img` to `width`×`height` with transparent pixels (used when baseline
 * and current screenshots differ in size, e.g. fullPage height changed).
 */
export function padTo(img: RawImage, width: number, height: number): RawImage {
  if (img.width === width && img.height === height) return img;
  const out = Buffer.alloc(width * height * 4);
  const w = Math.min(width, img.width);
  for (let y = 0; y < Math.min(height, img.height); y++) {
    img.data.copy(out, y * width * 4, y * img.width * 4, y * img.width * 4 + w * 4);
  }
  return { width, height, data: out };
}

export interface PixelDiff {
  changed: number;
  total: number;
  width: number;
  height: number;
  mask: Uint8Array;
  dimensionsChanged: boolean;
}

/** Pixel-diff two images; result mask marks changed pixels. */
export function diffImages(a: RawImage, b: RawImage, threshold = 0.1): PixelDiff {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const dimensionsChanged = a.width !== b.width || a.height !== b.height;
  const pa = padTo(a, width, height);
  const pb = padTo(b, width, height);
  const out = new Uint8Array(width * height * 4);
  const changed = pixelmatch(pa.data, pb.data, out, width, height, {
    threshold,
    includeAA: false,
    diffMask: true,
  });
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (out[p + 3]! !== 0) mask[i] = 1;
  }
  return { changed, total: width * height, width, height, mask, dimensionsChanged };
}
