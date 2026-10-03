import { describe, expect, it } from 'vitest';
import { boundText, formatCapture, formatDiff, formatHealth } from '../src/summary.js';
import type { CaptureSummary, DiffResult } from '../src/types.js';

const base: CaptureSummary = {
  id: '2026-10-03T00-00-00-000Z',
  label: 'settings',
  url: 'http://localhost:3000/settings',
  finalUrl: 'http://localhost:3000/settings?tab=1',
  title: 'Settings',
  timestamp: '2026-10-03T00:00:00.000Z',
  viewport: { width: 1280, height: 800 },
  fullPage: false,
  image: { width: 1280, height: 800, bytes: 1000 },
  console: [{ level: 'error', text: 'Boom', count: 3 }, { level: 'warning', text: 'careful', count: 1 }],
  exceptions: ['TypeError: x is not a function'],
  failedRequests: [{ url: 'http://localhost:3000/api/x', status: 500, method: 'GET' }],
  horizontalOverflow: { detected: true, scrollWidth: 2400, innerWidth: 1280 },
  watchedRects: [],
  a11y: { violations: [{ id: 'image-alt', impact: 'critical', help: 'Images must have alternate text', nodes: 1, sample: '<img src="x">' }], total: 1, impactThreshold: 'serious' },
};
const budget = { maxTokens: 4000, textTokens: 100, imageTokens: 0, totalTokens: 100, omittedRegions: [], omittedFull: false };

describe('formatHealth', () => {
  it('reports console, requests, overflow, a11y', () => {
    const t = formatHealth(base).join('\n');
    expect(t).toContain('console: 1 error(s), 1 warning(s), 1 uncaught exception(s)');
    expect(t).toContain('Boom (×3)');
    expect(t).toContain('500 GET http://localhost:3000/api/x');
    expect(t).toContain('horizontal overflow: YES');
    expect(t).toContain('[critical] image-alt');
  });
  it('says clean when nothing is wrong', () => {
    const t = formatHealth({ ...base, console: [], exceptions: [], failedRequests: [], horizontalOverflow: { detected: false, scrollWidth: 1, innerWidth: 1 }, a11y: { violations: [], total: 0, impactThreshold: 'serious' } }).join('\n');
    expect(t).toContain('console: clean');
    expect(t).toContain('a11y: no violations');
    expect(t).not.toContain('overflow');
  });
  it('caps console lines', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ level: 'error' as const, text: `e${i}`, count: 1 }));
    const t = formatHealth({ ...base, console: many, exceptions: [] }, { maxConsole: 3 }).join('\n');
    expect(t).toContain('… 27 more');
  });
});

describe('formatCapture / formatDiff', () => {
  it('capture header marks first capture and includes redirected url', () => {
    const t = formatCapture(base, budget, true);
    expect(t).toContain('first capture, saved as baseline');
    expect(t).toContain('(requested http://localhost:3000/settings)');
    expect(t).toContain('budget: ~100/4000');
  });
  it('diff lists regions with element hints and layout shifts', () => {
    const d: DiffResult = {
      baselineId: 'a', currentId: 'b', percentChanged: 1.234, changedPixels: 1234, totalPixels: 100000, dimensionsChanged: false,
      regions: [{ index: 0, box: { x: 10, y: 20, width: 100, height: 50 }, changedPixels: 900, element: { tag: 'button', role: 'button', text: 'Save' } }],
      layoutShifts: [{ selector: '#cta', from: { x: 0, y: 0, width: 10, height: 10 }, to: { x: 5, y: 0, width: 10, height: 10 } }],
    };
    const t = formatDiff(base, d, { ...budget, omittedRegions: [1, 2] });
    expect(t).toContain('pixels changed: 1.23%');
    expect(t).toContain('#0 [10,20 100×50] 900px near <button role=button> "Save"');
    expect(t).toContain('layout shifts: 1');
    expect(t).toContain('2 more regions omitted');
  });
  it('diff says identical when nothing changed', () => {
    const d: DiffResult = { baselineId: 'a', currentId: 'b', percentChanged: 0, changedPixels: 0, totalPixels: 1, dimensionsChanged: false, regions: [], layoutShifts: [] };
    expect(formatDiff(base, d, budget)).toContain('visually identical');
  });
});

describe('boundText', () => {
  it('leaves short text alone and truncates long text', () => {
    expect(boundText('abc', 10)).toBe('abc');
    const t = boundText('x'.repeat(100), 50);
    expect(t.length).toBeLessThanOrEqual(50);
    expect(t.endsWith('…(truncated)')).toBe(true);
  });
});
