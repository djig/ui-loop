import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { STORE_DIR } from './config.js';
import type { CaptureSummary } from './types.js';

export interface StoredCapture {
  id: string;
  label: string;
  pngPath: string;
  jsonPath: string;
  bytes: number;
  timestamp: string;
}

export interface LabelInfo {
  label: string;
  captures: StoredCapture[];
  bytes: number;
}

/** Turn a URL (or arbitrary string) into a safe label. */
export function slugify(input: string): string {
  let s = input;
  try {
    const u = new URL(input);
    s = u.pathname + (u.search ? '_' + u.search : '');
  } catch {
    // not a URL; use as-is
  }
  s = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'root';
}

export function newCaptureId(date = new Date()): string {
  // 2026-10-03T12-34-56-789Z : sortable and filesystem safe
  return date.toISOString().replace(/[:.]/g, '-');
}

export class CaptureStore {
  readonly root: string;

  constructor(cwd: string = process.cwd()) {
    this.root = resolve(cwd, STORE_DIR, 'captures');
  }

  labelDir(label: string): string {
    return join(this.root, slugify(label));
  }

  async save(summary: CaptureSummary, png: Buffer, keep: number): Promise<StoredCapture> {
    const dir = this.labelDir(summary.label);
    await fs.mkdir(dir, { recursive: true });
    const pngPath = join(dir, `${summary.id}.png`);
    const jsonPath = join(dir, `${summary.id}.json`);
    await fs.writeFile(pngPath, png);
    await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));
    await this.evict(summary.label, keep);
    return { id: summary.id, label: summary.label, pngPath, jsonPath, bytes: png.length, timestamp: summary.timestamp };
  }

  async list(label: string): Promise<StoredCapture[]> {
    const dir = this.labelDir(label);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: StoredCapture[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -'.json'.length);
      const pngPath = join(dir, `${id}.png`);
      let bytes = 0;
      try {
        bytes = (await fs.stat(pngPath)).size;
      } catch {
        continue; // orphan json
      }
      out.push({ id, label: slugify(label), pngPath, jsonPath: join(dir, n), bytes, timestamp: id });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async latest(label: string): Promise<StoredCapture | undefined> {
    const all = await this.list(label);
    return all[all.length - 1];
  }

  async get(label: string, id: string): Promise<StoredCapture | undefined> {
    const all = await this.list(label);
    return all.find((c) => c.id === id);
  }

  async readSummary(c: StoredCapture): Promise<CaptureSummary> {
    return JSON.parse(await fs.readFile(c.jsonPath, 'utf8')) as CaptureSummary;
  }

  async readPng(c: StoredCapture): Promise<Buffer> {
    return fs.readFile(c.pngPath);
  }

  /** Keep only the newest `keep` captures for a label. */
  async evict(label: string, keep: number): Promise<number> {
    const all = await this.list(label);
    const excess = all.slice(0, Math.max(0, all.length - Math.max(1, keep)));
    for (const c of excess) {
      await fs.rm(c.pngPath, { force: true });
      await fs.rm(c.jsonPath, { force: true });
    }
    return excess.length;
  }

  async labels(): Promise<LabelInfo[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return [];
    }
    const out: LabelInfo[] = [];
    for (const label of names.sort()) {
      const captures = await this.list(label);
      if (captures.length === 0) continue;
      out.push({ label, captures, bytes: captures.reduce((n, c) => n + c.bytes, 0) });
    }
    return out;
  }

  async forget(label?: string): Promise<string[]> {
    if (label) {
      const dir = this.labelDir(label);
      await fs.rm(dir, { recursive: true, force: true });
      return [slugify(label)];
    }
    const all = await this.labels();
    await fs.rm(this.root, { recursive: true, force: true });
    return all.map((l) => l.label);
  }
}
