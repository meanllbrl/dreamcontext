import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * REGRESSION: `install-skill` and `setup` used to stamp `setupVersion` WITHOUT
 * running migrations first.
 *
 * `setupVersion` is the lower bound of the migration runner's half-open range
 * `(setupVersion, cliVersion]`. Stamping it early makes the next `update`
 * compute `(cliVersion, cliVersion]` = empty and apply nothing — and
 * `unfinishedAgentTasks` can't rescue it either, because it requires a
 * code/detected ledger entry before reporting an agent task, so a vault
 * stranded this way reads as FRESH.
 *
 * Reproduced live on a real 0.18.0 vault (2026-07-30): `update` refuses on a
 * platform-less vault with "run dreamcontext install-skill first", and doing
 * exactly that permanently discarded the 0.23.0 people-first + soul-split
 * migrations. Both commands now go through migrateThenStampSetupVersion.
 *
 * `readGitIdentity` shells out to `git config`, which on a dev machine falls
 * through to the GLOBAL config — a real identity would leak into the fixture.
 */
const git = vi.hoisted(() => ({ name: 'Ada Lovelace', email: 'ada@example.com' }));

vi.mock('../../src/lib/git-sync/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/git-sync/git.js')>();
  return { ...actual, readGitIdentity: () => ({ name: git.name, email: git.email }) };
});

const { migrateThenStampSetupVersion } = await import('../../src/lib/migrate-and-stamp.js');
const { readSetupConfig } = await import('../../src/lib/setup-config.js');
const { readLedger } = await import('../../src/lib/migration-ledger.js');
const { dreamcontextVersion } = await import('../../src/lib/manifest.js');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const LEGACY_USER_MD = `---
name: user-preferences
type: user
updated: "2026-01-01"
---

## Identity

- Founder; writes most of the code herself.

## User Preferences

- Ship small, reviewable diffs.

## Communication Style

- Terse. No preamble.

## Workflow Notes

- Deploys from main on green CI.
`;

/** A vault as it exists on a consumer machine that has not upgraded yet. */
function makeLegacyVault(setupVersion: string | null = '0.18.0'): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-stamp-'));
  const ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'core'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  mkdirSync(join(ctx, 'inbox'), { recursive: true });

  writeFileSync(join(ctx, 'core', '1.user.md'), LEGACY_USER_MD, 'utf-8');
  writeFileSync(
    join(ctx, 'core', '0.soul.md'),
    '---\nname: test\ntype: soul\n---\n\n## Project Identity\n\nA test project.\n',
    'utf-8',
  );
  writeFileSync(join(ctx, 'core', 'CHANGELOG.json'), '[]\n', 'utf-8');

  if (setupVersion !== null) {
    writeFileSync(
      join(ctx, 'state', '.config.json'),
      JSON.stringify({ setupVersion, platforms: ['claude'] }, null, 2),
      'utf-8',
    );
  }
  return root;
}

