# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-03

### Added

- MCP server (stdio) with `ui_capture`, `ui_diff`, `ui_region`, `ui_assert`, `ui_list`,
  `ui_forget`, `ui_detect_dev_server`.
- Token-budgeted responses: text summary always, then region crops by area until the budget
  is exhausted, with explicit omission notes.
- Pixel diff (pixelmatch) clustered into bounding-box regions with nearest-element hints.
- Structured page summary: console errors/warnings, uncaught exceptions, failed requests,
  horizontal overflow, layout shifts for watched selectors, axe-core violations.
- On-disk capture store under `.ui-loop/captures/<label>/` with per-label eviction.
- CLI: `init`, `capture`, `diff`, `assert`, `list`, `forget`, `detect`, `hook`, `serve`.
- Claude Code plugin layout (`.claude-plugin/`, `hooks/`, `skills/ui-loop/SKILL.md`),
  one-plugin marketplace, and agent-plugins.org `plugin.json` / `mcp.json`.
- PostToolUse hook for Claude Code and a best-effort Cursor `afterFileEdit` example.
- Next.js App Router route inference for edited files.
