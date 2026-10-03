import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectDevServer, parseNextLock } from '../src/detect.js';

describe('parseNextLock', () => {
  it('parses JSON with pid and port', () => {
    expect(parseNextLock('{"pid":123,"port":3000}')).toEqual({ pid: 123, port: 3000 });
  });
  it('parses string numbers', () => {
    expect(parseNextLock('{"port":"3001"}')).toEqual({ port: 3001 });
  });
  it('parses a bare port', () => {
    expect(parseNextLock('3002\n')).toEqual({ port: 3002 });
    expect(parseNextLock('3003')).toEqual({ port: 3003 });
  });
  it('returns undefined for junk', () => {
    expect(parseNextLock('')).toBeUndefined();
    expect(parseNextLock('{}')).toBeUndefined();
    expect(parseNextLock('not json at all')).toBeUndefined();
    expect(parseNextLock('{"port": 99999999}')).toEqual({ port: 99999999 }); // pass-through; probe decides
  });
});

describe('detectDevServer', () => {
  it('puts UI_LOOP_URL first without probing and dedupes', async () => {
    const probed: string[] = [];
    const found = await detectDevServer({
      cwd: mkdtempSync(join(tmpdir(), 'uil-')),
      env: { UI_LOOP_URL: 'http://localhost:3000/' },
      ports: [3000, 5173],
      probe: async (u) => {
        probed.push(u);
        return u.endsWith(':3000');
      },
    });
    expect(found).toEqual([{ url: 'http://localhost:3000', source: 'env' }]);
    expect(probed).not.toContain('http://localhost:3000/');
  });

  it('uses .next/dev/lock when the port answers', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'uil-'));
    mkdirSync(join(cwd, '.next', 'dev'), { recursive: true });
    writeFileSync(join(cwd, '.next', 'dev', 'lock'), JSON.stringify({ pid: 42, port: 3123 }));
    const found = await detectDevServer({ cwd, env: {}, ports: [], probe: async (u) => u.endsWith(':3123') });
    expect(found).toEqual([{ url: 'http://localhost:3123', source: 'next-lock', detail: 'pid 42' }]);
  });

  it('reports probed common ports', async () => {
    const found = await detectDevServer({ cwd: mkdtempSync(join(tmpdir(), 'uil-')), env: {}, ports: [3000, 5173, 8080], probe: async (u) => u.endsWith(':5173') });
    expect(found).toEqual([{ url: 'http://localhost:5173', source: 'port-scan' }]);
  });
});
