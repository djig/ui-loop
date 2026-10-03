import { detectDevServer } from './detect.js';
import { isUiFile, routeForFile } from './routes.js';
import { boundText } from './summary.js';
import type { DiffOptions, CaptureOutput } from './types.js';

export const HOOK_MAX_CHARS = 1500;

/** Claude Code PostToolUse payload (subset). */
export interface ClaudeHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; [k: string]: unknown };
  cwd?: string;
}

/** Cursor afterFileEdit payload (subset). */
export interface CursorHookInput {
  file_path?: string;
  edits?: unknown[];
}

export type HookFlavor = 'claude' | 'cursor';

export interface HookDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  detect?: typeof detectDevServer;
  runDiff?: (opts: DiffOptions) => Promise<CaptureOutput>;
  /** Called with debug lines (stderr). */
  log?: (line: string) => void;
}

/** Extract the edited file path from either payload shape. Returns undefined if absent. */
export function extractFilePath(input: unknown, flavor: HookFlavor): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  if (flavor === 'cursor') {
    return typeof o.file_path === 'string' ? o.file_path : undefined;
  }
  const ti = o.tool_input;
  if (ti && typeof ti === 'object') {
    const fp = (ti as Record<string, unknown>).file_path;
    if (typeof fp === 'string') return fp;
  }
  // Some tools (MultiEdit) nest differently; fall back to top-level.
  return typeof o.file_path === 'string' ? o.file_path : undefined;
}

export function formatHookOutput(flavor: HookFlavor, context: string): string {
  const ctx = boundText(context, HOOK_MAX_CHARS);
  if (flavor === 'cursor') return JSON.stringify({ additional_context: ctx });
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx },
  });
}

/**
 * Core hook logic. Returns the JSON string to print, or undefined when the
 * hook should stay silent. Never throws.
 */
export async function runHook(rawStdin: string, flavor: HookFlavor, deps: HookDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => undefined);
  try {
    if (env.UI_LOOP_HOOK_DISABLED === '1') return undefined;
    let input: unknown;
    try {
      input = JSON.parse(rawStdin || '{}');
    } catch {
      log('ui-loop hook: stdin was not JSON');
      return undefined;
    }
    const filePath = extractFilePath(input, flavor);
    if (!filePath || !isUiFile(filePath)) return undefined;

    const cwd = deps.cwd ?? (typeof (input as ClaudeHookInput).cwd === 'string' ? (input as ClaudeHookInput).cwd! : process.cwd());
    const route = routeForFile(filePath, env, cwd);
    if (!route.route) {
      // Dynamic segment: tell the agent once, briefly, instead of guessing.
      return formatHookOutput(flavor, `ui-loop: skipped visual diff — ${route.note ?? 'no route'}.`);
    }

    const detect = deps.detect ?? detectDevServer;
    const servers = await detect({ cwd, env, timeoutMs: 600 });
    const base = servers[0];
    if (!base) return undefined;

    const url = base.url.replace(/\/$/, '') + route.route;
    const label = route.route;
    const runDiff = deps.runDiff ?? (await import('./capture.js')).diff;
    const out = await runDiff({ url, label, maxTokens: 1200, cwd });
    const header = `ui-loop: ${filePath} → ${url}`;
    return formatHookOutput(flavor, `${header}\n${out.text}`);
  } catch (err) {
    log(`ui-loop hook: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
