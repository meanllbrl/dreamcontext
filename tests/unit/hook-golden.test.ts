/**
 * Claude's hook output is byte-identical to the base (Track T, owner's rule: with no Codex chat,
 * today's behaviour is unchanged). tests/fixtures/hook-golden/*.txt were produced by the BASE CLI
 * of the wave with `node scripts/hook-golden.mjs <base dist/index.js> <dir>`: W1 by 0.36.2
 * (d26f0cc0); W3 by its own base, the 0.36.7 merge before any W3 change (ce5f1bab), adding the
 * `.env` deny and the Stop hook (only the version line differs from 0.36.2's files); W4 moved
 * only that version line, to 0.36.8, with its merge (8525a9fe); this
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

describe('Claude hook output (golden, wave base)', () => {
  it.skipIf(!existsSync(CLI))('every hook prints exactly what the base printed', () => {
    const out = mkdtempSync(join(tmpdir(), 'dc-hook-golden-out-'));
    try {
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/hook-golden.mjs'), CLI, out], { encoding: 'utf-8', timeout: 240_000 });
      expect(r.status, r.stderr).toBe(0);
      const files = readdirSync(GOLDEN).filter((f) => f.endsWith('.txt')).sort();
      expect(files).toEqual(['post-tool-use.txt', 'pre-compact.txt', 'pre-tool-use-env-edit.txt', 'pre-tool-use.txt', 'session-start.txt', 'stop.txt', 'user-prompt-submit.txt']);
      expect(readFileSync(join(GOLDEN, 'pre-tool-use-env-edit.txt'), 'utf-8')).toContain('"permissionDecision":"deny"');
      for (const f of files) expect(readFileSync(join(out, f), 'utf-8'), f).toBe(readFileSync(join(GOLDEN, f), 'utf-8'));
      expect(readFileSync(join(GOLDEN, 'user-prompt-submit.txt'), 'utf-8')).toContain('[context handoff]');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);
});
