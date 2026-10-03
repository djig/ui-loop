import type { BudgetReport, CaptureSummary, DiffResult } from './types.js';
import { omissionNote } from './budget.js';

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtBox(b: { x: number; y: number; width: number; height: number }): string {
  return `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)}`;
}

export interface FormatOptions {
  /** Max console lines. */
  maxConsole?: number;
  maxFailedRequests?: number;
  maxA11y?: number;
}

/** Shared “page health” block used by capture and diff. */
export function formatHealth(s: CaptureSummary, opts: FormatOptions = {}): string[] {
  const lines: string[] = [];
  const maxConsole = opts.maxConsole ?? 10;
  const maxReq = opts.maxFailedRequests ?? 10;
  const maxA11y = opts.maxA11y ?? 10;

  const errors = s.console.filter((c) => c.level === 'error');
  const warnings = s.console.filter((c) => c.level === 'warning');
  if (errors.length || warnings.length || s.exceptions.length) {
    lines.push(`console: ${errors.length} error(s), ${warnings.length} warning(s), ${s.exceptions.length} uncaught exception(s)`);
    for (const e of s.exceptions.slice(0, maxConsole)) lines.push(`  ✖ exception: ${trunc(e, 200)}`);
    for (const c of [...errors, ...warnings].slice(0, maxConsole)) {
      lines.push(`  ${c.level === 'error' ? '✖' : '⚠'} ${trunc(c.text, 200)}${c.count > 1 ? ` (×${c.count})` : ''}`);
    }
    const shown = Math.min(maxConsole, errors.length + warnings.length);
    if (errors.length + warnings.length > shown) lines.push(`  … ${errors.length + warnings.length - shown} more`);
  } else {
    lines.push('console: clean');
  }

  if (s.failedRequests.length) {
    lines.push(`failed requests: ${s.failedRequests.length}`);
    for (const r of s.failedRequests.slice(0, maxReq)) lines.push(`  ${r.status} ${r.method} ${trunc(r.url, 160)}`);
    if (s.failedRequests.length > maxReq) lines.push(`  … ${s.failedRequests.length - maxReq} more`);
  }

  if (s.horizontalOverflow.detected) {
    lines.push(`horizontal overflow: YES (scrollWidth ${s.horizontalOverflow.scrollWidth} > innerWidth ${s.horizontalOverflow.innerWidth})`);
  }

  if (s.a11y.error) {
    lines.push(`a11y: skipped (${s.a11y.error})`);
  } else if (s.a11y.total === 0) {
    lines.push(`a11y: no violations at impact ≥ ${s.a11y.impactThreshold}`);
  } else {
    lines.push(`a11y: ${s.a11y.total} violation(s) at impact ≥ ${s.a11y.impactThreshold}`);
    for (const v of s.a11y.violations.slice(0, maxA11y)) {
      lines.push(`  [${v.impact}] ${v.id}: ${trunc(v.help, 100)} (${v.nodes} node${v.nodes === 1 ? '' : 's'})${v.sample ? ` e.g. ${trunc(v.sample, 80)}` : ''}`);
    }
    if (s.a11y.total > maxA11y) lines.push(`  … ${s.a11y.total - maxA11y} more`);
  }
  return lines;
}

export function formatCapture(s: CaptureSummary, budget: BudgetReport, isFirst: boolean, opts: FormatOptions = {}): string {
  const lines: string[] = [];
  lines.push(`ui_capture ${s.label} (${s.id})${isFirst ? ' — first capture, saved as baseline' : ' — saved as new baseline'}`);
  lines.push(`title: ${trunc(s.title || '(none)', 120)}`);
  lines.push(`url: ${s.finalUrl}${s.finalUrl !== s.url ? ` (requested ${s.url})` : ''}`);
  lines.push(`viewport: ${s.viewport.width}×${s.viewport.height}${s.fullPage ? ` fullPage ${s.image.width}×${s.image.height}` : ''}`);
  lines.push(...formatHealth(s, opts));
  const note = omissionNote(budget, s.label);
  lines.push(`budget: ~${budget.totalTokens}/${budget.maxTokens} tokens (text ${budget.textTokens}, images ${budget.imageTokens})${note ? '. ' + note : ''}`);
  return lines.join('\n');
}

export function formatDiff(s: CaptureSummary, d: DiffResult, budget: BudgetReport, opts: FormatOptions = {}): string {
  const lines: string[] = [];
  lines.push(`ui_diff ${s.label}: ${d.baselineId} → ${d.currentId}`);
  lines.push(`title: ${trunc(s.title || '(none)', 120)}`);
  lines.push(`url: ${s.finalUrl}`);
  if (d.dimensionsChanged) lines.push('page size changed between captures (fullPage height differs?)');
  if (d.changedPixels === 0) {
    lines.push('pixels changed: 0 — visually identical to baseline');
  } else {
    lines.push(`pixels changed: ${d.percentChanged.toFixed(2)}% (${d.changedPixels}/${d.totalPixels}) in ${d.regions.length} region(s)`);
    for (const r of d.regions) {
      const el = r.element ? ` near <${r.element.tag}${r.element.role ? ` role=${r.element.role}` : ''}>${r.element.text ? ` "${trunc(r.element.text, 60)}"` : ''}` : '';
      lines.push(`  #${r.index} [${fmtBox(r.box)}] ${r.changedPixels}px${el}`);
    }
  }
  if (d.layoutShifts.length) {
    lines.push(`layout shifts: ${d.layoutShifts.length}`);
    for (const l of d.layoutShifts.slice(0, 10)) lines.push(`  ${l.selector}: ${fmtBox(l.from)} → ${fmtBox(l.to)}`);
  }
  lines.push(...formatHealth(s, opts));
  const note = omissionNote(budget, s.label);
  lines.push(`budget: ~${budget.totalTokens}/${budget.maxTokens} tokens (text ${budget.textTokens}, images ${budget.imageTokens})${note ? '. ' + note : ''}`);
  return lines.join('\n');
}

/** Bounded plain-text for hooks: no images, ≤ maxChars. */
export function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = '\n…(truncated)';
  return text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd() + suffix;
}
