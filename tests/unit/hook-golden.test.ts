/**
 * Claude's hook output is byte-identical to the 0.36.2 base (Track T W1, owner's rule: with no
 * Codex chat, today's behaviour is unchanged). tests/fixtures/hook-golden/*.txt were produced by
 * the BASE CLI (d26f0cc0) with `node scripts/hook-golden.mjs <base dist/index.js> <dir>`; this
 * runs the same harness on the CURRENT build and compares every hook's stdout, stderr and exit.
 * The fixture's context sits over the handoff threshold, so the nudge path (`maybeNudge`, which
 * W1 extended with `context_tokens`) is in the output.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const CLI = join(ROOT, 'dist', 'index.js');
const GOLDEN = join(ROOT, 'tests/fixtures/hook-golden');

describe('Claude hook output (golden, 0.36.2 base)', () => {
  it.skipIf(!existsSync(CLI))('every hook prints exactly what the base printed', () => {
    const out = mkdtempSync(join(tmpdir(), 'dc-hook-golden-out-'));
    try {
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/hook-golden.mjs'), CLI, out], { encoding: 'utf-8', timeout: 240_000 });
      expect(r.status, r.stderr).toBe(0);
      const files = readdirSync(GOLDEN).filter((f) => f.endsWith('.txt')).sort();
      expect(files).toEqual(['post-tool-use.txt', 'pre-compact.txt', 'pre-tool-use.txt', 'session-start.txt', 'user-prompt-submit.txt']);
      for (const f of files) expect(readFileSync(join(out, f), 'utf-8'), f).toBe(readFileSync(join(GOLDEN, f), 'utf-8'));
      expect(readFileSync(join(GOLDEN, 'user-prompt-submit.txt'), 'utf-8')).toContain('[context handoff]');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);
});
