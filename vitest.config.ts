import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Sandbox convenience: if the known Chromium path exists and nothing is set,
// point ui-loop at it so the integration test runs. Harmless elsewhere.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!process.env.UI_LOOP_CHROMIUM && existsSync(SANDBOX_CHROMIUM)) {
  process.env.UI_LOOP_CHROMIUM = SANDBOX_CHROMIUM;
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      ...(process.env.UI_LOOP_CHROMIUM ? { UI_LOOP_CHROMIUM: process.env.UI_LOOP_CHROMIUM } : {}),
    },
  },
});
