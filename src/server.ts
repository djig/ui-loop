import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { capture, diff, region } from './capture.js';
import { assert } from './assert.js';
import { detectDevServer } from './detect.js';
import { CaptureStore } from './store.js';
import { closeSharedBrowser } from './browser.js';
import { loadConfig } from './config.js';
import type { CaptureOutput } from './types.js';

const viewportSchema = z.object({ width: z.number().int().min(200).max(4000), height: z.number().int().min(200).max(4000) }).optional();
const waitForSchema = z.union([z.string(), z.number().int().min(0).max(30_000)]).optional().describe('CSS selector to wait for, or ms to wait');
const maxTokensSchema = z.number().int().min(200).max(50_000).optional().describe('Token budget for this response (text + images). Default 4000.');

const commonShape = {
  url: z.string().url().describe('Page URL, e.g. http://localhost:3000/settings'),
  label: z.string().optional().describe('Baseline label. Defaults to a slug of the URL path. Keep one label per route.'),
  viewport: viewportSchema,
  waitFor: waitForSchema,
  fullPage: z.boolean().optional().describe('Capture the full scrollable page (bigger, costlier). Default false.'),
  includeFull: z.boolean().optional().describe('Also return the full screenshot (downscaled to budget). Default false.'),
  maxTokens: maxTokensSchema,
  darkMode: z.boolean().optional().describe('Emulate prefers-color-scheme: dark.'),
};

type Content = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }>;

function toContent(out: CaptureOutput): Content {
  const content: Content = [{ type: 'text', text: out.text }];
  for (const img of out.images) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  return content;
}

function structured(out: CaptureOutput): Record<string, unknown> {
  return {
    captureId: out.summary.id,
    label: out.summary.label,
    url: out.summary.finalUrl,
    title: out.summary.title,
    isFirstCapture: out.isFirstCapture,
    budget: out.budget,
    console: out.summary.console,
    exceptions: out.summary.exceptions,
    failedRequests: out.summary.failedRequests,
    horizontalOverflow: out.summary.horizontalOverflow,
    a11y: out.summary.a11y,
    ...(out.diff ? { diff: { ...out.diff } } : {}),
    images: out.images.map((i) => ({ kind: i.kind, regionIndex: i.regionIndex, width: i.width, height: i.height, tokens: i.tokens })),
  };
}

function errorResult(err: unknown) {
  return { isError: true as const, content: [{ type: 'text' as const, text: `ui-loop error: ${err instanceof Error ? err.message : String(err)}` }] };
}

export function createServer(cwd: string = process.cwd()): McpServer {
  const server = new McpServer({ name: 'ui-loop', version: '0.1.0' });
  const cfg = loadConfig(cwd);

  server.registerTool(
    'ui_capture',
    {
      title: 'Capture UI baseline',
      description:
        'Screenshot a page and save it as the baseline for its label. Returns a compact text summary (title, console errors, failed requests, overflow, a11y violations). ' +
        'The image is returned only on the first capture of a label or when includeFull=true. Call this BEFORE editing so ui_diff has something to compare against.',
      inputSchema: commonShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const out = await capture({ ...args, cwd }, { config: cfg });
        return { content: toContent(out), structuredContent: structured(out) };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'ui_diff',
    {
      title: 'Diff UI against baseline',
      description:
        'Re-capture a page, pixel-diff it against the baseline for its label, and return ONLY what changed: a text summary plus cropped images of changed regions (largest first) that fit within maxTokens. ' +
        'Omitted regions are listed so you can fetch them with ui_region. The new capture becomes the baseline. If no baseline exists, behaves like ui_capture.',
      inputSchema: { ...commonShape, baseline: z.string().optional().describe("'previous' (default) or a captureId from ui_list") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const out = await diff({ ...args, cwd }, { config: cfg });
        return { content: toContent(out), structuredContent: structured(out) };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'ui_region',
    {
      title: 'Fetch one region crop',
      description: 'Fetch a single crop from a stored capture at higher resolution. region is either a diff region index (from ui_diff output) or a box {x,y,width,height} in page pixels.',
      inputSchema: {
        label: z.string(),
        captureId: z.string().optional().describe('Defaults to the latest capture for the label'),
        region: z.union([z.number().int().min(0), z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })]),
        maxTokens: z.number().int().min(100).max(20_000).optional().describe('Default 2000'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const out = await region({ ...args, cwd });
        return {
          content: [{ type: 'text', text: out.text }, { type: 'image', data: out.image.data, mimeType: 'image/png' }],
          structuredContent: { captureId: out.captureId, width: out.image.width, height: out.image.height, tokens: out.image.tokens },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'ui_assert',
    {
      title: 'Assert page state',
      description:
        'Run cheap text-only checks against a live page: text present, element visible/hidden, element count, no console errors, no horizontal overflow, no a11y violations. Returns pass/fail with short evidence. Never returns images.',
      inputSchema: {
        url: z.string().url(),
        checks: z
          .array(
            z.object({
              type: z.enum(['text', 'visible', 'hidden', 'noConsoleErrors', 'noOverflow', 'a11y', 'count']),
              selector: z.string().optional(),
              text: z.string().optional(),
              min: z.number().int().optional(),
              max: z.number().int().optional(),
              impact: z.enum(['minor', 'moderate', 'serious', 'critical']).optional(),
            }),
          )
          .min(1),
        viewport: viewportSchema,
        waitFor: waitForSchema,
        darkMode: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const out = await assert({ ...args, cwd }, { config: cfg });
        return {
          content: [{ type: 'text', text: out.text }],
          structuredContent: { passed: out.passed, failed: out.failed, results: out.results },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'ui_list',
    {
      title: 'List stored captures',
      description: 'List labels and their stored captures (ids, sizes) under .ui-loop/captures.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const store = new CaptureStore(cwd);
      const labels = await store.labels();
      const lines = labels.length ? [] : ['no captures stored'];
      for (const l of labels) {
        lines.push(`${l.label}: ${l.captures.length} capture(s), ${(l.bytes / 1024).toFixed(0)} KB`);
        for (const c of l.captures) lines.push(`  ${c.id} (${(c.bytes / 1024).toFixed(0)} KB)`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { labels: labels.map((l) => ({ label: l.label, bytes: l.bytes, captures: l.captures.map((c) => ({ id: c.id, bytes: c.bytes })) })) },
      };
    },
  );

  server.registerTool(
    'ui_forget',
    {
      title: 'Forget captures',
      description: 'Delete stored captures for a label, or all labels when omitted.',
      inputSchema: { label: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ label }) => {
      const removed = await new CaptureStore(cwd).forget(label);
      return {
        content: [{ type: 'text', text: removed.length ? `forgot ${removed.join(', ')}` : 'nothing to forget' }],
        structuredContent: { removed },
      };
    },
  );

  server.registerTool(
    'ui_detect_dev_server',
    {
      title: 'Detect dev server',
      description: 'Find running local dev servers (UI_LOOP_URL env, Next.js .next/dev/lock, common ports 3000–3005/5173/4200/8080). Returns candidate base URLs.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const found = await detectDevServer({ cwd });
      const text = found.length
        ? found.map((f) => `${f.url} (${f.source}${f.detail ? `, ${f.detail}` : ''})`).join('\n')
        : 'no dev server detected on common ports; start one or set UI_LOOP_URL';
      return { content: [{ type: 'text', text }], structuredContent: { candidates: found } };
    },
  );

  return server;
}

export async function serve(cwd: string = process.cwd()): Promise<void> {
  const server = createServer(cwd);
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await closeSharedBrowser();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.connect(transport);
}
