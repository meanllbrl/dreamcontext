import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DIGEST_GC_KEEP,
  MAX_INDEXED_DIGESTS,
  planDigestGc,
  scanDigests,
  runDigestGc,
  type DigestGcEntry,
} from '../../src/lib/session-digest.js';

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `digest-gc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'state'), { recursive: true });
  return dir;
}

function digestsDir(root: string): string {
  return join(root, 'state', '.session-digests');
}

/** Write a digest file with explicit frontmatter, mirroring writeDigest's shape. */
function writeFixtureDigest(
  root: string,
  sessionId: string,
  opts: { createdAt?: string; omitCreatedAt?: boolean } = {},
): string {
  const dir = digestsDir(root);
  mkdirSync(dir, { recursive: true });
  const lines = ['---', 'type: session-digest', `session_id: ${sessionId}`];
  if (!opts.omitCreatedAt) {
    lines.push(`created_at: ${opts.createdAt ?? new Date().toISOString()}`);
  }
  lines.push('---', '', `# Session Digest\n\n## Decisions\n- something about ${sessionId}`);
  const file = join(dir, `${sessionId}.md`);
  writeFileSync(file, lines.join('\n'), 'utf-8');
  return file;
}

describe('DIGEST_GC_KEEP identity', () => {
  it('is pinned to MAX_INDEXED_DIGESTS — GC retention can never drift from the recall index cap', () => {
    expect(DIGEST_GC_KEEP).toBe(MAX_INDEXED_DIGESTS);
    expect(DIGEST_GC_KEEP).toBe(50);
  });
});

describe('planDigestGc', () => {
  function entry(sessionId: string, createdMs: number, path?: string): DigestGcEntry {
    return { path: path ?? `/tmp/${sessionId}.md`, sessionId, createdMs };
  }

  it('keeps the newest 50 of 60 dated entries, deletes the 10 oldest, none protected', () => {
    const entries: DigestGcEntry[] = Array.from({ length: 60 }, (_, i) =>
      entry(`sess-${String(i + 1).padStart(2, '0')}`, i + 1), // sess-01 oldest .. sess-60 newest
    );

    const plan = planDigestGc(entries, new Set());

    expect(plan.keep.length).toBe(50);
    expect(plan.deleteAbs.length).toBe(10);
    const deletedIds = new Set(plan.deleteAbs.map((p) => p.match(/sess-(\d+)/)?.[0]));
    for (let i = 1; i <= 10; i++) {
      expect(deletedIds.has(`sess-${String(i).padStart(2, '0')}`)).toBe(true);
    }
    for (let i = 11; i <= 60; i++) {
      expect(deletedIds.has(`sess-${String(i).padStart(2, '0')}`)).toBe(false);
    }
  });

  it('keeps a protected session even when it is the OLDEST entry outside the top-K', () => {
    const entries: DigestGcEntry[] = Array.from({ length: 60 }, (_, i) =>
      entry(`sess-${String(i + 1).padStart(2, '0')}`, i + 1),
    );
    // sess-01 is the globally oldest — rank 60th, well outside keep=50.
    const plan = planDigestGc(entries, new Set(['sess-01']));

    expect(plan.keep.length).toBe(51);
    expect(plan.deleteAbs.length).toBe(9);
    expect(plan.keep.some((p) => p.includes('sess-01'))).toBe(true);
    expect(plan.deleteAbs.some((p) => p.includes('sess-01'))).toBe(false);
  });

  it('deletes nothing when the corpus is exactly K=50', () => {
    const entries: DigestGcEntry[] = Array.from({ length: 50 }, (_, i) => entry(`sess-${i}`, i + 1));
    const plan = planDigestGc(entries, new Set());
    expect(plan.deleteAbs).toEqual([]);
    expect(plan.keep.length).toBe(50);
  });

  it('deletes nothing when under K', () => {
    const entries: DigestGcEntry[] = Array.from({ length: 12 }, (_, i) => entry(`sess-${i}`, i + 1));
    const plan = planDigestGc(entries, new Set());
    expect(plan.deleteAbs).toEqual([]);
    expect(plan.keep.length).toBe(12);
  });

  it('sorts undated (createdMs: 0) entries OLDEST — first candidates for deletion — matching loadDigestDocs tie-break', () => {
    // 49 dated entries (rank 1..49 by recency) + 2 undated (createdMs 0), keep=50.
    const dated: DigestGcEntry[] = Array.from({ length: 49 }, (_, i) => entry(`dated-${i}`, 1000 + i));
    const undated: DigestGcEntry[] = [entry('undated-b', 0), entry('undated-a', 0)];
    const plan = planDigestGc([...dated, ...undated], new Set());

    // keep=50 total corpus size 51 → exactly one deleted, and it must be an
    // undated entry (tie-broken by sessionId ascending: 'undated-a' sorts
    // before 'undated-b', so 'undated-b' is the one pushed out).
    expect(plan.deleteAbs.length).toBe(1);
    expect(plan.deleteAbs[0]).toContain('undated-b');
    expect(plan.keep.some((p) => p.includes('undated-a'))).toBe(true);
  });

  it('respects a custom keep override', () => {
    const entries: DigestGcEntry[] = Array.from({ length: 10 }, (_, i) => entry(`sess-${i}`, i + 1));
    const plan = planDigestGc(entries, new Set(), 3);
    expect(plan.keep.length).toBe(3);
    expect(plan.deleteAbs.length).toBe(7);
  });
});

