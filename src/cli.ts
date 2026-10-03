#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { capture, diff } from './capture.js';
import { assert, parseCheck } from './assert.js';
import { detectDevServer } from './detect.js';
import { CaptureStore } from './store.js';
import { runHook } from './hook.js';
import { closeSharedBrowser } from './browser.js';
import { STORE_DIR } from './config.js';

const HELP = `ui-loop — context-budgeted visual feedback for coding agents

Usage:
  ui-loop init                         add .ui-loop/ to .gitignore, print MCP config snippets
  ui-loop capture <url> [--label L] [--json] [--full-page] [--include-full] [--max-tokens N] [--dark]
  ui-loop diff <url>    [--label L] [--json] [--max-tokens N] [--include-full] [--baseline ID]
  ui-loop assert <url> --check <spec> [--check <spec> ...] [--json]
  ui-loop list
  ui-loop forget [label]
  ui-loop detect
  ui-loop hook [--cursor]              read a hook payload on stdin, print bounded context (never fails)
  ui-loop serve                        start the MCP server over stdio (default when piped)

Check specs: text=Hello[@sel] visible=sel hidden=sel count=sel[:min[:max]] noConsoleErrors noOverflow a11y[=impact]

Env: UI_LOOP_CHROMIUM, UI_LOOP_URL, UI_LOOP_ROUTE, UI_LOOP_MAX_TOKENS, UI_LOOP_KEEP, UI_LOOP_HOOK_DISABLED
`;

interface Args {
  cmd: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let val: string | boolean = eq === -1 ? true : a.slice(eq + 1);
      if (val === true && i + 1 < argv.length && !argv[i + 1]!.startsWith('--') && !BOOL_FLAGS.has(key)) {
        val = argv[++i]!;
      }
      if (key === 'check') {
        const arr = (flags.check as string[] | undefined) ?? [];
        arr.push(String(val));
        flags.check = arr;
      } else {
        flags[key] = val;
      }
    } else positional.push(a);
  }
  return { cmd: positional[0], positional: positional.slice(1), flags };
}

const BOOL_FLAGS = new Set(['json', 'full-page', 'include-full', 'dark', 'cursor', 'help', 'version']);

function str(v: string | boolean | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function int(v: string | boolean | string[] | undefined): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

const SNIPPETS = `
Claude Code (plugin, recommended):
  claude plugin marketplace add djig/ui-loop
  claude plugin install ui-loop@djig-ui-loop

Claude Code (plain MCP server):
  claude mcp add ui-loop -- npx -y @djignesh21/ui-loop serve

Codex:
  codex mcp add ui-loop -- npx -y @djignesh21/ui-loop serve

Cursor (.cursor/mcp.json):
  { "mcpServers": { "ui-loop": { "command": "npx", "args": ["-y", "@djignesh21/ui-loop", "serve"] } } }

Any agent (.mcp.json / mcp.json):
  { "mcpServers": { "ui-loop": { "type": "stdio", "command": "npx", "args": ["-y", "@djignesh21/ui-loop", "serve"] } } }
`;

async function cmdInit(cwd: string): Promise<void> {
  const gi = join(cwd, '.gitignore');
  let content = '';
  try {
    content = await fs.readFile(gi, 'utf8');
  } catch {
    // none
  }
  const entry = `${STORE_DIR}/`;
  if (!content.split('\n').some((l) => l.trim() === entry || l.trim() === STORE_DIR)) {
    content = content.length && !content.endsWith('\n') ? content + '\n' : content;
    await fs.writeFile(gi, `${content}\n# ui-loop screenshots and summaries\n${entry}\n`);
    console.log(`added ${entry} to .gitignore`);
  } else {
    console.log(`.gitignore already ignores ${entry}`);
  }
  console.log(SNIPPETS);
}

async function main(argv: string[]): Promise<number> {
  const { cmd, positional, flags } = parseArgs(argv);
  const cwd = process.cwd();
  const json = flags.json === true;

  if (flags.version) {
    console.log('0.1.0');
    return 0;
  }
  if (flags.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  if (!cmd) {
    if (!process.stdin.isTTY) {
      const { serve } = await import('./server.js');
      await serve(cwd);
      return -1; // keep running
    }
    console.log(HELP);
    return 0;
  }

  switch (cmd) {
    case 'serve': {
      const { serve } = await import('./server.js');
      await serve(cwd);
      return -1;
    }
    case 'init':
      await cmdInit(cwd);
      return 0;
    case 'capture':
    case 'diff': {
      const url = positional[0];
      if (!url) throw new Error(`usage: ui-loop ${cmd} <url>`);
      const opts = {
        url,
        label: str(flags.label),
        maxTokens: int(flags['max-tokens']),
        fullPage: flags['full-page'] === true,
        includeFull: flags['include-full'] === true,
        darkMode: flags.dark === true,
        waitFor: str(flags['wait-for']),
        cwd,
      };
      const out = cmd === 'capture' ? await capture(opts) : await diff({ ...opts, baseline: str(flags.baseline) });
      if (json) {
        console.log(JSON.stringify({ ...out, images: out.images.map((i) => ({ ...i, data: `<${i.data.length} b64 chars>` })) }, null, 2));
      } else {
        console.log(out.text);
        if (out.images.length) console.log(`(${out.images.length} image(s) available; use --json or the MCP server to receive them)`);
      }
      return 0;
    }
    case 'assert': {
      const url = positional[0];
      const specs = (flags.check as string[] | undefined) ?? [];
      if (!url || specs.length === 0) throw new Error('usage: ui-loop assert <url> --check <spec> [--check <spec>...]');
      const out = await assert({ url, checks: specs.map(parseCheck), cwd });
      console.log(json ? JSON.stringify(out, null, 2) : out.text);
      return out.failed === 0 ? 0 : 1;
    }
    case 'list': {
      const labels = await new CaptureStore(cwd).labels();
      if (json) console.log(JSON.stringify(labels, null, 2));
      else if (!labels.length) console.log('no captures stored');
      else for (const l of labels) {
        console.log(`${l.label}: ${l.captures.length} capture(s), ${(l.bytes / 1024).toFixed(0)} KB`);
        for (const c of l.captures) console.log(`  ${c.id} (${(c.bytes / 1024).toFixed(0)} KB)`);
      }
      return 0;
    }
    case 'forget': {
      const removed = await new CaptureStore(cwd).forget(positional[0]);
      console.log(removed.length ? `forgot ${removed.join(', ')}` : 'nothing to forget');
      return 0;
    }
    case 'detect': {
      const found = await detectDevServer({ cwd });
      if (json) console.log(JSON.stringify(found, null, 2));
      else if (!found.length) console.log('no dev server detected; start one or set UI_LOOP_URL');
      else for (const f of found) console.log(`${f.url} (${f.source}${f.detail ? `, ${f.detail}` : ''})`);
      return 0;
    }
    case 'hook': {
      const stdin = await readStdin();
      const out = await runHook(stdin, flags.cursor === true ? 'cursor' : 'claude', {
        cwd,
        log: (l) => process.stderr.write(l + '\n'),
      });
      if (out) process.stdout.write(out + '\n');
      return 0;
    }
    default:
      throw new Error(`unknown command "${cmd}"\n${HELP}`);
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

const isHook = process.argv.includes('hook');
main(process.argv.slice(2))
  .then(async (code) => {
    if (code === -1) return; // server keeps running
    await closeSharedBrowser();
    process.exit(code);
  })
  .catch(async (err) => {
    await closeSharedBrowser();
    if (isHook) process.exit(0); // never block an agent
    process.stderr.write(`ui-loop: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
