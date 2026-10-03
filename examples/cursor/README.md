# Cursor hook example (best effort)

Copy `hooks.json` to `.cursor/hooks.json` in your project. Cursor's `afterFileEdit`
event sends `{ "file_path": "...", "edits": [...] }` on stdin; `ui-loop hook --cursor`
answers with `{ "additional_context": "..." }` (≤ 1500 chars, text only) when the
edited file is a UI file and a dev server is detected.

Cursor's hook payload and output contract have changed between releases, so treat
this as a starting point and check Cursor's current hooks documentation. The MCP
server (`.cursor/mcp.json`) is the stable integration; the hook is a convenience.
