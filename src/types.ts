/** Shared types for ui-loop. */

export interface Viewport {
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConsoleEntry {
  level: 'error' | 'warning';
  text: string;
  count: number;
}

export interface FailedRequest {
  url: string;
  status: number;
  method: string;
}

export interface LayoutShift {
  selector: string;
  from: Box;
  to: Box;
}

export interface A11yViolation {
  id: string;
  impact: string;
  help: string;
  nodes: number;
  sample?: string;
}

export interface ElementHint {
  tag: string;
  role?: string;
  text?: string;
}

export interface WatchedRect {
  selector: string;
  box: Box;
}

/** JSON sidecar stored next to every capture PNG. */
export interface CaptureSummary {
  id: string;
  label: string;
  url: string;
  finalUrl: string;
  title: string;
  timestamp: string;
  viewport: Viewport;
  fullPage: boolean;
  image: { width: number; height: number; bytes: number };
  console: ConsoleEntry[];
  exceptions: string[];
  failedRequests: FailedRequest[];
  horizontalOverflow: { detected: boolean; scrollWidth: number; innerWidth: number };
  watchedRects: WatchedRect[];
  a11y: { violations: A11yViolation[]; total: number; impactThreshold: string; error?: string };
  /** Present when this capture was produced by ui_diff: regions vs the baseline. */
  diffRegions?: DiffRegion[];
  diffBaselineId?: string;
}

export interface DiffRegion {
  index: number;
  box: Box;
  changedPixels: number;
  element?: ElementHint;
}

export interface DiffResult {
  baselineId: string;
  currentId: string;
  percentChanged: number;
  changedPixels: number;
  totalPixels: number;
  dimensionsChanged: boolean;
  regions: DiffRegion[];
  layoutShifts: LayoutShift[];
}

export interface ImagePart {
  /** Base64-encoded PNG. */
  data: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  tokens: number;
  /** Which region index this crop represents, or 'full'. */
  kind: 'full' | 'region';
  regionIndex?: number;
}

export interface CaptureOptions {
  url: string;
  label?: string;
  viewport?: Viewport;
  /** CSS selector to wait for, or milliseconds to wait. */
  waitFor?: string | number;
  fullPage?: boolean;
  includeFull?: boolean;
  maxTokens?: number;
  darkMode?: boolean;
  watchSelectors?: string[];
  a11yImpact?: 'minor' | 'moderate' | 'serious' | 'critical';
  /** Project root; defaults to process.cwd(). */
  cwd?: string;
}

export interface DiffOptions extends CaptureOptions {
  baseline?: 'previous' | string;
}

export interface BudgetReport {
  maxTokens: number;
  textTokens: number;
  imageTokens: number;
  totalTokens: number;
  omittedRegions: number[];
  omittedFull: boolean;
}

export interface CaptureOutput {
  summary: CaptureSummary;
  text: string;
  images: ImagePart[];
  budget: BudgetReport;
  isFirstCapture: boolean;
  diff?: DiffResult;
}

export type CheckType =
  | 'text'
  | 'visible'
  | 'hidden'
  | 'noConsoleErrors'
  | 'noOverflow'
  | 'a11y'
  | 'count';

export interface AssertCheck {
  type: CheckType;
  selector?: string;
  text?: string;
  min?: number;
  max?: number;
  impact?: 'minor' | 'moderate' | 'serious' | 'critical';
}

export interface CheckResult {
  check: AssertCheck;
  pass: boolean;
  evidence: string;
}

export interface AssertOutput {
  url: string;
  finalUrl: string;
  passed: number;
  failed: number;
  results: CheckResult[];
  text: string;
}

export interface DevServerCandidate {
  url: string;
  source: 'env' | 'next-lock' | 'port-scan';
  detail?: string;
}