function ledgerSteps(root: string, version: string): string[] {
  return readLedger(join(root, '_dream_context'))
    .filter((e) => e.version === version)
    .map((e) => e.step);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('migrateThenStampSetupVersion', () => {
  const roots: string[] = [];
  function track(r: string): string { roots.push(r); return r; }

  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('THE BUG: migrates a legacy vault before stamping, instead of stranding it', () => {
    const root = track(makeLegacyVault('0.18.0'));
    const ctx = join(root, '_dream_context');

    const result = migrateThenStampSetupVersion(root, { platforms: ['claude'] });

    // The range was computed from the OLD version, so 0.23.0 actually ran.
    expect(result.fromVersion).toBe('0.18.0');
    expect(result.stamped).toBe(dreamcontextVersion());
    expect(result.failedSteps).toBe(0);

    // People-first genuinely happened — not just a version number moving.
    expect(existsSync(join(ctx, 'core', '1.user.md'))).toBe(false);
    expect(existsSync(join(ctx, 'people', 'people.json'))).toBe(true);

    const steps = ledgerSteps(root, '0.23.0');
    expect(steps).toContain('seed-people-from-config');
    expect(steps).toContain('split-user-file');

    // And the config carries BOTH the stamp and the caller's extra keys.
    const cfg = readSetupConfig(root);
    expect(cfg?.setupVersion).toBe(dreamcontextVersion());
    expect(cfg?.platforms).toEqual(['claude']);
  });

  it('leaves a ledger entry behind, so the vault can never read as FRESH afterwards', () => {
    const root = track(makeLegacyVault('0.18.0'));
    migrateThenStampSetupVersion(root);
    // unfinishedAgentTasks gates on a code/detected entry existing. The stranding
    // bug produced an EMPTY ledger, which is what made it invisible.
    expect(readLedger(join(root, '_dream_context')).length).toBeGreaterThan(0);
  });

  it('is idempotent — a second call re-runs nothing and keeps the stamp', () => {
    const root = track(makeLegacyVault('0.18.0'));
    migrateThenStampSetupVersion(root);
    const firstSteps = ledgerSteps(root, '0.23.0');

    const second = migrateThenStampSetupVersion(root);

    expect(second.fromVersion).toBe(dreamcontextVersion());
    expect(second.appliedCodeSteps).toEqual([]);
    expect(ledgerSteps(root, '0.23.0')).toEqual(firstSteps);
    expect(readSetupConfig(root)?.setupVersion).toBe(dreamcontextVersion());
  });

  it('treats a config-less vault as 0.0.0 rather than skipping its migrations', () => {
    const root = track(makeLegacyVault(null));
    const result = migrateThenStampSetupVersion(root);
    expect(result.fromVersion).toBe('0.0.0');
    expect(existsSync(join(root, '_dream_context', 'core', '1.user.md'))).toBe(false);
  });

  it('stamps without crashing when there is no vault yet (install-skill before init)', () => {
    const root = track(mkdtempSync(join(tmpdir(), 'dc-stamp-bare-')));
    const result = migrateThenStampSetupVersion(root, { platforms: ['claude'] });
    expect(result.stamped).toBe(dreamcontextVersion());
    expect(result.appliedCodeSteps).toEqual([]);
    expect(readSetupConfig(root)?.platforms).toEqual(['claude']);
  });
});

describe('migrateThenStampSetupVersion — partial failure', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('pins setupVersion when a migration fails, but still persists the other keys', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/migration-runner.js', () => ({
      runMigrations: () => ({ applied: [], pendingAgentTasks: [], failedSteps: 3 }),
    }));
    const { migrateThenStampSetupVersion: stamp } = await import(
      '../../src/lib/migrate-and-stamp.js'
    );

    const root = makeLegacyVault('0.18.0');
    roots.push(root);

    const result = stamp(root, { platforms: ['claude'] });

    expect(result.stamped).toBeNull();
    expect(result.failedSteps).toBe(3);
    // Pinned, so the next run retries the migration instead of skipping it.
    expect(readSetupConfig(root)?.setupVersion).toBe('0.18.0');
    // The install itself DID happen — non-gated keys must survive.
    expect(readSetupConfig(root)?.platforms).toEqual(['claude']);

    vi.doUnmock('../../src/lib/migration-runner.js');
  });
});

/**
 * Source-level tripwire. The defect class is "a command writes setupVersion on
 * its own", so guard the shape rather than any single call site: `init` is the
 * ONLY command allowed to stamp directly, because it scaffolds a brand-new
 * vault where there is nothing to migrate.
 */
describe('setupVersion write discipline', () => {
  const GUARDED = [
    'src/cli/commands/update.ts',
    'src/cli/commands/install-skill.ts',
    'src/cli/commands/setup.ts',
  ];

  it('no command other than init stamps setupVersion outside the shared helper', () => {
    for (const rel of GUARDED) {
      const src = readFileSync(join(process.cwd(), rel), 'utf-8');
      // Strip line comments so prose about setupVersion doesn't trip the guard.
      const code = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      expect(
        /setupVersion\s*:\s*dreamcontextVersion\(\)/.test(code),
        `${rel} stamps setupVersion directly — route it through migrateThenStampSetupVersion so migrations run first`,
      ).toBe(false);
    }
  });

  it('all three guarded commands go through the shared helper', () => {
    for (const rel of GUARDED) {
      const src = readFileSync(join(process.cwd(), rel), 'utf-8');
      expect(src, `${rel} should call migrateThenStampSetupVersion`).toContain(
        'migrateThenStampSetupVersion(',
      );
    }
  });

  it('init remains the documented exception (fresh vault, nothing to migrate)', () => {
    const src = readFileSync(join(process.cwd(), 'src/cli/commands/init.ts'), 'utf-8');
    expect(src).toMatch(/setupVersion\s*:\s*dreamcontextVersion\(\)/);
  });
});