describe('scanDigests', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns [] when the digests directory does not exist', () => {
    expect(scanDigests(root)).toEqual([]);
  });

  it('scans well-formed digests into entries with parsed createdMs', () => {
    writeFixtureDigest(root, 'sess-a', { createdAt: '2026-01-05T00:00:00.000Z' });
    writeFixtureDigest(root, 'sess-b', { createdAt: '2026-01-10T00:00:00.000Z' });

    const entries = scanDigests(root);
    expect(entries.length).toBe(2);
    const byId = Object.fromEntries(entries.map((e) => [e.sessionId, e]));
    expect(byId['sess-a'].createdMs).toBe(Date.parse('2026-01-05T00:00:00.000Z'));
    expect(byId['sess-b'].createdMs).toBe(Date.parse('2026-01-10T00:00:00.000Z'));
  });

  it('treats missing/unparsable created_at as createdMs 0, never throws', () => {
    writeFixtureDigest(root, 'sess-nodate', { omitCreatedAt: true });
    const entries = scanDigests(root);
    expect(entries.length).toBe(1);
    expect(entries[0].createdMs).toBe(0);
    expect(entries[0].sessionId).toBe('sess-nodate');
  });

  it('skips a malformed digest file without throwing and still returns the rest', () => {
    const dir = digestsDir(root);
    mkdirSync(dir, { recursive: true });
    // No frontmatter delimiters at all — gray-matter still parses this as a
    // body-only doc with empty data, so it is scanned as an entry with a
    // filename-derived sessionId and createdMs 0 (best-effort, not an error).
    writeFileSync(join(dir, 'garbage.md'), 'not frontmatter at all, just prose', 'utf-8');
    writeFixtureDigest(root, 'sess-good', { createdAt: '2026-02-01T00:00:00.000Z' });

    expect(() => scanDigests(root)).not.toThrow();
    const entries = scanDigests(root);
    const ids = entries.map((e) => e.sessionId);
    expect(ids).toContain('sess-good');
  });
});

describe('runDigestGc', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('deletes every path in the plan and returns the count', () => {
    const f1 = writeFixtureDigest(root, 'sess-1');
    const f2 = writeFixtureDigest(root, 'sess-2');
    const kept = writeFixtureDigest(root, 'sess-3');

    const deleted = runDigestGc(root, { keep: [kept], deleteAbs: [f1, f2] });

    expect(deleted).toBe(2);
    expect(existsSync(f1)).toBe(false);
    expect(existsSync(f2)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it('is best-effort: one unlink failure does not stop the rest', () => {
    const dir = digestsDir(root);
    mkdirSync(dir, { recursive: true });
    const good1 = writeFixtureDigest(root, 'sess-good-1');
    const good2 = writeFixtureDigest(root, 'sess-good-2');
    // Simulate an unlink failure by pointing at a path that never existed —
    // unlinkSync throws ENOENT, which must not abort the loop.
    const missing = join(dir, 'sess-does-not-exist.md');

    const deleted = runDigestGc(root, { keep: [], deleteAbs: [good1, missing, good2] });

    expect(deleted).toBe(2);
    expect(existsSync(good1)).toBe(false);
    expect(existsSync(good2)).toBe(false);
  });

  it('refuses to unlink a path outside this root digests directory (defense in depth)', () => {
    const outside = join(tmpdir(), `outside-${Date.now()}.md`);
    writeFileSync(outside, 'do not delete me', 'utf-8');
    try {
      const deleted = runDigestGc(root, { keep: [], deleteAbs: [outside] });
      expect(deleted).toBe(0);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('returns 0 for an empty delete plan', () => {
    expect(runDigestGc(root, { keep: [], deleteAbs: [] })).toBe(0);
  });
});
