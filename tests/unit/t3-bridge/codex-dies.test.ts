/**
 * Codex dying mid-turn (W1 end review): the bridge closes the open turn with an error `result`
 * and ends with a non-zero code, so the pane says it ended instead of "Working…" forever.
 * Drives the real bridge stdio + T3's adapter + a real `codex` child (scripts/verify/fake-codex.mjs).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runBridgeStdio } from '../../../src/lib/t3-bridge/stdio.js';

const ROOT = join(__dirname, '../../..');
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('codex dies mid-turn', () => {
  it('closes the turn with an error result and the bridge exits non-zero', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dc-codex-dies-'));
    const bin = join(dir, 'codex');
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'scripts/verify/fake-codex.mjs')}" "$@"\n`);
    chmodSync(bin, 0o755);
    const project = join(dir, 'proj');
    mkdirSync(join(project, '_dream_context'), { recursive: true });
    const input = new PassThrough();
    const out: Record<string, unknown>[] = [];
    let buf = '';
    const done = runBridgeStdio(
      { tool: 'codex', cwd: project, model: 'gpt-6-luna', mode: 'bypassPermissions', paneId: 'pane-dies', binaryPath: bin },
      {
        input,
        env: { ...process.env, HOME: dir, FAKE_CODEX_FIXTURES: join(ROOT, 'src/vendor/t3/apps/server/src/orchestration-v2/testkit/fixtures') },
        home: dir,
        write: (l) => { buf += l; let n; while ((n = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, n))); buf = buf.slice(n + 1); } },
      },
    );
    const end = Date.now() + 20_000;
    while (!out.some((f) => f.dc_ready) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    input.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'please DIE now' }] } }) + '\n');
    const code = await done;
    expect(code).toBe(1);
    expect(out.find((f) => f.type === 'result')).toMatchObject({ is_error: true });
  }, 40_000);
});
