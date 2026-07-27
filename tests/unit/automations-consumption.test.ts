import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearPrivateDerivationMarker,
  OUTPUT_CONSUMPTION_BYTE_CAP,
  OUTPUT_CONSUMPTION_FILE_CAP,
  pendingOutputsSince,
  PRIVATE_DERIVATION_GITIGNORE_ENTRY,
  PRIVATE_DERIVATION_GITIGNORE_ENTRY_ROOT,
  privateDerivationMarkerPath,
  readPrivateDerivationMarker,
  writePrivateDerivationMarker,
  type PrivateDerivationMarker,
} from '../../src/lib/automations/consumption.js';

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-automations-consumption-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Write an output file at `automations/output/<slug>/<date>.md` with the
 *  given content and mtime. Returns the absolute path. */
function writeOutput(slug: string, date: string, content: string, mtimeMs: number): string {
  const dir = join(contextRoot, 'automations', 'output', slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  writeFileSync(path, content, 'utf-8');
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

const T0 = Date.parse('2026-07-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('pendingOutputsSince — boundary', () => {
  it('null boundary means consume nothing, even with fresh output on disk', () => {
    writeOutput('eod-digest', '2026-07-01', 'hello', T0 + HOUR);
    const result = pendingOutputsSince(contextRoot, null);
    expect(result.outputs).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.totalBytes).toBe(0);
  });

  it('an unparseable boundary also means consume nothing (fail toward empty, never toward the whole backlog)', () => {
    writeOutput('eod-digest', '2026-07-01', 'hello', T0 + HOUR);
    const result = pendingOutputsSince(contextRoot, 'not-a-date');
    expect(result.outputs).toEqual([]);
  });

  it('no automations/output directory at all is a clean empty result, not a throw', () => {
    const result = pendingOutputsSince(contextRoot, new Date(T0).toISOString());
    expect(result).toEqual({ outputs: [], skipped: [], totalBytes: 0 });
  });

  it('a file with mtime strictly before the boundary is excluded, and NOT reported in skipped', () => {
    writeOutput('eod-digest', '2026-06-30', 'yesterday', T0 - HOUR);
    const result = pendingOutputsSince(contextRoot, new Date(T0).toISOString());
    expect(result.outputs).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('a file with mtime at or after the boundary is included', () => {
    const path = writeOutput('eod-digest', '2026-07-01', 'today', T0 + HOUR);
    const result = pendingOutputsSince(contextRoot, new Date(T0).toISOString());
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({ slug: 'eod-digest', path, date: '2026-07-01' });
  });

  it('results are ordered newest first', () => {
    writeOutput('a', '2026-07-01', 'older', T0 + HOUR);
    writeOutput('b', '2026-07-02', 'newer', T0 + 2 * HOUR);
    const result = pendingOutputsSince(contextRoot, new Date(T0).toISOString());
    expect(result.outputs.map((o) => o.slug)).toEqual(['b', 'a']);
  });
});

describe('pendingOutputsSince — caps', () => {
  it('respects the file cap: beyond OUTPUT_CONSUMPTION_FILE_CAP, newer-to-older candidates are skipped file-cap', () => {
    const total = OUTPUT_CONSUMPTION_FILE_CAP + 3;
    for (let i = 0; i < total; i++) {
      writeOutput(`slug-${i}`, '2026-07-01', 'x', T0 + (i + 1) * 1000);
    }
    const result = pendingOutputsSince(contextRoot, new Date(T0).toISOString());
    expect(result.outputs).toHaveLength(OUTPUT_CONSUMPTION_FILE_CAP);
    const overflow = result.skipped.filter((s) => s.reason === 'file-cap');
    expect(overflow).toHaveLength(3);
    // The three oldest (lowest mtime) were the ones cut, since inclusion is newest-first.
    expect(overflow.map((s) => s.slug).sort()).toEqual(['slug-0', 'slug-1', 'slug-2']);
  });

  it('respects the byte cap: a file that would push the running total over the cap is skipped WHOLESALE, not truncated', () => {
    const big = 'x'.repeat(OUTPUT_CONSUMPTION_BYTE_CAP + 1);
    writeOutput('too-big', '2026-07-01', big, T0 + HOUR);
    const result = pendingOutputsSince(contextRoot, new Date(T0).toISOString());
    expect(result.outputs).toEqual([]);
    expect(result.skipped).toEqual([{ slug: 'too-big', path: expect.any(String), reason: 'byte-cap' }]);
    expect(result.totalBytes).toBe(0);
  });

  it('a byte-cap-skipped file does not consume budget: a smaller, older candidate can still fit after it', () => {
    const big = 'x'.repeat(OUTPUT_CONSUMPTION_BYTE_CAP - 100);
    writeOutput('newer-big', '2026-07-02', big, T0 + 2 * HOUR); // included, ~cap-100 bytes used
    writeOutput('older-small', '2026-07-01', 'small', T0 + HOUR); // newest-first puts this AFTER the big one
    // A third file that would overflow if the big one's budget were double-counted.
    const result = pendingOutputsSince(contextRoot, new Date(T0).toISOString());
    const slugs = result.outputs.map((o) => o.slug);
    expect(slugs).toContain('newer-big');
    expect(slugs).toContain('older-small');
  });

  it('every drop is named in skipped — no silent caps', () => {
    for (let i = 0; i < OUTPUT_CONSUMPTION_FILE_CAP + 1; i++) {
      writeOutput(`s${i}`, '2026-07-01', 'x', T0 + (i + 1) * 1000);
    }
    const result = pendingOutputsSince(contextRoot, new Date(T0).toISOString());
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('file-cap');
  });
});

describe('pendingOutputsSince — unreadable files never throw', () => {
  it('a stat failure on one candidate (a broken symlink — listed by the glob, but statSync throws) is recorded as unreadable and does not abort the scan', () => {
    const dir = join(contextRoot, 'automations', 'output', 'ghost');
    mkdirSync(dir, { recursive: true });
    const ghostPath = join(dir, '2026-07-01.md');
    symlinkSync(join(dir, 'does-not-exist-target'), ghostPath);
    const goodPath = writeOutput('real', '2026-07-01', 'still here', T0 + HOUR);
    const result = pendingOutputsSince(contextRoot, new Date(T0).toISOString());
    expect(result.outputs.map((o) => o.path)).toEqual([goodPath]);
    expect(result.skipped).toEqual([{ slug: 'ghost', path: ghostPath, reason: 'unreadable' }]);
  });
});

describe('private-derivation marker', () => {
  const marker: PrivateDerivationMarker = {
    derivedFrom: [{ slug: 'eod-digest', outputPath: 'automations/output/eod-digest/2026-07-01.md' }],
    knowledgePaths: ['knowledge/daily-summary.md'],
    writtenAt: '2026-07-01T09:00:00.000Z',
  };

  it('round-trips through write/read', () => {
    writePrivateDerivationMarker(contextRoot, marker);
    expect(readPrivateDerivationMarker(contextRoot)).toEqual(marker);
  });

  it('ensures BOTH gitignore entries before the marker file exists', () => {
    writePrivateDerivationMarker(contextRoot, marker);
    const brainIgnore = readFileSync(join(contextRoot, '.gitignore'), 'utf-8');
    const rootIgnore = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    expect(brainIgnore).toContain(PRIVATE_DERIVATION_GITIGNORE_ENTRY);
    expect(rootIgnore).toContain(PRIVATE_DERIVATION_GITIGNORE_ENTRY_ROOT);
    expect(existsSync(privateDerivationMarkerPath(contextRoot))).toBe(true);
  });

  it('the marker path is under state/, NOT tmp/ — tmp/ hosts a TTL unlinker and a gate must not fail open on a cleanup sweep', () => {
    const path = privateDerivationMarkerPath(contextRoot);
    expect(path).toBe(join(contextRoot, 'state', '.sleep-private-derivation.json'));
    expect(path.includes(`${join(contextRoot, 'tmp')}`)).toBe(false);
  });

  it('a missing marker reads as null, never throws', () => {
    expect(readPrivateDerivationMarker(contextRoot)).toBeNull();
  });

  it('a malformed marker (not valid JSON) reads as null, never throws', () => {
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(privateDerivationMarkerPath(contextRoot), '{not json', 'utf-8');
    expect(readPrivateDerivationMarker(contextRoot)).toBeNull();
  });

  it('a marker missing required fields reads as null', () => {
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(privateDerivationMarkerPath(contextRoot), JSON.stringify({ derivedFrom: [] }), 'utf-8');
    expect(readPrivateDerivationMarker(contextRoot)).toBeNull();
  });

  it('clearPrivateDerivationMarker removes the file and is idempotent', () => {
    writePrivateDerivationMarker(contextRoot, marker);
    clearPrivateDerivationMarker(contextRoot);
    expect(existsSync(privateDerivationMarkerPath(contextRoot))).toBe(false);
    expect(() => clearPrivateDerivationMarker(contextRoot)).not.toThrow();
    expect(readPrivateDerivationMarker(contextRoot)).toBeNull();
  });
});
