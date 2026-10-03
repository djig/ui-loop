import type { Browser } from 'playwright-core';
import { loadConfig, type UiLoopConfig } from './config.js';
import { getSharedBrowser } from './browser.js';
import { CaptureStore, slugify, type StoredCapture } from './store.js';
import { allocate, estimateImageTokens, estimateTextTokens, makeBudgetReport, scaleToFitTokens } from './budget.js';
import { crop, decodePng, diffImages, downscale, encodePng, fitLongestSide, type RawImage } from './image.js';
import { clusterRegions, padBox } from './regions.js';
import { boxCenter, buildSummary, collectWatchedRects, detectOverflow, elementsAtPoints, openPage, runAxe } from './page.js';
import { formatCapture, formatDiff } from './summary.js';
import type {
  Box,
  CaptureOptions,
  CaptureOutput,
  CaptureSummary,
  DiffOptions,
  DiffRegion,
  DiffResult,
  ImagePart,
  LayoutShift,
} from './types.js';

export interface EngineDeps {
  browser?: Browser;
  config?: UiLoopConfig;
}

interface Shot {
  summary: CaptureSummary;
  png: Buffer;
  raw: RawImage;
  regionHints?: (DiffRegion['element'] | undefined)[];
}

async function takeShot(
  opts: CaptureOptions,
  cfg: UiLoopConfig,
  browser: Browser,
  afterShot?: (opened: Awaited<ReturnType<typeof openPage>>, raw: RawImage) => Promise<void>,
): Promise<Shot> {
  const opened = await openPage(browser, opts, cfg);
  try {
    const png = await opened.page.screenshot({ fullPage: Boolean(opts.fullPage), type: 'png' });
    const raw = decodePng(png);
    const [title, overflow, watchedRects, a11y] = await Promise.all([
      opened.page.title(),
      detectOverflow(opened.page),
      collectWatchedRects(opened.page, opts.watchSelectors ?? cfg.watchSelectors),
      runAxe(opened.page, opts.a11yImpact ?? cfg.a11yImpact, cfg.maxA11y * 2),
    ]);
    const summary = buildSummary(opened, opts, cfg, {
      title,
      finalUrl: opened.page.url(),
      image: { width: raw.width, height: raw.height, bytes: png.length },
      overflow,
      watchedRects,
      a11y,
    });
    if (afterShot) await afterShot(opened, raw);
    return { summary, png, raw };
  } finally {
    await opened.close();
  }
}

function toImagePart(img: RawImage, kind: ImagePart['kind'], regionIndex?: number): ImagePart {
  return {
    data: encodePng(img).toString('base64'),
    mimeType: 'image/png',
    width: img.width,
    height: img.height,
    tokens: estimateImageTokens(img.width, img.height),
    kind,
    ...(regionIndex !== undefined ? { regionIndex } : {}),
  };
}

/** Fit a full screenshot into `remaining` tokens; returns undefined if impossible. */
function fitFull(raw: RawImage, remaining: number): ImagePart | undefined {
  const s = scaleToFitTokens(raw.width, raw.height, remaining);
  if (s <= 0) return undefined;
  const scaled = downscale(raw, s);
  if (Math.max(scaled.width, scaled.height) < 64) return undefined; // useless thumbnail
  return toImagePart(scaled, 'full');
}

/**
 * Capture a page: screenshot + structured summary, saved as the new baseline
 * for the label. Returns the image only on the first capture of a label or
 * when `includeFull` is set.
 */
