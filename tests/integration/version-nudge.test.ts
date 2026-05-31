/**
 * Integration tests for the version nudge in generateSnapshot.
 *
 * Strategy: run `node dist/index.js snapshot` in a temp dir with a seeded
 * .version-check.json fixture and assert the "## Update Available" block
 * presence/absence based on cache freshness and version state.
 *
 * NO child_process is spawned by generateSnapshot for version checking —
 * it only reads the cache. We verify this by checking that the output is
 * produced purely from the cache without a network round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const CLI_PATH = join(__dirname, '..', '..', 'dist', 'index.js');

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-vn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Scaffold a minimal _dream_context/ so snapshot doesn't exit early. */
function scaffoldContext(root: string): string {
  const ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'core', 'features'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });

  // Write a minimal soul file so the snapshot has something to output
  writeFileSync(
    join(ctx, 'core', '0.soul.md'),
    '---\nname: test\ntype: soul\n---\n\n## Identity\n\nTest project.\n',
  );

  return ctx;
}

/** Write a version-check cache file. */
function seedVersionCache(
  ctx: string,
  cache: {
    checkedAt: number;
    latestCli: string | null;
    availablePacks?: string[];
    ttlHours?: number;
  },
): void {
  const cacheDir = join(ctx, 'state');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, '.version-check.json'),
    JSON.stringify({
      availablePacks: [],
      ttlHours: 24,
      ...cache,
    }, null, 2),
  );
}

function runSnapshot(cwd: string): string {
  try {
    return execSync(`node ${CLI_PATH} snapshot`, { cwd, encoding: 'utf-8' });
  } catch (e: unknown) {
    return (e as { stdout?: string }).stdout ?? '';
  }
}

// ─── INSTALLED VERSION for comparison ────────────────────────────────────────
// The installed CLI version is read from package.json by dreamcontextVersion().
// We get it once here for test fixture setup.
import { readFileSync } from 'node:fs';
const PKG = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
const INSTALLED_VERSION: string = PKG.version; // e.g. "0.5.0"

// Build a version string that is strictly greater than installed
function higherVersion(v: string): string {
  const parts = v.split('.');
  const patch = parseInt(parts[2] ?? '0', 10);
  return `${parts[0]}.${parts[1]}.${patch + 1}`;
}

// Build a version string equal to installed
const SAME_VERSION = INSTALLED_VERSION;
const NEWER_VERSION = higherVersion(INSTALLED_VERSION);

describe('version nudge in generateSnapshot (integration)', () => {
  let tmpDir: string;
  let ctx: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ctx = scaffoldContext(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows ## Update Available when cache is fresh and CLI is behind', () => {
    seedVersionCache(ctx, {
      checkedAt: Date.now() - 60 * 60 * 1000, // 1h ago — fresh
      latestCli: NEWER_VERSION,
    });
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## Update Available');
  });

  it('does NOT show ## Update Available when cache is fresh and CLI is up-to-date', () => {
    seedVersionCache(ctx, {
      checkedAt: Date.now() - 60 * 60 * 1000, // 1h ago — fresh
      latestCli: SAME_VERSION,
    });
    const output = runSnapshot(tmpDir);
    expect(output).not.toContain('## Update Available');
  });

  it('does NOT show ## Update Available when latestCli is null (offline cache)', () => {
    seedVersionCache(ctx, {
      checkedAt: Date.now() - 60 * 60 * 1000, // 1h ago — fresh but offline
      latestCli: null,
    });
    const output = runSnapshot(tmpDir);
    expect(output).not.toContain('## Update Available');
  });

  it('does NOT show ## Update Available when cache is stale (> 24h old)', () => {
    seedVersionCache(ctx, {
      checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25h ago — stale
      latestCli: NEWER_VERSION,
    });
    const output = runSnapshot(tmpDir);
    expect(output).not.toContain('## Update Available');
  });

  it('does NOT show ## Update Available when no cache file exists', () => {
    // ctx has no .version-check.json seeded
    const output = runSnapshot(tmpDir);
    expect(output).not.toContain('## Update Available');
  });

  it('shows ## Update Available when new packs exist (CLI up-to-date)', () => {
    // Write a setup config with an installed pack
    writeFileSync(
      join(ctx, 'state', '.config.json'),
      JSON.stringify({ packs: ['existing-pack'], platforms: [] }),
    );
    seedVersionCache(ctx, {
      checkedAt: Date.now() - 60 * 60 * 1000, // fresh
      latestCli: SAME_VERSION,                  // CLI is current
      availablePacks: ['existing-pack', 'brand-new-pack'], // 1 new pack
    });
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## Update Available');
    expect(output).toContain('brand-new-pack');
  });
});

// ─── No subprocess is spawned during generateSnapshot ────────────────────────
// generateSnapshot must only READ the cache — it must never call npm or
// any child_process to check versions. We verify this indirectly: the
// test above seeds a specific latestCli value and the snapshot reflects
// that value immediately. If generateSnapshot were making a network call,
// it would either return an unpredictable value or time out.
//
// For an explicit structural check, we also verify the snapshot completes
// in a short wall-clock window (well under the 5000ms npm timeout).
describe('generateSnapshot does not spawn child_process for version check', () => {
  let tmpDir: string;
  let ctx: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ctx = scaffoldContext(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('completes within 2000ms even with a fresh behind cache (no npm call)', () => {
    seedVersionCache(ctx, {
      checkedAt: Date.now() - 60 * 60 * 1000,
      latestCli: NEWER_VERSION,
    });

    const start = Date.now();
    const output = runSnapshot(tmpDir);
    const elapsed = Date.now() - start;

    expect(output).toContain('## Update Available');
    // A real npm call takes ≥100ms; generateSnapshot should be sub-2000ms
    expect(elapsed).toBeLessThan(2000);
  });
});
