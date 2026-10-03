import { describe, expect, it } from 'vitest';
import { allocate, estimateImageTokens, estimateTextTokens, makeBudgetReport, omissionNote, scaleToFitTokens } from '../src/budget.js';

describe('token estimators', () => {
  it('uses the w*h/750 image formula', () => {
    expect(estimateImageTokens(1280, 800)).toBe(Math.ceil((1280 * 800) / 750));
    expect(estimateImageTokens(512, 512)).toBe(350);
    expect(estimateImageTokens(0, 10)).toBe(0);
  });
  it('estimates text at 4 chars/token', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
  });
  it('scaleToFitTokens returns 1 when it already fits and shrinks otherwise', () => {
    expect(scaleToFitTokens(100, 100, 1000)).toBe(1);
    const s = scaleToFitTokens(1280, 800, 500);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
    expect(estimateImageTokens(Math.round(1280 * s), Math.round(800 * s))).toBeLessThanOrEqual(500);
    expect(scaleToFitTokens(100, 100, 0)).toBe(0);
  });
});

describe('allocate', () => {
  it('includes by priority desc while under budget and reports omissions', () => {
    const cands = [
      { item: 'a', tokens: 300, priority: 10 },
      { item: 'b', tokens: 500, priority: 50 },
      { item: 'c', tokens: 400, priority: 30 },
    ];
    const r = allocate(cands, 800);
    expect(r.included).toEqual(['b', 'a']); // c (400) does not fit after b (500); a (300) does
    expect(r.omitted).toEqual(['c']);
    expect(r.used).toBe(800);
  });
  it('omits everything with zero budget', () => {
    const r = allocate([{ item: 1, tokens: 10, priority: 1 }], 0);
    expect(r.included).toEqual([]);
    expect(r.omitted).toEqual([1]);
  });
});

describe('budget report + omission messaging', () => {
  it('sums text and image tokens', () => {
    const rep = makeBudgetReport(4000, 'x'.repeat(400), [{ data: '', mimeType: 'image/png', width: 10, height: 10, tokens: 123, kind: 'region' }], [2, 3, 4], false);
    expect(rep.textTokens).toBe(100);
    expect(rep.imageTokens).toBe(123);
    expect(rep.totalTokens).toBe(223);
  });
  it('tells the agent how to fetch omitted regions', () => {
    const rep = makeBudgetReport(1000, '', [], [2, 3, 4], false);
    const note = omissionNote(rep, 'settings');
    expect(note).toContain('3 more regions omitted');
    expect(note).toContain('ui_region');
    expect(note).toContain('"settings"');
  });
  it('singularizes one omitted region and mentions omitted full screenshot', () => {
    const rep = makeBudgetReport(1000, '', [], [1], true);
    const note = omissionNote(rep, 'home');
    expect(note).toContain('1 more region omitted');
    expect(note).toContain('Full screenshot omitted');
  });
  it('is empty when nothing omitted', () => {
    expect(omissionNote(makeBudgetReport(1000, '', [], [], false), 'x')).toBe('');
  });
});