export async function capture(opts: CaptureOptions, deps: EngineDeps = {}): Promise<CaptureOutput> {
  const cfg = deps.config ?? loadConfig(opts.cwd);
  const browser = deps.browser ?? (await getSharedBrowser());
  const store = new CaptureStore(opts.cwd);
  const label = slugify(opts.label ?? opts.url);
  const isFirst = (await store.list(label)).length === 0;
  const maxTokens = opts.maxTokens ?? cfg.maxTokens;

  const shot = await takeShot({ ...opts, label }, cfg, browser);
  await store.save(shot.summary, shot.png, cfg.keepPerLabel);

  const wantFull = Boolean(opts.includeFull) || isFirst;
  // Format once with a placeholder budget to size the text, then finalize.
  let text = formatCapture(shot.summary, makeBudgetReport(maxTokens, '', [], [], false), isFirst, cfg);
  const images: ImagePart[] = [];
  let omittedFull = false;
  if (wantFull) {
    const remaining = maxTokens - estimateTextTokens(text) - 40;
    const part = fitFull(shot.raw, remaining);
    if (part) images.push(part);
    else omittedFull = true;
  }
  let budget = makeBudgetReport(maxTokens, text, images, [], omittedFull);
  text = formatCapture(shot.summary, budget, isFirst, cfg);
  budget = makeBudgetReport(maxTokens, text, images, [], omittedFull);
  return { summary: shot.summary, text, images, budget, isFirstCapture: isFirst };
}

function layoutShifts(prev: CaptureSummary, cur: CaptureSummary): LayoutShift[] {
  const prevMap = new Map(prev.watchedRects.map((r) => [r.selector, r.box]));
  const out: LayoutShift[] = [];
  for (const r of cur.watchedRects) {
    const p = prevMap.get(r.selector);
    if (!p) continue;
    const moved = Math.abs(p.x - r.box.x) > 1 || Math.abs(p.y - r.box.y) > 1 || Math.abs(p.width - r.box.width) > 1 || Math.abs(p.height - r.box.height) > 1;
    if (moved) out.push({ selector: r.selector, from: p, to: r.box });
  }
  return out;
}

/**
 * Capture again and diff against the baseline for `label`. Returns the text
 * summary plus region crops that fit the token budget (largest first).
 */
export async function diff(opts: DiffOptions, deps: EngineDeps = {}): Promise<CaptureOutput> {
  const cfg = deps.config ?? loadConfig(opts.cwd);
  const store = new CaptureStore(opts.cwd);
  const label = slugify(opts.label ?? opts.url);
  const maxTokens = opts.maxTokens ?? cfg.maxTokens;

  let baseline: StoredCapture | undefined;
  if (opts.baseline && opts.baseline !== 'previous') {
    baseline = await store.get(label, opts.baseline);
    if (!baseline) throw new Error(`No capture "${opts.baseline}" under label "${label}". Call ui_list.`);
  } else {
    baseline = await store.latest(label);
  }
  if (!baseline) {
    const out = await capture({ ...opts, label }, deps);
    out.text = `No baseline existed for label "${label}"; captured one instead. Edit, then call ui_diff again.\n` + out.text;
    out.budget = makeBudgetReport(maxTokens, out.text, out.images, [], out.budget.omittedFull);
    return out;
  }

  const browser = deps.browser ?? (await getSharedBrowser());
  const baseSummary = await store.readSummary(baseline);
  const baseRaw = decodePng(await store.readPng(baseline));

  // Reuse the baseline's viewport unless the caller overrides it.
  const shotOpts: CaptureOptions = { ...opts, label, viewport: opts.viewport ?? baseSummary.viewport };
  let hints: (DiffRegion['element'] | undefined)[] = [];
  let pixel: ReturnType<typeof diffImages> | undefined;
  let regionsRaw: ReturnType<typeof clusterRegions> = [];

  const shot = await takeShot(shotOpts, cfg, browser, async (opened, raw) => {
    pixel = diffImages(baseRaw, raw, cfg.diffThreshold);
    regionsRaw = clusterRegions(pixel.mask, pixel.width, pixel.height, { maxRegions: cfg.maxRegions });
    if (regionsRaw.length) {
      hints = await elementsAtPoints(opened.page, regionsRaw.map((r) => boxCenter(r))).catch(() => []);
    }
  });
  const px = pixel!;

  const regions: DiffRegion[] = regionsRaw.map((r, i) => ({
    index: i,
    box: { x: r.x, y: r.y, width: r.width, height: r.height },
    changedPixels: r.changedPixels,
    ...(hints[i] ? { element: hints[i] } : {}),
  }));
  shot.summary.diffRegions = regions;
  shot.summary.diffBaselineId = baseline.id;
  await store.save(shot.summary, shot.png, cfg.keepPerLabel);

  const result: DiffResult = {
    baselineId: baseline.id,
    currentId: shot.summary.id,
    percentChanged: px.total ? (px.changed / px.total) * 100 : 0,
    changedPixels: px.changed,
    totalPixels: px.total,
    dimensionsChanged: px.dimensionsChanged,
    regions,
    layoutShifts: layoutShifts(baseSummary, shot.summary),
  };

  // Text first (always). Then crops by area desc within remaining budget.
  let text = formatDiff(shot.summary, result, makeBudgetReport(maxTokens, '', [], [], false), cfg);
  const remainingForImages = Math.max(0, maxTokens - estimateTextTokens(text) - 60);

  const crops = regions.map((r) => {
    const padded = padBox(r.box, cfg.cropPadding, shot.raw.width, shot.raw.height);
    const img = fitLongestSide(crop(shot.raw, padded), cfg.maxCropSide);
    return { region: r, img, tokens: estimateImageTokens(img.width, img.height) };
  });
  const alloc = allocate(
    crops.map((c) => ({ item: c, tokens: c.tokens, priority: c.region.box.width * c.region.box.height })),
    remainingForImages,
  );
  const images: ImagePart[] = alloc.included
    .sort((a, b) => a.region.index - b.region.index)
    .map((c) => toImagePart(c.img, 'region', c.region.index));
  const omittedRegions = alloc.omitted.map((c) => c.region.index).sort((a, b) => a - b);

  let omittedFull = false;
  if (opts.includeFull) {
    const used = images.reduce((n, i) => n + i.tokens, 0);
    const part = fitFull(shot.raw, remainingForImages - used);
    if (part) images.push(part);
    else omittedFull = true;
  }

  let budget = makeBudgetReport(maxTokens, text, images, omittedRegions, omittedFull);
  text = formatDiff(shot.summary, result, budget, cfg);
  budget = makeBudgetReport(maxTokens, text, images, omittedRegions, omittedFull);
  return { summary: shot.summary, text, images, budget, isFirstCapture: false, diff: result };
}

