/**
 * Claude's hook output is byte-identical to the base (Track T, owner's rule: with no Codex chat,
 * today's behaviour is unchanged). tests/fixtures/hook-golden/*.txt were produced by the BASE CLI
 * of the wave with `node scripts/hook-golden.mjs <base dist/index.js> <dir>`: W1 by 0.36.2
 * (d26f0cc0); W3 by its own base, the 0.36.7 merge before any W3 change (ce5f1bab), adding the
 * `.env` deny and the Stop hook (only the version line differs from 0.36.2's files); W4 moved
 * only that version line, to 0.36.8, with its merge (8525a9fe); 0.40.0 moved only that line again
 * (release prep), and the harness now drops every inherited DREAMCONTEXT_/CLAUDE* variable; this
 * runs the same harness on the CURRENT build and compares every hook's stdout, stderr and exit.
 * 2026-11-12 (audit MM-9) removed exactly one block from session-start.txt: the empty
 * `## Marketing` state (8 lines), which the snapshot now omits until the surface holds something.
 * The fixture's context sits over the handoff threshold, so the nudge path (`maybeNudge`, which
 * W1 extended with `context_tokens`) is in the output.
 *
 * The CLI version line is compared against package.json's version, not the version frozen in the
 * fixture (Super decision 2026-11-07, test receipts): a release bump no longer edits this fixture,
 * and a version-only bump can reuse the suite's receipt. The built CLI must still print exactly
 * the current version, so a stale dist stays red here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const CLI = join(ROOT, 'dist', 'index.js');
const GOLDEN = join(ROOT, 'tests/fixtures/hook-golden');
const VERSION_LINE = /(The CLI version \(v)[^)]+\)/g;
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
/** A golden file as today's build must print it: the CLI's version is package.json's. */
const expected = (f: string) => readFileSync(join(GOLDEN, f), 'utf-8').replace(VERSION_LINE, `$1${VERSION})`);

describe('Claude hook output (golden, wave base)', () => {
  it.skipIf(!existsSync(CLI))('every hook prints exactly what the base printed', () => {
    const out = mkdtempSync(join(tmpdir(), 'dc-hook-golden-out-'));
    try {
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/hook-golden.mjs'), CLI, out], { encoding: 'utf-8', timeout: 240_000 });
      expect(r.status, r.stderr).toBe(0);
      const files = readdirSync(GOLDEN).filter((f) => f.endsWith('.txt')).sort();
      expect(files).toEqual(['post-tool-use.txt', 'pre-compact.txt', 'pre-tool-use-env-edit.txt', 'pre-tool-use.txt', 'session-start.txt', 'stop.txt', 'user-prompt-submit.txt']);
      expect(readFileSync(join(GOLDEN, 'pre-tool-use-env-edit.txt'), 'utf-8')).toContain('"permissionDecision":"deny"');
      expect(readFileSync(join(GOLDEN, 'session-start.txt'), 'utf-8')).toMatch(new RegExp(VERSION_LINE.source)); // the line the version rides on is still there
      for (const f of files) expect(readFileSync(join(out, f), 'utf-8'), f).toBe(expected(f));
      expect(readFileSync(join(GOLDEN, 'user-prompt-submit.txt'), 'utf-8')).toContain('[context handoff]');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);
});
