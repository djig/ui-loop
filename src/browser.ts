import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';

const SYSTEM_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export const CHROMIUM_HELP =
  'No Chromium found. Set UI_LOOP_CHROMIUM=/path/to/chrome, or run `npx playwright install chromium`, ' +
  'or install Google Chrome in a standard location.';

/**
 * Resolve a Chromium executable. Order: UI_LOOP_CHROMIUM env → playwright's
 * bundled chromium (if downloaded) → common system paths.
 */
export function resolveChromium(): string | undefined {
  const env = process.env.UI_LOOP_CHROMIUM;
  if (env && existsSync(env)) return env;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    // playwright may throw when browsers path is missing
  }
  for (const c of SYSTEM_CANDIDATES) if (existsSync(c)) return c;
  return undefined;
}

export async function launchBrowser(): Promise<Browser> {
  const executablePath = resolveChromium();
  if (!executablePath) throw new Error(CHROMIUM_HELP);
  try {
    return await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to launch Chromium at ${executablePath}: ${msg.split('\n')[0]}\n${CHROMIUM_HELP}`);
  }
}

/** Shared lazy browser so an MCP session reuses one process. */
let shared: Promise<Browser> | undefined;

export async function getSharedBrowser(): Promise<Browser> {
  if (!shared) {
    shared = launchBrowser().catch((e) => {
      shared = undefined;
      throw e;
    });
  }
  const b = await shared;
  if (!b.isConnected()) {
    shared = undefined;
    return getSharedBrowser();
  }
  return b;
}

export async function closeSharedBrowser(): Promise<void> {
  if (!shared) return;
  const b = await shared.catch(() => undefined);
  shared = undefined;
  await b?.close().catch(() => undefined);
}
