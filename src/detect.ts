import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { DevServerCandidate } from './types.js';

export const COMMON_PORTS = [3000, 3001, 3002, 3003, 3004, 3005, 5173, 4200, 8080];

/**
 * Parse the contents of Next.js `.next/dev/lock` (Next 15+). The format is
 * not a public contract, so parse defensively: accept JSON with `port`
 * and/or `pid`, or a bare port number.
 */
export function parseNextLock(contents: string): { port?: number; pid?: number } | undefined {
  const t = contents.trim();
  if (!t) return undefined;
  try {
    const j = JSON.parse(t) as unknown;
    if (j && typeof j === 'object') {
      const o = j as Record<string, unknown>;
      const port = numberish(o.port);
      const pid = numberish(o.pid);
      if (port === undefined && pid === undefined) return undefined;
      return { ...(port !== undefined ? { port } : {}), ...(pid !== undefined ? { pid } : {}) };
    }
    if (typeof j === 'number') return validPort(j) ? { port: j } : undefined;
  } catch {
    // not JSON
  }
  const n = Number.parseInt(t, 10);
  if (validPort(n)) return { port: n };
  return undefined;
}

function numberish(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return undefined;
}

function validPort(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n < 65536;
}

async function probe(url: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'manual' });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    }
    // Any HTTP answer means something is listening.
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export interface DetectOptions {
  cwd?: string;
  ports?: number[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Skip the network probe (for tests). */
  probe?: (url: string, timeoutMs: number) => Promise<boolean>;
}

/**
 * Find running dev servers. Sources, in order of confidence:
 * 1. `UI_LOOP_URL` env (always first, not probed)
 * 2. `.next/dev/lock` port (probed)
 * 3. Common ports on localhost (probed in parallel)
 */
export async function detectDevServer(opts: DetectOptions = {}): Promise<DevServerCandidate[]> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 800;
  const doProbe = opts.probe ?? probe;
  const out: DevServerCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: DevServerCandidate) => {
    const key = c.url.replace(/\/$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  if (env.UI_LOOP_URL) push({ url: env.UI_LOOP_URL.replace(/\/$/, ''), source: 'env' });

  try {
    const lock = await fs.readFile(join(cwd, '.next', 'dev', 'lock'), 'utf8');
    const parsed = parseNextLock(lock);
    if (parsed?.port) {
      const url = `http://localhost:${parsed.port}`;
      if (await doProbe(url, timeoutMs)) {
        push({ url, source: 'next-lock', detail: parsed.pid ? `pid ${parsed.pid}` : undefined });
      }
    }
  } catch {
    // no lock file
  }

  const ports = opts.ports ?? COMMON_PORTS;
  const results = await Promise.all(
    ports.map(async (p) => ({ p, ok: await doProbe(`http://localhost:${p}`, timeoutMs) })),
  );
  for (const r of results) if (r.ok) push({ url: `http://localhost:${r.p}`, source: 'port-scan' });

  return out;
}
