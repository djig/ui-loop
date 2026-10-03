---
name: ui-loop
description: Verify UI changes visually without flooding context. Use after editing any component, page, style or layout file and before claiming a visual fix is done. Captures a baseline, then returns only the changed regions as small crops plus a structured text summary (console errors, failed requests, overflow, layout shifts, a11y violations) within a token budget. Tools: ui_detect_dev_server, ui_capture, ui_diff, ui_region, ui_assert, ui_list, ui_forget.
license: MIT
compatibility: Requires the ui-loop MCP server (npx -y @djignesh21/ui-loop serve), Node 20+, and a Chromium (bundled Playwright Chromium, system Chrome, or UI_LOOP_CHROMIUM). A local dev server must be running.
metadata:
  author: djig
  version: "0.1.0"
  homepage: https://github.com/djig/ui-loop
---

# ui-loop: see what you changed, cheaply

## When to use

- After any change that can affect rendering: `.tsx/.jsx`, CSS/SCSS, layout, MDX, theme tokens.
- Before telling the user a visual bug is fixed. "Tests pass" is not evidence a button is visible.
- When a user reports "it looks wrong" and you need to confirm what they see.

Do not use for backend-only changes, or when no dev server is running (ask the user to start one).

## The loop

1. **Find the server.** `ui_detect_dev_server` → pick the candidate URL (or use `UI_LOOP_URL`).
2. **Baseline before editing.** `ui_capture({ url, label })` for the route you are about to touch.
   One label per route (e.g. `settings`). The first capture returns a downscaled full screenshot;
   later captures return text only.
3. **Edit** the code.
4. **Diff.** `ui_diff({ url, label })`. Read the text first: pixels changed, region list with the
   nearest element, layout shifts, console errors, failed requests, overflow, a11y violations.
   Crops of the largest changed regions follow, within `maxTokens` (default 4000).
5. **Zoom only where needed.** If a region is ambiguous or was omitted, `ui_region({ label, region: <index> })`.
6. **Fix and re-diff.** Each `ui_diff` makes the new capture the baseline, so the next diff shows
   only your latest change.
7. **Assert to close.** `ui_assert({ url, checks: [...] })` for text-only confirmation:
   `noConsoleErrors`, `noOverflow`, `a11y`, `visible`, `text`, `count`.

## Reading a diff

- `pixels changed: 0` → nothing rendered differently. If you expected a change, check the route,
  hot reload, or whether the component is actually mounted.
- Large `percentChanged` (>30%) with one giant region usually means a layout shift pushed
  everything down, not that everything changed. Look at `layout shifts` for the culprit.
- `horizontal overflow: YES` after a change is almost always a regression.
- a11y violations at `serious`/`critical` are worth fixing while you are in the file.

## Budget guidance

- Default `maxTokens: 4000` is enough for text plus 3–6 crops at 512px.
- For a sanity check, use `maxTokens: 1500`: text plus one or two crops.
- Use `includeFull: true` only once per route when you need overall composition, and lower
  `maxTokens` so it downscales. Never request the full screenshot every turn.
- `fullPage: true` costs more and diffs are noisier (height changes). Prefer viewport captures
  and scroll by changing the route or using a `waitFor` selector.
- Image cost is estimated as width×height/750 (Anthropic's formula). Other models differ.

## What NOT to do

- Do not call `ui_capture` after every edit; call `ui_diff`. Capture is for the baseline.
- Do not keep more than one baseline label per route. Use `ui_forget` to clean up.
- Do not request `includeFull` on every `ui_diff`.
- Do not treat a passing `ui_assert` as a visual check; it only tests what you asked.
- Do not screenshot pages that need authentication you cannot provide; ask the user for a
  dev-only route or a mocked state instead.

## Example

```
ui_detect_dev_server → http://localhost:3000 (next-lock)
ui_capture { url: "http://localhost:3000/settings", label: "settings" }
  → title, console clean, a11y clean, full image (downscaled, ~1300 tokens)
… edit SettingsForm.tsx …
ui_diff { url: "http://localhost:3000/settings", label: "settings", maxTokens: 2500 }
  → pixels changed: 1.8% in 2 regions
    #0 [640,360 160×48] near <button> "Save"   (crop attached)
    #1 [40,140 160×48]  near <main>            (crop attached)
    layout shifts: #cta 40,140 → 640,360
    console: clean · a11y: no violations
ui_assert { url, checks: [{type:"visible", selector:"#save"}, {type:"noConsoleErrors"}] }
  → 2 passed
```
