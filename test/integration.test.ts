import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright-core';
import { launchBrowser, resolveChromium } from '../src/browser.js';
import { capture, diff, region } from '../src/capture.js';
import { assert } from '../src/assert.js';
import { estimateTextTokens } from '../src/budget.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { CaptureStore } from '../src/store.js';

const chromium = resolveChromium();
const run = chromium ? describe : describe.skip;
if (!chromium) console.warn('integration: no Chromium found (set UI_LOOP_CHROMIUM); skipping');

run('capture → diff → assert (real browser)', () => {
  let server: Server;
  let base = '';
  let browser: Browser;
  let current = 'before';
  const cwd = mkdtempSync(join(tmpdir(), 'uil-int-'));
  const fixtures = join(__dirname, 'fixtures');
  const config = { ...DEFAULT_CONFIG, keepPerLabel: 3 };

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/missing')) {
        res.writeHead(404).end('nope');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(join(fixtures, `${current}.html`)));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it('first capture returns a full image within budget', async () => {
    const out = await capture({ url: `${base}/page`, label: 'fixture', maxTokens: 1500, cwd }, { browser, config });
    expect(out.isFirstCapture).toBe(true);
    expect(out.summary.title).toBe('Fixture Before');
    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.kind).toBe('full');
    expect(out.budget.totalTokens).toBeLessThanOrEqual(1500);
    expect(out.text).toContain('console: clean');
    expect(out.text).toContain('a11y: no violations');
  });

  it('diff reports moved button, console error, overflow, a11y, within budget', async () => {
    current = 'after';
    const out = await diff({ url: `${base}/page`, label: 'fixture', maxTokens: 2000, cwd }, { browser, config });
    expect(out.diff).toBeDefined();
    const d = out.diff!;
    expect(d.regions.length).toBeGreaterThanOrEqual(1);
    expect(d.percentChanged).toBeGreaterThan(0);
    // Button moved: layout shift on #cta
    expect(d.layoutShifts.some((l) => l.selector === '#cta')).toBe(true);
    // Health
    expect(out.summary.console.some((c) => c.level === 'error' && c.text.includes('Boom') && c.count === 2)).toBe(true);
    expect(out.summary.horizontalOverflow.detected).toBe(true);
    expect(out.summary.a11y.violations.some((v) => v.id === 'image-alt')).toBe(true);
    // Text reflects these
    expect(out.text).toMatch(/console: 1 error/);
    expect(out.text).toContain('horizontal overflow: YES');
    expect(out.text).toContain('image-alt');
    // Budget: text + images ≤ max
    expect(out.budget.totalTokens).toBeLessThanOrEqual(2000);
    expect(estimateTextTokens(out.text) + out.images.reduce((n, i) => n + i.tokens, 0)).toBeLessThanOrEqual(2000);
    // Region crops are capped in size and are region kind
    for (const img of out.images) {
      expect(img.kind).toBe('region');
      expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(512);
    }
    // Element hint for the biggest region should be near the button or header text
    expect(d.regions.some((r) => r.element)).toBe(true);
  });

  it('a tiny budget omits regions and says how to fetch them', async () => {
    const out = await diff({ url: `${base}/page`, label: 'fixture', maxTokens: 400, cwd }, { browser, config });
    expect(out.budget.textTokens).toBeLessThanOrEqual(400 + 50); // text is always included even if it overshoots a tiny budget
    if (out.diff!.regions.length > 0 && out.images.length < out.diff!.regions.length) {
      expect(out.text).toContain('omitted');
      expect(out.text).toContain('ui_region');
    }
  });

  it('ui_region fetches a crop by index and by box', async () => {
    const store = new CaptureStore(cwd);
    const latest = (await store.latest('fixture'))!;
    const s = await store.readSummary(latest);
    if (s.diffRegions && s.diffRegions.length > 0) {
      const r = await region({ label: 'fixture', region: 0, maxTokens: 800, cwd });
      expect(r.image.tokens).toBeLessThanOrEqual(800);
      expect(r.text).toContain('#0');
    }
    const byBox = await region({ label: 'fixture', region: { x: 0, y: 0, width: 200, height: 100 }, maxTokens: 500, cwd });
    expect(byBox.image.width).toBeLessThanOrEqual(200);
  });

  it('eviction keeps at most keepPerLabel captures', async () => {
    const list = await new CaptureStore(cwd).list('fixture');
    expect(list.length).toBeLessThanOrEqual(3);
    expect(list.length).toBeGreaterThanOrEqual(3);
  });

  it('assert returns pass/fail with evidence and no images', async () => {
    const out = await assert(
      {
        url: `${base}/page`,
        cwd,
        checks: [
          { type: 'text', text: 'Dashboard' },
          { type: 'visible', selector: '#cta' },
          { type: 'hidden', selector: '#nope' },
          { type: 'count', selector: 'button', min: 1, max: 1 },
          { type: 'noConsoleErrors' },
          { type: 'noOverflow' },
          { type: 'a11y', impact: 'serious' },
        ],
      },
      { browser, config },
    );
    const byType = Object.fromEntries(out.results.map((r) => [r.check.type, r]));
    expect(byType.text!.pass).toBe(true);
    expect(byType.visible!.pass).toBe(true);
    expect(byType.hidden!.pass).toBe(true);
    expect(byType.count!.pass).toBe(true);
    expect(byType.noConsoleErrors!.pass).toBe(false);
    expect(byType.noConsoleErrors!.evidence).toContain('Boom');
    expect(byType.noOverflow!.pass).toBe(false);
    expect(byType.a11y!.pass).toBe(false);
    expect(byType.a11y!.evidence).toContain('image-alt');
    expect(out.passed).toBe(4);
    expect(out.failed).toBe(3);
    expect(out.text).toContain('FAIL no console errors');
  });

  it('failed requests are reported', async () => {
    const out = await capture({ url: `${base}/missing`, label: 'missing', cwd }, { browser, config });
    expect(out.summary.failedRequests.some((r) => r.status === 404)).toBe(true);
    expect(out.text).toContain('404 GET');
  });
});
