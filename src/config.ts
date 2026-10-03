import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Viewport } from './types.js';

export interface UiLoopConfig {
  /** Max captures kept per label. Default 5. */
  keepPerLabel: number;
  /** Default token budget per tool call. Default 4000. */
  maxTokens: number;
  /** Longest side of a region crop in px. Default 512. */
  maxCropSide: number;
  /** Padding around a region crop in px. Default 16. */
  cropPadding: number;
  /** Max regions reported per diff. Default 8. */
  maxRegions: number;
  /** Default viewport. */
  viewport: Viewport;
  /** Selectors tracked for layout shifts. */
  watchSelectors: string[];
  /** Minimum axe impact reported. */
  a11yImpact: 'minor' | 'moderate' | 'serious' | 'critical';
  /** Max console entries in summary. */
  maxConsole: number;
  /** Max failed requests in summary. */
  maxFailedRequests: number;
  /** Max a11y violations in summary. */
  maxA11y: number;
  /** pixelmatch threshold 0..1. */
  diffThreshold: number;
  /** Navigation timeout ms. */
  timeoutMs: number;
}

export const DEFAULT_CONFIG: UiLoopConfig = {
  keepPerLabel: 5,
  maxTokens: 4000,
  maxCropSide: 512,
  cropPadding: 16,
  maxRegions: 8,
  viewport: { width: 1280, height: 800 },
  watchSelectors: ['h1', 'h2', 'nav', 'main', 'button', '[role=dialog]'],
  a11yImpact: 'serious',
  maxConsole: 10,
  maxFailedRequests: 10,
  maxA11y: 10,
  diffThreshold: 0.1,
  timeoutMs: 30_000,
};

export const CONFIG_FILENAME = 'ui-loop.config.json';
export const STORE_DIR = '.ui-loop';

/**
 * Load `ui-loop.config.json` from `cwd` (if present) merged over defaults,
 * then apply environment overrides. Never throws: a malformed file is ignored.
 */
export function loadConfig(cwd: string = process.cwd()): UiLoopConfig {
  let fileConfig: Partial<UiLoopConfig> = {};
  const path = join(cwd, CONFIG_FILENAME);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') fileConfig = parsed as Partial<UiLoopConfig>;
    } catch {
      // ignore malformed config
    }
  }
  const cfg: UiLoopConfig = { ...DEFAULT_CONFIG, ...fileConfig };
  cfg.viewport = { ...DEFAULT_CONFIG.viewport, ...(fileConfig.viewport ?? {}) };
  if (!Array.isArray(cfg.watchSelectors)) cfg.watchSelectors = DEFAULT_CONFIG.watchSelectors;

  const envInt = (name: string): number | undefined => {
    const v = process.env[name];
    if (!v) return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  cfg.keepPerLabel = envInt('UI_LOOP_KEEP') ?? cfg.keepPerLabel;
  cfg.maxTokens = envInt('UI_LOOP_MAX_TOKENS') ?? cfg.maxTokens;
  cfg.maxCropSide = envInt('UI_LOOP_MAX_CROP_SIDE') ?? cfg.maxCropSide;
  cfg.timeoutMs = envInt('UI_LOOP_TIMEOUT_MS') ?? cfg.timeoutMs;
  return cfg;
}
