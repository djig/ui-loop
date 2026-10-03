import { describe, expect, it } from 'vitest';
import { extractFilePath, formatHookOutput, HOOK_MAX_CHARS, runHook } from '../src/hook.js';
import type { CaptureOutput } from '../src/types.js';

const fakeOut = (text: string): CaptureOutput =>
  ({ text, images: [], budget: { maxTokens: 0, textTokens: 0, imageTokens: 0, totalTokens: 0, omittedRegions: [], omittedFull: false }, isFirstCapture: false, summary: {} as never });

const detect = async () => [{ url: 'http://localhost:3000', source: 'env' as const }];

describe('extractFilePath', () => {
  it('reads Claude Code tool_input.file_path', () => {
    expect(extractFilePath({ tool_name: 'Edit', tool_input: { file_path: '/p/app/page.tsx' } }, 'claude')).toBe('/p/app/page.tsx');
  });
  it('reads Cursor file_path', () => {
    expect(extractFilePath({ file_path: '/p/app/page.tsx', edits: [] }, 'cursor')).toBe('/p/app/page.tsx');
  });
  it('returns undefined for junk', () => {
    expect(extractFilePath(null, 'claude')).toBeUndefined();
    expect(extractFilePath({ tool_input: {} }, 'claude')).toBeUndefined();
  });
});

describe('runHook (Claude shape)', () => {
  it('is silent for non-UI files', async () => {
    const out = await runHook(JSON.stringify({ tool_input: { file_path: '/p/src/util.ts' } }), 'claude', { detect, runDiff: async () => fakeOut('x') });
    expect(out).toBeUndefined();
  });
  it('is silent when stdin is not JSON', async () => {
    expect(await runHook('nope', 'claude', { detect })).toBeUndefined();
  });
  it('is silent when no dev server is found', async () => {
    const out = await runHook(JSON.stringify({ tool_input: { file_path: '/p/app/page.tsx' } }), 'claude', { detect: async () => [], runDiff: async () => fakeOut('x') });
    expect(out).toBeUndefined();
  });
  it('runs a diff for the inferred route and emits PostToolUse JSON', async () => {
    let got: { url?: string; label?: string } = {};
    const out = await runHook(
      JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/p/app/(m)/pricing/page.tsx' }, cwd: '/p' }),
      'claude',
      { env: {}, detect, runDiff: async (o) => { got = o; return fakeOut('pixels changed: 1.2%'); } },
    );
    expect(got.url).toBe('http://localhost:3000/pricing');
    expect(got.label).toBe('/pricing');
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('pixels changed: 1.2%');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('http://localhost:3000/pricing');
  });
  it('bounds additionalContext to HOOK_MAX_CHARS and strips images', async () => {
    const out = await runHook(JSON.stringify({ tool_input: { file_path: '/p/app/page.tsx' } }), 'claude', {
      env: {}, detect, runDiff: async () => ({ ...fakeOut('y'.repeat(5000)), images: [{ data: 'AAAA', mimeType: 'image/png', width: 1, height: 1, tokens: 1, kind: 'full' }] }),
    });
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(HOOK_MAX_CHARS);
    expect(out).not.toContain('AAAA');
  });
  it('explains dynamic routes instead of guessing', async () => {
    const out = await runHook(JSON.stringify({ tool_input: { file_path: '/p/app/blog/[slug]/page.tsx' } }), 'claude', { env: {}, detect, runDiff: async () => { throw new Error('should not run'); } });
    expect(JSON.parse(out!).hookSpecificOutput.additionalContext).toMatch(/dynamic segment/);
  });
  it('honors UI_LOOP_ROUTE', async () => {
    let url = '';
    await runHook(JSON.stringify({ tool_input: { file_path: '/p/app/blog/[slug]/page.tsx' } }), 'claude', { env: { UI_LOOP_ROUTE: '/blog/hello' }, detect, runDiff: async (o) => { url = o.url; return fakeOut('ok'); } });
    expect(url).toBe('http://localhost:3000/blog/hello');
  });
  it('never throws when the diff fails', async () => {
    const logs: string[] = [];
    const out = await runHook(JSON.stringify({ tool_input: { file_path: '/p/app/page.tsx' } }), 'claude', { env: {}, detect, runDiff: async () => { throw new Error('browser exploded'); }, log: (l) => logs.push(l) });
    expect(out).toBeUndefined();
    expect(logs.join()).toContain('browser exploded');
  });
  it('respects UI_LOOP_HOOK_DISABLED', async () => {
    expect(await runHook(JSON.stringify({ tool_input: { file_path: '/p/app/page.tsx' } }), 'claude', { env: { UI_LOOP_HOOK_DISABLED: '1' }, detect })).toBeUndefined();
  });
});

describe('runHook (Cursor shape)', () => {
  it('emits additional_context', async () => {
    const out = await runHook(JSON.stringify({ file_path: '/p/src/App.css', edits: [] }), 'cursor', { env: {}, detect, runDiff: async () => fakeOut('cursor diff') });
    const parsed = JSON.parse(out!);
    expect(parsed).toEqual({ additional_context: expect.stringContaining('cursor diff') });
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });
});

describe('formatHookOutput', () => {
  it('truncates long context with a marker', () => {
    const s = JSON.parse(formatHookOutput('cursor', 'z'.repeat(3000))).additional_context as string;
    expect(s.length).toBeLessThanOrEqual(HOOK_MAX_CHARS);
    expect(s.endsWith('…(truncated)')).toBe(true);
  });
});
