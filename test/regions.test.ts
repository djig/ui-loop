import { describe, expect, it } from 'vitest';
import { clusterRegions, gap, padBox } from '../src/regions.js';

function mask(w: number, h: number, rects: Array<[number, number, number, number]>): Uint8Array {
  const m = new Uint8Array(w * h);
  for (const [x, y, rw, rh] of rects) for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) m[yy * w + xx] = 1;
  return m;
}

describe('clusterRegions', () => {
  it('returns no regions for an empty mask', () => {
    expect(clusterRegions(new Uint8Array(100 * 100), 100, 100)).toEqual([]);
  });

  it('finds one tight box for one blob', () => {
    const m = mask(200, 200, [[50, 60, 30, 20]]);
    const r = clusterRegions(m, 200, 200);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ x: 50, y: 60, width: 30, height: 20, changedPixels: 600 });
  });

  it('keeps two far-apart blobs separate', () => {
    const m = mask(400, 400, [[10, 10, 20, 20], [300, 300, 40, 40]]);
    const r = clusterRegions(m, 400, 400);
    expect(r).toHaveLength(2);
    // sorted by area desc
    expect(r[0]!.width * r[0]!.height).toBeGreaterThan(r[1]!.width * r[1]!.height);
  });

  it('merges adjacent blobs across bucket boundaries', () => {
    const m = mask(200, 200, [[20, 20, 30, 10], [52, 22, 30, 10]]); // 2px gap, straddles 32px grid
    const r = clusterRegions(m, 200, 200, { bucket: 32 });
    expect(r).toHaveLength(1);
    expect(r[0]!.x).toBe(20);
    expect(r[0]!.width).toBe(62);
  });

  it('respects maxRegions by merging smallest into nearest', () => {
    const rects: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 12; i++) rects.push([i * 80, i * 80, 10, 10]);
    const m = mask(1000, 1000, rects);
    const r = clusterRegions(m, 1000, 1000, { maxRegions: 4, bucket: 16 });
    expect(r.length).toBeLessThanOrEqual(4);
    expect(r.reduce((n, b) => n + b.changedPixels, 0)).toBe(12 * 100);
  });

  it('drops noise below minPixels', () => {
    const m = mask(100, 100, [[5, 5, 1, 2]]);
    expect(clusterRegions(m, 100, 100, { minPixels: 4 })).toEqual([]);
  });
});

describe('gap / padBox', () => {
  it('gap is 0 for overlapping boxes', () => {
    expect(gap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(0);
  });
  it('gap measures horizontal distance', () => {
    expect(gap({ x: 0, y: 0, width: 10, height: 10 }, { x: 15, y: 0, width: 10, height: 10 })).toBe(5);
  });
  it('padBox clamps to image bounds', () => {
    expect(padBox({ x: 2, y: 2, width: 10, height: 10 }, 5, 15, 15)).toEqual({ x: 0, y: 0, width: 15, height: 15 });
  });
});
