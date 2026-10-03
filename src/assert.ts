import type { Browser } from 'playwright-core';
import { loadConfig, type UiLoopConfig } from './config.js';
import { getSharedBrowser } from './browser.js';
import { detectOverflow, openPage, runAxe } from './page.js';
import type { AssertCheck, AssertOutput, CheckResult, Viewport } from './types.js';

export interface AssertOptions {
  url: string;
  checks: AssertCheck[];
  viewport?: Viewport;
  waitFor?: string | number;
  darkMode?: boolean;
  cwd?: string;
}

function describe(c: AssertCheck): string {
  switch (c.type) {
    case 'text':
      return `text "${c.text}"${c.selector ? ` in ${c.selector}` : ''}`;
    case 'visible':
      return `visible ${c.selector}`;
    case 'hidden':
      return `hidden ${c.selector}`;
    case 'count':
      return `count ${c.selector}${c.min !== undefined ? ` ≥${c.min}` : ''}${c.max !== undefined ? ` ≤${c.max}` : ''}`;
    case 'noConsoleErrors':
      return 'no console errors';
    case 'noOverflow':
      return 'no horizontal overflow';
    case 'a11y':
      return `a11y impact ≥ ${c.impact ?? 'serious'}`;
  }
}

export function formatAssert(out: Omit<AssertOutput, 'text'>): string {
  const lines = [`ui_assert ${out.finalUrl}: ${out.passed} passed, ${out.failed} failed`];
  for (const r of out.results) lines.push(`  ${r.pass ? 'PASS' : 'FAIL'} ${describe(r.check)} — ${r.evidence}`);
  return lines.join('\n');
}

/** Run checks against a live page. Text-only; never returns images. */
export async function assert(opts: AssertOptions, deps: { browser?: Browser; config?: UiLoopConfig } = {}): Promise<AssertOutput> {
  const cfg = deps.config ?? loadConfig(opts.cwd);
  const browser = deps.browser ?? (await getSharedBrowser());
  const opened = await openPage(browser, { url: opts.url, viewport: opts.viewport, waitFor: opts.waitFor, darkMode: opts.darkMode }, cfg);
  const results: CheckResult[] = [];
  try {
    const { page } = opened;
    for (const check of opts.checks) {
      try {
        switch (check.type) {
          case 'text': {
            const needle = check.text ?? '';
            const loc = check.selector ? page.locator(check.selector) : page.locator('body');
            const texts = await loc.allInnerTexts();
            const hit = texts.some((t) => t.includes(needle));
            results.push({ check, pass: hit, evidence: hit ? 'found' : `not found in ${texts.length} element(s); sample: "${(texts[0] ?? '').replace(/\s+/g, ' ').slice(0, 80)}"` });
            break;
          }
          case 'visible':
          case 'hidden': {
            const loc = page.locator(check.selector ?? 'body');
            const n = await loc.count();
            let visible = false;
            for (let i = 0; i < Math.min(n, 20) && !visible; i++) visible = await loc.nth(i).isVisible();
            const pass = check.type === 'visible' ? visible : !visible;
            results.push({ check, pass, evidence: `${n} match(es), ${visible ? 'visible' : 'not visible'}` });
            break;
          }
          case 'count': {
            const n = await page.locator(check.selector ?? '*').count();
            const pass = (check.min === undefined || n >= check.min) && (check.max === undefined || n <= check.max);
            results.push({ check, pass, evidence: `${n} match(es)` });
            break;
          }
          case 'noConsoleErrors': {
            const errors = opened.console.filter((c) => c.level === 'error');
            const all = [...opened.exceptions, ...errors.map((e) => e.text)];
            results.push({ check, pass: all.length === 0, evidence: all.length ? `${all.length}: ${all[0]!.slice(0, 120)}` : 'clean' });
            break;
          }
          case 'noOverflow': {
            const o = await detectOverflow(page);
            results.push({ check, pass: !o.detected, evidence: `scrollWidth ${o.scrollWidth}, innerWidth ${o.innerWidth}` });
            break;
          }
          case 'a11y': {
            const a = await runAxe(page, check.impact ?? cfg.a11yImpact, 5);
            if (a.error) results.push({ check, pass: false, evidence: `axe failed: ${a.error}` });
            else results.push({ check, pass: a.total === 0, evidence: a.total ? `${a.total}: ${a.violations.map((v) => `${v.id}(${v.impact})`).join(', ')}` : 'no violations' });
            break;
          }
        }
      } catch (err) {
        results.push({ check, pass: false, evidence: `error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
      }
    }
    const passed = results.filter((r) => r.pass).length;
    const partial = { url: opts.url, finalUrl: page.url(), passed, failed: results.length - passed, results };
    return { ...partial, text: formatAssert(partial) };
  } finally {
    await opened.close();
  }
}

/**
 * Parse CLI `--check` strings. Grammar (one per flag):
 *   text=Hello[@selector]  visible=sel  hidden=sel  count=sel[:min[:max]]
 *   noConsoleErrors  noOverflow  a11y[=impact]
 */
export function parseCheck(spec: string): AssertCheck {
  const eq = spec.indexOf('=');
  const type = (eq === -1 ? spec : spec.slice(0, eq)).trim();
  const val = eq === -1 ? '' : spec.slice(eq + 1);
  switch (type) {
    case 'text': {
      const at = val.lastIndexOf('@');
      return at === -1 ? { type, text: val } : { type, text: val.slice(0, at), selector: val.slice(at + 1) };
    }
    case 'visible':
    case 'hidden':
      return { type, selector: val };
    case 'count': {
      const [sel, min, max] = val.split(':');
      const c: AssertCheck = { type, selector: sel };
      if (min) c.min = Number(min);
      if (max) c.max = Number(max);
      return c;
    }
    case 'noConsoleErrors':
    case 'noOverflow':
      return { type };
    case 'a11y':
      return val ? { type, impact: val as AssertCheck['impact'] } : { type };
    default:
      throw new Error(`Unknown check "${spec}". Use text=…[@sel], visible=sel, hidden=sel, count=sel[:min[:max]], noConsoleErrors, noOverflow, a11y[=impact]`);
  }
}
