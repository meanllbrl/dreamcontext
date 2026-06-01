import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneStaleFiles } from '../../src/cli/commands/update.js';
import {
  emptyManifest,
  writeManifest,
  readManifest,
  PRE_MANIFEST_VERSION,
  type Manifest,
  type ManagedFileKind,
} from '../../src/lib/manifest.js';

// Mock the interactive confirm so we can drive the "declined" path. By default
// the prompt is only reached when process.stdin.isTTY is truthy; tests that
// exercise the decline path set isTTY true and resolve confirm to false.
const confirmMock = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
}));

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-prune-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function touch(root: string, rel: string, content = 'x'): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** Build an old manifest with the given file entries, file present on disk. */
function oldWith(tmp: string, entries: Record<string, { version: string; kind: ManagedFileKind }>): Manifest {
  const m = emptyManifest();
  for (const [path, entry] of Object.entries(entries)) {
    m.files[path] = entry;
    touch(tmp, path);
  }
  return m;
}

const WATCHLIST = '.claude/agents/watchlist-monitor.md';
const REVIEW_COORD = '.claude/agents/review-coordinator.md';

describe('pruneStaleFiles — partition + keep contract', () => {
  let tmp: string;
  let isTTY: boolean | undefined;

  beforeEach(() => {
    tmp = makeTmpDir();
    confirmMock.mockReset();
    isTTY = process.stdin.isTTY;
    // Default: silence console noise.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it('T5: never deletes a pre-manifest (heuristic) candidate; keeps + flags it', async () => {
    const old = oldWith(tmp, { [WATCHLIST]: { version: PRE_MANIFEST_VERSION, kind: 'agent' } });
    const next = emptyManifest(); // does not contain watchlist → it is "removed"

    const { removed, keep } = await pruneStaleFiles(tmp, old, next, false, true);

    expect(existsSync(join(tmp, WATCHLIST))).toBe(true);
    expect(removed).not.toContain(WATCHLIST);
    expect(keep).toContain(WATCHLIST);
  });

  it('T6: deletes a concrete-version owned candidate (yes:true)', async () => {
    const old = oldWith(tmp, { [REVIEW_COORD]: { version: '0.4.2', kind: 'agent' } });
    const next = emptyManifest();

    const { removed, keep } = await pruneStaleFiles(tmp, old, next, false, true);

    expect(existsSync(join(tmp, REVIEW_COORD))).toBe(false);
    expect(removed).toContain(REVIEW_COORD);
    expect(keep).not.toContain(REVIEW_COORD);
  });

  it('T7a (mixed, yes:true): owned deleted, heuristic kept', async () => {
    const old = oldWith(tmp, {
      [REVIEW_COORD]: { version: '0.4.2', kind: 'agent' },
      [WATCHLIST]: { version: PRE_MANIFEST_VERSION, kind: 'agent' },
    });
    const next = emptyManifest();

    const { removed, keep } = await pruneStaleFiles(tmp, old, next, false, true);

    expect(existsSync(join(tmp, REVIEW_COORD))).toBe(false);
    expect(existsSync(join(tmp, WATCHLIST))).toBe(true);
    expect(removed).toEqual([REVIEW_COORD]);
    expect(keep).toContain(WATCHLIST);
    expect(keep).not.toContain(REVIEW_COORD);
  });

  it('T7b (mixed, declined): neither deleted, both kept, written manifest retains both', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    confirmMock.mockResolvedValue(false); // user declines

    const old = oldWith(tmp, {
      [REVIEW_COORD]: { version: '0.4.2', kind: 'agent' },
      [WATCHLIST]: { version: PRE_MANIFEST_VERSION, kind: 'agent' },
    });
    const next = emptyManifest();

    const { removed, keep } = await pruneStaleFiles(tmp, old, next, false, false);

    expect(removed).toEqual([]);
    expect(keep).toContain(REVIEW_COORD);
    expect(keep).toContain(WATCHLIST);
    expect(existsSync(join(tmp, REVIEW_COORD))).toBe(true);
    expect(existsSync(join(tmp, WATCHLIST))).toBe(true);

    // Simulate the caller re-persisting keep, then assert the written manifest.
    for (const path of keep) {
      if (!next.files[path]) next.files[path] = old.files[path];
    }
    writeManifest(tmp, next);
    const written = readManifest(tmp)!;
    expect(written.files[REVIEW_COORD]).toBeDefined();
    expect(written.files[WATCHLIST]).toBeDefined();
  });

  it('T8: first-run flags owned (no partition delete)', async () => {
    const old = oldWith(tmp, { [REVIEW_COORD]: { version: '0.4.2', kind: 'agent' } });
    const next = emptyManifest();

    const { removed, keep } = await pruneStaleFiles(tmp, old, next, true, true);

    expect(removed).toEqual([]);
    expect(existsSync(join(tmp, REVIEW_COORD))).toBe(true);
    expect(keep).toContain(REVIEW_COORD);
  });

  it('T8b: non-first-run concrete owned with yes:true IS deleted (partition path)', async () => {
    const old = oldWith(tmp, { [REVIEW_COORD]: { version: '0.4.2', kind: 'agent' } });
    const next = emptyManifest();

    const { removed } = await pruneStaleFiles(tmp, old, next, false, true);

    expect(removed).toContain(REVIEW_COORD);
    expect(existsSync(join(tmp, REVIEW_COORD))).toBe(false);
  });

  it('T8c: first-run keeps ALL candidates (heuristic + owned) for caller re-persist', async () => {
    const old = oldWith(tmp, {
      [REVIEW_COORD]: { version: '0.4.2', kind: 'agent' },
      [WATCHLIST]: { version: PRE_MANIFEST_VERSION, kind: 'agent' },
    });
    const next = emptyManifest();

    const { removed, keep } = await pruneStaleFiles(tmp, old, next, true, true);

    expect(removed).toEqual([]);
    expect(keep).toContain(REVIEW_COORD);
    expect(keep).toContain(WATCHLIST);

    // Caller re-persist → written manifest retains BOTH first-run candidates.
    for (const path of keep) {
      if (!next.files[path]) next.files[path] = old.files[path];
    }
    writeManifest(tmp, next);
    const written = readManifest(tmp)!;
    expect(written.files[REVIEW_COORD]).toBeDefined();
    expect(written.files[WATCHLIST]).toBeDefined();
  });

  it('T9: unsafe path (_dream_context/) never deleted regardless of version', async () => {
    const unsafe = '_dream_context/foo';
    const old = oldWith(tmp, { [unsafe]: { version: '0.4.2', kind: 'core' } });
    const next = emptyManifest();

    const { removed, keep } = await pruneStaleFiles(tmp, old, next, false, true);

    expect(existsSync(join(tmp, unsafe))).toBe(true);
    expect(removed).not.toContain(unsafe);
    // Unsafe paths are excluded from candidates → not in keep either.
    expect(keep).not.toContain(unsafe);
  });

  it('T15 (cancel regression): declined owned + heuristic both survive on disk AND in written manifest', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    confirmMock.mockResolvedValue(false); // user cancels deletion

    const old = oldWith(tmp, {
      [REVIEW_COORD]: { version: '0.4.2', kind: 'agent' },
      [WATCHLIST]: { version: PRE_MANIFEST_VERSION, kind: 'agent' },
    });
    const next = emptyManifest();

    const { removed, keep } = await pruneStaleFiles(tmp, old, next, false, false);

    // Nothing deleted on disk.
    expect(removed).toEqual([]);
    expect(existsSync(join(tmp, REVIEW_COORD))).toBe(true);
    expect(existsSync(join(tmp, WATCHLIST))).toBe(true);

    // Caller re-persists keep unconditionally → both tracked for next run.
    for (const path of keep) {
      if (!next.files[path]) next.files[path] = old.files[path];
    }
    writeManifest(tmp, next);
    const written = readManifest(tmp)!;
    expect(written.files[REVIEW_COORD]).toBeDefined(); // owned-declined re-offered next run
    expect(written.files[WATCHLIST]).toBeDefined(); // heuristic protected forever
  });
});
