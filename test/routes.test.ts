import { describe, expect, it } from 'vitest';
import { inferNextRoute, isUiFile, routeForFile } from '../src/routes.js';

describe('inferNextRoute', () => {
  const cases: Array<[string, string | undefined, string?]> = [
    ['app/page.tsx', '/'],
    ['src/app/page.tsx', '/'],
    ['app/settings/page.tsx', '/settings'],
    ['app/(marketing)/pricing/page.tsx', '/pricing'],
    ['app/(auth)/(inner)/login/page.tsx', '/login'],
    ['app/dashboard/layout.tsx', '/dashboard'],
    ['app/dashboard/loading.tsx', '/dashboard'],
    ['app/blog/[slug]/page.tsx', undefined, 'dynamic'],
    ['app/docs/[...parts]/page.tsx', undefined, 'dynamic'],
    ['app/shop/[[...all]]/page.tsx', undefined, 'dynamic'],
    ['app/dashboard/_components/Chart.tsx', '/dashboard'],
    ['app/dashboard/@modal/page.tsx', '/dashboard'],
    ['app/settings/styles.module.css', '/settings'],
    ['app/globals.css', '/'],
    ['app/api/users/route.ts', undefined, 'route handler'],
    ['/abs/path/to/project/app/team/members/page.tsx', '/team/members'],
    ['C:\\proj\\src\\app\\about\\page.tsx', '/about'],
  ];
  for (const [file, route, noteStart] of cases) {
    it(`${file} → ${route ?? `skip (${noteStart})`}`, () => {
      const g = inferNextRoute(file);
      expect(g.route).toBe(route);
      if (noteStart) expect(g.note ?? '').toContain(noteStart);
    });
  }

  it('returns a note for files outside app/', () => {
    const g = inferNextRoute('src/components/Button.tsx');
    expect(g.route).toBeUndefined();
    expect(g.note).toContain('not under app/');
  });

  it('resolves relative to cwd when given', () => {
    expect(inferNextRoute('/repo/app/foo/page.tsx', '/repo').route).toBe('/foo');
  });
});

describe('routeForFile', () => {
  it('prefers UI_LOOP_ROUTE', () => {
    expect(routeForFile('app/blog/[slug]/page.tsx', { UI_LOOP_ROUTE: 'blog/hello' }).route).toBe('/blog/hello');
  });
  it('falls back to / for non-Next files', () => {
    expect(routeForFile('src/components/Button.tsx', {}).route).toBe('/');
  });
  it('skips dynamic segments with a note', () => {
    const g = routeForFile('app/blog/[slug]/page.tsx', {});
    expect(g.route).toBeUndefined();
    expect(g.note).toMatch(/dynamic segment \[slug\]/);
  });
});

describe('isUiFile', () => {
  it.each(['a.tsx', 'b.jsx', 'c.css', 'd.scss', 'e.mdx', 'F.TSX'])('%s is UI', (f) => expect(isUiFile(f)).toBe(true));
  it.each(['a.ts', 'b.js', 'c.json', 'd.md', 'e.py'])('%s is not UI', (f) => expect(isUiFile(f)).toBe(false));
});
