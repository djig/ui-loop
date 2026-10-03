import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaptureStore, slugify } from '../src/store.js';
import type { CaptureSummary } from '../src/types.js';

const summary = (id: string, label: string): CaptureSummary => ({
  id, label, url: 'u', finalUrl: 'u', title: 't', timestamp: id, viewport: { width: 1, height: 1 }, fullPage: false,
  image: { width: 1, height: 1, bytes: 1 }, console: [], exceptions: [], failedRequests: [],
  horizontalOverflow: { detected: false, scrollWidth: 1, innerWidth: 1 }, watchedRects: [], a11y: { violations: [], total: 0, impactThreshold: 'serious' },
});

describe('slugify', () => {
  it('uses the URL path', () => {
    expect(slugify('http://localhost:3000/Settings/Profile?tab=2')).toBe('settings-profile-tab-2');
    expect(slugify('http://localhost:3000/')).toBe('root');
    expect(slugify('My Label!')).toBe('my-label');
  });
});

describe('CaptureStore eviction', () => {
  it('keeps at most N per label and forgets', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'uil-store-'));
    const store = new CaptureStore(cwd);
    for (let i = 0; i < 7; i++) await store.save(summary(`2026-01-0${i + 1}T00-00-00-000Z`, 'home'), Buffer.from('png'), 3);
    const list = await store.list('home');
    expect(list.map((c) => c.id)).toEqual(['2026-01-05T00-00-00-000Z', '2026-01-06T00-00-00-000Z', '2026-01-07T00-00-00-000Z']);
    expect((await store.latest('home'))?.id).toBe('2026-01-07T00-00-00-000Z');
    expect((await store.labels()).map((l) => l.label)).toEqual(['home']);
    expect(await store.forget('home')).toEqual(['home']);
    expect(await store.list('home')).toEqual([]);
    expect(await store.forget()).toEqual([]);
  });
});
