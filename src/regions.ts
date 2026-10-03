import type { Box } from './types.js';

export interface ClusterOptions {
  /** Grid bucket size in px. Default 32. */
  bucket?: number;
  /** Max regions returned. Default 8. */
  maxRegions?: number;
  /** Ignore buckets with fewer changed pixels than this. Default 4. */
  minPixels?: number;
  /** Boxes closer than this (px) are merged. Default = bucket. */
  mergeGap?: number;
}

export interface Region extends Box {
  changedPixels: number;
}

/**
 * Cluster a diff mask into bounding-box regions.
 *
 * `mask` is a Uint8Array of width*height where non-zero means "changed".
 * Approach: bucket changed pixels on a coarse grid, turn each non-empty
 * bucket into a box, repeatedly merge boxes that overlap or sit within
 * `mergeGap`, then enforce `maxRegions` by merging the smallest region into
 * its nearest neighbour until the cap is met. Result sorted by area desc.
 */
export function clusterRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  opts: ClusterOptions = {},
): Region[] {
  const bucket = opts.bucket ?? 32;
  const maxRegions = Math.max(1, opts.maxRegions ?? 8);
  const minPixels = opts.minPixels ?? 4;
  const mergeGap = opts.mergeGap ?? bucket;

  const cols = Math.ceil(width / bucket);
  const rows = Math.ceil(height / bucket);
  const counts = new Uint32Array(cols * rows);
  const minX = new Int32Array(cols * rows).fill(width);
  const minY = new Int32Array(cols * rows).fill(height);
  const maxX = new Int32Array(cols * rows).fill(-1);
  const maxY = new Int32Array(cols * rows).fill(-1);

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    const by = Math.floor(y / bucket) * cols;
    for (let x = 0; x < width; x++) {
      if (mask[rowBase + x] === 0) continue;
      const bi = by + Math.floor(x / bucket);
      counts[bi]!++;
      if (x < minX[bi]!) minX[bi] = x;
      if (x > maxX[bi]!) maxX[bi] = x;
      if (y < minY[bi]!) minY[bi] = y;
      if (y > maxY[bi]!) maxY[bi] = y;
    }
  }

  let boxes: Region[] = [];
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]! < minPixels) continue;
    boxes.push({
      x: minX[i]!,
      y: minY[i]!,
      width: maxX[i]! - minX[i]! + 1,
      height: maxY[i]! - minY[i]! + 1,
      changedPixels: counts[i]!,
    });
  }
  if (boxes.length === 0) return [];

  boxes = mergeAll(boxes, mergeGap);

  while (boxes.length > maxRegions) {
    // Merge the smallest box into its nearest neighbour.
    boxes.sort((a, b) => a.width * a.height - b.width * b.height);
    const smallest = boxes.shift()!;
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < boxes.length; i++) {
      const d = gap(smallest, boxes[i]!);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    boxes[bestIdx] = union(boxes[bestIdx]!, smallest);
    boxes = mergeAll(boxes, mergeGap);
  }

  return boxes.sort((a, b) => b.width * b.height - a.width * a.height);
}

/** Merge boxes that overlap or whose gap ≤ `mergeGap` until stable. */
function mergeAll(input: Region[], mergeGap: number): Region[] {
  let boxes = [...input];
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (gap(boxes[i]!, boxes[j]!) <= mergeGap) {
          const u = union(boxes[i]!, boxes[j]!);
          boxes.splice(j, 1);
          boxes[i] = u;
          merged = true;
          break outer;
        }
      }
    }
  }
  return boxes;
}

/** Chebyshev-ish gap between two boxes: 0 when overlapping/touching. */
export function gap(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.max(dx, dy);
}

export function union(a: Region, b: Region): Region {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: x2 - x, height: y2 - y, changedPixels: a.changedPixels + b.changedPixels };
}

/** Expand a box by `pad` on each side, clamped to the image. */
export function padBox(box: Box, pad: number, imgW: number, imgH: number): Box {
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const x2 = Math.min(imgW, box.x + box.width + pad);
  const y2 = Math.min(imgH, box.y + box.height + pad);
  return { x, y, width: Math.max(1, x2 - x), height: Math.max(1, y2 - y) };
}