export interface RegionOptions {
  label: string;
  captureId?: string;
  /** Region box in page px, or an index into the capture's stored diff regions. */
  region: Box | number;
  maxTokens?: number;
  cwd?: string;
  /** Longest side cap for this fetch; default 1024. */
  maxSide?: number;
}

/** Fetch one crop from a stored capture at higher resolution. */
export async function region(opts: RegionOptions): Promise<{ image: ImagePart; text: string; captureId: string }> {
  const store = new CaptureStore(opts.cwd);
  const cap = opts.captureId ? await store.get(opts.label, opts.captureId) : await store.latest(opts.label);
  if (!cap) throw new Error(`No capture for label "${slugify(opts.label)}". Call ui_list.`);
  const raw = decodePng(await store.readPng(cap));
  const maxTokens = opts.maxTokens ?? 2000;
  let box: Box;
  let regionIndex: number | undefined;
  if (typeof opts.region === 'number') {
    const summary = await store.readSummary(cap);
    const r = summary.diffRegions?.[opts.region];
    if (!r) {
      throw new Error(
        `Capture ${cap.id} has ${summary.diffRegions?.length ?? 0} stored diff region(s); index ${opts.region} is out of range. Pass a box {x,y,width,height} instead.`,
      );
    }
    box = padBox(r.box, 24, raw.width, raw.height);
    regionIndex = opts.region;
  } else {
    box = opts.region;
  }
  let img = fitLongestSide(crop(raw, box), opts.maxSide ?? 1024);
  const s = scaleToFitTokens(img.width, img.height, Math.max(1, maxTokens - 50));
  if (s < 1) img = downscale(img, s);
  const image = toImagePart(img, 'region', regionIndex);
  const text = `ui_region ${cap.label} ${cap.id}${regionIndex !== undefined ? ` #${regionIndex}` : ''} box ${box.x},${box.y} ${box.width}×${box.height} → ${img.width}×${img.height} (~${image.tokens} tokens)`;
  return { image, text, captureId: cap.id };
}
