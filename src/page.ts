import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Browser, Page, BrowserContext } from 'playwright-core';
import type { UiLoopConfig } from './config.js';
import type {
  A11yViolation,
  Box,
  CaptureOptions,
  CaptureSummary,
  ConsoleEntry,
  ElementHint,
  FailedRequest,
  WatchedRect,
} from './types.js';
import { newCaptureId, slugify } from './store.js';

const require = createRequire(import.meta.url);
let axeSource: string | undefined;
function getAxeSource(): string {
  if (!axeSource) axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  return axeSource;
}

const IMPACT_ORDER = ['minor', 'moderate', 'serious', 'critical'];

export interface OpenedPage {
  page: Page;
  context: BrowserContext;
  console: ConsoleEntry[];
  exceptions: string[];
  failedRequests: FailedRequest[];
  close(): Promise<void>;
}

export async function openPage(browser: Browser, opts: CaptureOptions, cfg: UiLoopConfig): Promise<OpenedPage> {
  const viewport = opts.viewport ?? cfg.viewport;
  const context = await browser.newContext({
    viewport,
    colorScheme: opts.darkMode ? 'dark' : 'light',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const consoleMap = new Map<string, ConsoleEntry>();
  const exceptions: string[] = [];
  const failedRequests: FailedRequest[] = [];

  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const key = `${type}:${msg.text()}`;
    const existing = consoleMap.get(key);
    if (existing) existing.count++;
    else consoleMap.set(key, { level: type, text: msg.text(), count: 1 });
  });
  page.on('pageerror', (err) => exceptions.push(err.message));
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push({ url: res.url(), status: res.status(), method: res.request().method() });
  });
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), status: 0, method: req.method() });
  });

  await page.goto(opts.url, { waitUntil: 'load', timeout: cfg.timeoutMs });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  if (typeof opts.waitFor === 'number') await page.waitForTimeout(opts.waitFor);
  else if (typeof opts.waitFor === 'string' && opts.waitFor) {
    await page.waitForSelector(opts.waitFor, { timeout: cfg.timeoutMs }).catch(() => undefined);
  }
  // Freeze animations so diffs are stable.
  await page.addStyleTag({ content: '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}' }).catch(() => undefined);

  return {
    page,
    context,
    get console() {
      return [...consoleMap.values()];
    },
    exceptions,
    failedRequests,
    close: () => context.close().catch(() => undefined),
  };
}

export async function collectWatchedRects(page: Page, selectors: string[]): Promise<WatchedRect[]> {
  return page.evaluate((sels: string[]) => {
    const out: { selector: string; box: { x: number; y: number; width: number; height: number } }[] = [];
    for (const sel of sels) {
      let nodes: Element[] = [];
      try {
        nodes = Array.from(document.querySelectorAll(sel)).slice(0, 20);
      } catch {
        continue;
      }
      nodes.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const id = el.id ? `#${el.id}` : nodes.length > 1 ? `${sel}:nth(${i})` : sel;
        out.push({ selector: id, box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } });
      });
    }
    return out;
  }, selectors);
}

export async function detectOverflow(page: Page): Promise<{ detected: boolean; scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => {
    const sw = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
    const iw = window.innerWidth;
    return { detected: sw > iw, scrollWidth: sw, innerWidth: iw };
  });
}

export async function runAxe(
  page: Page,
  minImpact: string,
  cap: number,
): Promise<{ violations: A11yViolation[]; total: number; impactThreshold: string; error?: string }> {
  try {
    await page.evaluate(getAxeSource());
    const minIdx = IMPACT_ORDER.indexOf(minImpact);
    const raw = (await page.evaluate(async () => {
      // @ts-expect-error axe injected at runtime
      const res = await window.axe.run(document, { resultTypes: ['violations'] });
      return res.violations.map((v: { id: string; impact: string | null; help: string; nodes: { html: string }[] }) => ({
        id: v.id,
        impact: v.impact ?? 'minor',
        help: v.help,
        nodes: v.nodes.length,
        sample: v.nodes[0]?.html,
      }));
    })) as A11yViolation[];
    const filtered = raw
      .filter((v) => IMPACT_ORDER.indexOf(v.impact) >= minIdx)
      .sort((a, b) => IMPACT_ORDER.indexOf(b.impact) - IMPACT_ORDER.indexOf(a.impact));
    return { violations: filtered.slice(0, cap), total: filtered.length, impactThreshold: minImpact };
  } catch (err) {
    return { violations: [], total: 0, impactThreshold: minImpact, error: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
  }
}

/** Nearest element hints for a list of points (page coordinates). */
export async function elementsAtPoints(page: Page, points: { x: number; y: number }[]): Promise<(ElementHint | undefined)[]> {
  return page.evaluate((pts: { x: number; y: number }[]) => {
    return pts.map((p) => {
      // elementFromPoint uses viewport coords; translate from page coords.
      const el = document.elementFromPoint(p.x - window.scrollX, p.y - window.scrollY);
      if (!el) return undefined;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const role = el.getAttribute('role') ?? undefined;
      return { tag: el.tagName.toLowerCase(), ...(role ? { role } : {}), ...(text ? { text } : {}) };
    });
  }, points);
}

export function buildSummary(
  opened: OpenedPage,
  opts: CaptureOptions,
  cfg: UiLoopConfig,
  extra: {
    title: string;
    finalUrl: string;
    image: { width: number; height: number; bytes: number };
    overflow: { detected: boolean; scrollWidth: number; innerWidth: number };
    watchedRects: WatchedRect[];
    a11y: CaptureSummary['a11y'];
  },
): CaptureSummary {
  const viewport = opts.viewport ?? cfg.viewport;
  return {
    id: newCaptureId(),
    label: slugify(opts.label ?? opts.url),
    url: opts.url,
    finalUrl: extra.finalUrl,
    title: extra.title,
    timestamp: new Date().toISOString(),
    viewport,
    fullPage: Boolean(opts.fullPage),
    image: extra.image,
    console: opened.console.slice(0, cfg.maxConsole * 2),
    exceptions: opened.exceptions.slice(0, cfg.maxConsole),
    failedRequests: opened.failedRequests.slice(0, cfg.maxFailedRequests * 2),
    horizontalOverflow: extra.overflow,
    watchedRects: extra.watchedRects,
    a11y: extra.a11y,
  };
}

export function boxCenter(b: Box): { x: number; y: number } {
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}
