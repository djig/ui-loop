import type { BudgetReport, ImagePart } from './types.js';

/**
 * Anthropic's published approximation: tokens ≈ (width * height) / 750.
 * Other models bill images differently (OpenAI tiles at 512px, Gemini at 258
 * tokens per tile); treat this as an upper-bound heuristic, not an invoice.
 */
export function estimateImageTokens(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  return Math.ceil((width * height) / 750);
}

/** Rough text estimate: ~4 chars per token. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Largest scale factor (≤ 1) such that an image of `width`×`height`
 * fits inside `tokens`. Returns 0 if even a 1px image would not fit.
 */
export function scaleToFitTokens(width: number, height: number, tokens: number): number {
  if (tokens <= 0 || width <= 0 || height <= 0) return 0;
  const current = estimateImageTokens(width, height);
  if (current <= tokens) return 1;
  // tokens ≈ w*h*s^2/750  →  s = sqrt(tokens*750/(w*h))
  const s = Math.sqrt((tokens * 750) / (width * height));
  // Shave a hair so rounding does not push us over.
  return Math.max(0, s * 0.98);
}

export interface Candidate<T> {
  item: T;
  tokens: number;
  /** Larger = more important. Included in descending order. */
  priority: number;
}

export interface AllocationResult<T> {
  included: T[];
  omitted: T[];
  used: number;
}

/**
 * Greedy allocation: sort by priority desc and include while the running
 * total stays within `budget`. Items that do not fit are skipped (not
 * truncated); the caller decides whether to downscale them.
 */
export function allocate<T>(candidates: Candidate<T>[], budget: number): AllocationResult<T> {
  const sorted = [...candidates].sort((a, b) => b.priority - a.priority);
  const included: T[] = [];
  const omitted: T[] = [];
  let used = 0;
  for (const c of sorted) {
    if (c.tokens > 0 && used + c.tokens <= budget) {
      included.push(c.item);
      used += c.tokens;
    } else {
      omitted.push(c.item);
    }
  }
  return { included, omitted, used };
}

export function makeBudgetReport(
  maxTokens: number,
  text: string,
  images: ImagePart[],
  omittedRegions: number[],
  omittedFull: boolean,
): BudgetReport {
  const textTokens = estimateTextTokens(text);
  const imageTokens = images.reduce((n, i) => n + i.tokens, 0);
  return {
    maxTokens,
    textTokens,
    imageTokens,
    totalTokens: textTokens + imageTokens,
    omittedRegions,
    omittedFull,
  };
}

/** Human line describing omissions, or empty string when nothing was omitted. */
export function omissionNote(report: BudgetReport, label: string): string {
  const parts: string[] = [];
  if (report.omittedRegions.length > 0) {
    const n = report.omittedRegions.length;
    parts.push(
      `${n} more region${n === 1 ? '' : 's'} omitted (${report.omittedRegions.join(', ')}); ` +
        `call ui_region with label "${label}" and region index to fetch.`,
    );
  }
  if (report.omittedFull) {
    parts.push('Full screenshot omitted: no budget left after summary. Raise maxTokens or use includeFull on a dedicated call.');
  }
  return parts.join(' ');
}
