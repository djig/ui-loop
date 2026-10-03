import { relative, sep } from 'node:path';

export interface RouteGuess {
  route?: string;
  note?: string;
}

export const UI_FILE_RE = /\.(tsx|jsx|css|scss|mdx)$/i;

export function isUiFile(filePath: string): boolean {
  return UI_FILE_RE.test(filePath);
}

/**
 * Infer the Next.js App Router route from a file path.
 *
 * Rules:
 * - Only files under an `app/` (or `src/app/`) directory are mapped.
 * - Route groups `(marketing)` are stripped.
 * - `page.*`, `layout.*`, `loading.*`, `error.*`, `template.*`, `not-found.*`
 *   map to their directory's route. Other files (components) map to the
 *   nearest enclosing directory route.
 * - Dynamic segments `[id]`, `[...slug]`, `[[...slug]]` cannot be resolved
 *   without data → returns `{ route: undefined, note }`.
 * - Parallel routes `@modal` and private folders `_components` are stripped /
 *   fall back to the parent route.
 */
export function inferNextRoute(filePath: string, cwd?: string): RouteGuess {
  let rel = filePath.replace(/\\/g, '/');
  if (cwd) {
    const r = relative(cwd, filePath).split(sep).join('/');
    if (!r.startsWith('..')) rel = r;
  }
  const segs = rel.split('/').filter(Boolean);
  const appIdx = segs.lastIndexOf('app');
  if (appIdx === -1) return { route: undefined, note: 'not under app/' };

  const inside = segs.slice(appIdx + 1);
  if (inside.length === 0) return { route: '/' };

  // Drop filename
  const file = inside[inside.length - 1]!;
  let dirs = inside.slice(0, -1);
  const isSpecial = /^(page|layout|loading|error|template|not-found|default|route)\.[a-z]+$/i.test(file);
  if (!isSpecial) {
    // component/style inside a route dir: strip private folders like _components
    dirs = dirs.filter((d) => !d.startsWith('_'));
  }
  if (/^route\.[a-z]+$/i.test(file)) return { route: undefined, note: 'route handler, not a page' };

  const out: string[] = [];
  for (const d of dirs) {
    if (/^\(.*\)$/.test(d)) continue; // route group
    if (d.startsWith('@')) continue; // parallel route slot
    if (d.startsWith('_')) continue; // private folder
    if (/^\[.*\]$/.test(d)) {
      return {
        route: undefined,
        note: `dynamic segment ${d} in ${rel}; set UI_LOOP_ROUTE to a concrete path`,
      };
    }
    out.push(d);
  }
  return { route: '/' + out.join('/') };
}

/**
 * Decide which route to diff for an edited file.
 * Precedence: UI_LOOP_ROUTE env → Next.js inference → '/'.
 */
export function routeForFile(filePath: string, env: NodeJS.ProcessEnv = process.env, cwd?: string): RouteGuess {
  const forced = env.UI_LOOP_ROUTE;
  if (forced) return { route: forced.startsWith('/') ? forced : '/' + forced };
  const guess = inferNextRoute(filePath, cwd);
  if (guess.route) return guess;
  if (guess.note?.startsWith('dynamic')) return guess; // skip with note
  return { route: '/', note: guess.note };
}
