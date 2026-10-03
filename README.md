# ui-loop

**Context-budgeted visual feedback for coding agents.**

ui-loop is an MCP server, a CLI and a Claude Code plugin that lets a coding agent (Claude Code, Cursor, Codex) *see the UI it just changed* without flooding its context window. Instead of a full screenshot every turn, the agent gets a short structured text summary (console errors, failed requests, overflow, layout shifts, accessibility violations) plus small crops of only the regions that changed since the last capture, all fitted into a token budget you choose. Captures live on disk under `.ui-loop/` with automatic eviction, so nothing accumulates in the conversation.

## Why

General-purpose browser automation servers are great at driving a browser. They are not designed to be cheap verification primitives:

- **Playwright MCP** accessibility snapshots run 50–540 KB each, and the maintainers' position is that pruning history is the agent's job, not the server's ([microsoft/playwright-mcp #1233](https://github.com/microsoft/playwright-mcp/issues/1233)).
- **Claude in Chrome** screenshots are re-sent every turn. One report measured 18 screenshots at roughly 279K tokens per call, consuming 17% of a Max plan context window in 5 turns ([anthropics/claude-code #27869](https://github.com/anthropics/claude-code/issues/27869)).
- **Chrome DevTools MCP** tool definitions alone cost about 17k tokens before the agent does anything.

None of them ship the thing a coding agent actually needs after an edit: *diff-only crops + structured text + eviction* as a single primitive. That is all ui-loop does.

## Install in 60 seconds

### Claude Code (plugin, recommended)

```bash
claude plugin marketplace add djig/ui-loop
claude plugin install ui-loop@djig-plugins
```

This registers the MCP server, a `PostToolUse` hook that diffs the relevant route after you edit a UI file, and a skill that teaches Claude the capture → edit → diff loop.

Plain MCP server without the hook and skill:

```bash
claude mcp add ui-loop -- npx -y @djig/ui-loop serve
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{ "mcpServers": { "ui-loop": { "command": "npx", "args": ["-y", "@djig/ui-loop", "serve"] } } }
```

Optional best-effort hook: copy [`examples/cursor/hooks.json`](examples/cursor/hooks.json) to `.cursor/hooks.json`.

### Codex

```bash
codex mcp add ui-loop -- npx -y @djig/ui-loop serve
```

### Any agent that reads `mcp.json` / `plugin.json`

The repo root carries an [agent-plugins.org](https://agent-plugins.org) `plugin.json` and `mcp.json`, so Copilot, Codex and Cursor can install it from the GitHub URL.

### In your project

```bash
npx -y @djig/ui-loop init   # adds .ui-loop/ to .gitignore, prints config snippets
```

Chromium is resolved from `UI_LOOP_CHROMIUM`, then Playwright's bundled Chromium, then common system paths (Google Chrome, Chromium). If none is found: `npx playwright install chromium` or set `UI_LOOP_CHROMIUM=/path/to/chrome`.

## The loop

1. `ui_detect_dev_server` → `http://localhost:3000`
2. `ui_capture { url, label }` **before** editing (baseline; returns one downscaled full image the first time)
3. Edit the code
4. `ui_diff { url, label }` → text summary + crops of changed regions within budget
5. `ui_region { label, region: 0 }` only if a crop needs a closer look
6. Fix, `ui_diff` again (each diff becomes the new baseline)
7. `ui_assert { url, checks }` to close out with text-only checks

Example transcript (abridged):

```
> ui_capture { url: "http://localhost:3000/settings", label: "settings" }
ui_capture settings (2026-10-03T17-07-36-866Z) — first capture, saved as baseline
title: Settings
url: http://localhost:3000/settings
viewport: 1280×800
console: clean
a11y: no violations at impact ≥ serious
budget: ~1463/4000 tokens (text 97, images 1366)
[image 1280×800 → 960×600]

… agent edits SettingsForm.tsx …

> ui_diff { url: "http://localhost:3000/settings", label: "settings", maxTokens: 1500 }
ui_diff settings: 2026-10-03T17-07-36-866Z → 2026-10-03T17-07-38-786Z
pixels changed: 2.44% (25002/1024000) in 2 region(s)
  #0 [20,360 1260×48] 18001px near <button> "Save changes"
  #1 [40,140 160×48] 7001px near <main>
layout shifts: 2
  main: 0,80 1280×324 → 0,80 1280×334
  #cta: 40,140 160×48 → 640,360 160×48
console: 2 error(s), 0 warning(s), 0 uncaught exception(s)
  ✖ Boom: failed to hydrate widget (×2)
horizontal overflow: YES (scrollWidth 2420 > innerWidth 1280)
a11y: 1 violation(s) at impact ≥ serious
  [critical] image-alt: Images must have alternative text (1 node) e.g. <img src="…">
budget: ~269/1500 tokens (text 226, images 43)
[crop #0 512×33] [crop #1 192×80]
```

With the plugin installed, the `PostToolUse` hook runs this diff automatically after `Edit`/`Write`/`MultiEdit` on `*.tsx|jsx|css|scss|mdx` when a dev server is detected, and injects a bounded (≤ 1500 chars, no images) summary as additional context. It never blocks the tool call and stays silent when nothing applies.

## Tool reference

| Tool | Purpose | Returns images? |
| --- | --- | --- |
| `ui_capture { url, label?, viewport?, waitFor?, fullPage?, includeFull?, maxTokens?, darkMode? }` | Screenshot + summary; becomes the baseline for `label` (default: slug of URL path) | First capture of a label, or `includeFull` |
| `ui_diff { …same, baseline? }` | Re-capture, pixel-diff against baseline, return summary + region crops within budget. No baseline → acts like `ui_capture` and says so | Region crops (largest first) |
| `ui_region { label, captureId?, region: index \| {x,y,width,height}, maxTokens? }` | One crop at higher resolution | One image |
| `ui_assert { url, checks: [{type, selector?, text?, min?, max?, impact?}] }` | `text`, `visible`, `hidden`, `count`, `noConsoleErrors`, `noOverflow`, `a11y` → pass/fail with evidence | Never |
| `ui_list` | Labels and stored captures with sizes | Never |
| `ui_forget { label? }` | Delete a label's captures, or all | Never |
| `ui_detect_dev_server` | `UI_LOOP_URL`, Next.js `.next/dev/lock`, ports 3000–3005/5173/4200/8080 | Never |

Every tool also returns `structuredContent` (JSON) alongside the text for clients that prefer it.

The text summary always includes: page title, final URL, viewport, deduped console errors/warnings and uncaught exceptions (capped), failed requests with status ≥ 400 (capped), horizontal overflow (`document.scrollWidth > innerWidth`), layout shifts for `watchSelectors` (default `h1,h2,nav,main,button,[role=dialog]`), axe-core violations at impact ≥ `serious` by default (capped), and for diffs the percent of pixels changed plus each region's box and the nearest element (`tag`, `role`, text snippet) at its center.

## Budget model

Every tool accepts `maxTokens` (default 4000). Allocation order:

1. **Text summary** — always included. Typically 100–300 tokens.
2. **Region crops** — by area, largest first, each padded by 16px and downscaled so the longest side ≤ 512px, included while the running total fits.
3. **Omissions are stated** — `3 more regions omitted (2, 3, 4); call ui_region …`, so the agent knows what it did not see.
4. **Full screenshot** — only on the first capture of a label or `includeFull: true`, downscaled to whatever budget remains.

Image tokens are estimated with Anthropic's published formula, `ceil(width × height / 750)`; text as `ceil(chars / 4)`. Other models bill images differently (OpenAI and Gemini tile at 512px/768px), so treat the estimate as an upper-bound heuristic. The reported `budget:` line tells you what was actually spent.

## Configuration

Environment variables:

| Variable | Effect |
| --- | --- |
| `UI_LOOP_CHROMIUM` | Path to a Chrome/Chromium executable |
| `UI_LOOP_URL` | Dev server base URL; used first by detection and by the hook |
| `UI_LOOP_ROUTE` | Route the hook should diff, overriding Next.js inference (needed for dynamic segments like `[id]`) |
| `UI_LOOP_MAX_TOKENS` | Default token budget (4000) |
| `UI_LOOP_KEEP` | Captures kept per label (5) |
| `UI_LOOP_MAX_CROP_SIDE` | Longest side of region crops in px (512) |
| `UI_LOOP_TIMEOUT_MS` | Navigation timeout (30000) |
| `UI_LOOP_HOOK_DISABLED=1` | Make the hook a no-op |

Optional `ui-loop.config.json` in the project root (all keys optional):

```json
{
  "keepPerLabel": 5,
  "maxTokens": 4000,
  "maxCropSide": 512,
  "cropPadding": 16,
  "maxRegions": 8,
  "viewport": { "width": 1280, "height": 800 },
  "watchSelectors": ["h1", "h2", "nav", "main", "button", "[role=dialog]"],
  "a11yImpact": "serious",
  "diffThreshold": 0.1,
  "timeoutMs": 30000
}
```

Storage: `.ui-loop/captures/<label>/<timestamp>.png` + `.json`. `ui-loop init` adds `.ui-loop/` to `.gitignore`.

### Hook route mapping

For an edited file, the hook picks the route in this order: `UI_LOOP_ROUTE` → Next.js App Router inference (files under `app/`; route groups `(x)` stripped; `page/layout/loading/error` map to their directory; `_private` and `@slot` folders fall back to the parent) → `/`. Dynamic segments (`[id]`, `[...slug]`) are skipped with a one-line note instead of guessing.

### CLI

```
ui-loop init
ui-loop capture <url> [--label L] [--json] [--full-page] [--include-full] [--max-tokens N] [--dark]
ui-loop diff <url>    [--label L] [--json] [--max-tokens N] [--include-full] [--baseline ID]
ui-loop assert <url> --check noConsoleErrors --check "text=Save@button" --check a11y=serious
ui-loop list | forget [label] | detect
ui-loop hook [--cursor]     # stdin: hook payload → stdout: bounded context JSON, exit 0 always
ui-loop serve               # MCP over stdio (also the default when stdin is piped)
```

Programmatic API: `import { capture, diff, assert, detectDevServer } from '@djig/ui-loop'`.

## Comparison

| | ui-loop | Playwright MCP | Chrome DevTools MCP | agent-browser | Claude in Chrome |
| --- | --- | --- | --- | --- | --- |
| Primary job | Verify a UI change cheaply | General browser automation | Debugging/perf via DevTools | Browser automation for agents | Drive the user's real Chrome |
| Diff vs previous state | Yes, region crops | No | No | No | No |
| Token budget per call | Yes, explicit `maxTokens` | No | No | No | No |
| Text health summary (console, network, a11y, overflow) | Yes, always | On request, separate tools | On request, separate tools | Partial | Partial |
| Images per turn | Only changed regions; full only on request | Full screenshot on request | Full screenshot on request | Full screenshot | Full screenshot each turn |
| Persistent store + eviction | Yes (`.ui-loop/`) | No | No | No | No |
| Click/type/navigate flows | No | Yes | Yes | Yes | Yes |
| Tool surface | 7 small tools | ~25 | ~26 | Many | Many |

Honest framing: those projects are general browser automation and do far more than ui-loop. ui-loop is a narrow verification primitive meant to run *alongside* them (or alone, when all you need is "did my edit render correctly?").

## Limitations

- Static capture of a URL: no clicking, typing or auth flows. Use a dev-only route, query param or mocked state to reach the UI you care about.
- Pixel diffs are sensitive to animations, carousels, timestamps and non-deterministic data. ui-loop pauses CSS animations/transitions, but content that changes on every load will show as changed.
- `fullPage` diffs where the page height changes produce large regions; viewport captures are more stable.
- Route inference covers the Next.js App Router only. Other frameworks get `/` unless `UI_LOOP_ROUTE` or `UI_LOOP_URL` is set.
- Token estimates follow Anthropic's formula; actual billing varies by model and provider.
- axe-core runs on the rendered DOM only (no keyboard-navigation checks).
- The Cursor hook is best effort; Cursor's hook contract has shifted between versions.

## Roadmap

- `ui_interact` with a strictly bounded action list (click/type/scroll) before capture.
- Vite/Remix/SvelteKit route inference.
- Perceptual diff (ignore anti-aliasing and sub-pixel jitter) and ignore-regions config.
- Mobile viewport presets and multi-viewport diffs in one call.
- Optional HTML report of a session's captures for humans.

## Contributing

```bash
git clone https://github.com/djig/ui-loop && cd ui-loop
npm install
npx playwright install chromium     # or set UI_LOOP_CHROMIUM
npm run build && npm test
```

Unit tests cover region clustering, budget allocation, token estimation, Next.js route inference, dev-server lock parsing, hook contracts and the summary formatter. The integration test spins up a local HTTP server with before/after fixtures and runs capture → diff → assert in a real Chromium; it skips itself when no Chromium is found.

Issues and PRs welcome. Keep dependencies small, keep tool output bounded, and add a test for behaviour that an agent will rely on.

## License

MIT © 2026 Jignesh
