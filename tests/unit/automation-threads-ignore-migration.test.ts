import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migration0280 } from '../../src/migrations/0.28.0.js';
import { listSharedSlugs, assertShareOrdering } from '../../src/lib/automations/sharing.js';
import { negationIsEffective, AUTOMATIONS_GITIGNORE_ENTRIES_ROOT } from '../../src/lib/automations/types.js';

/**
 * The 0.28.0 threads ignore migration, proved by GIT — not by reading the
 * `.gitignore` back and trusting our own ordering predicate. The failure this
 * migration exists to prevent (a base wildcard appended below existing
 * negations, silently disabling every one of them) is invisible to string
 * matching and visible to `git check-ignore`, so that is what is asserted.
 *
 * The fixture is the PRE-MIGRATION shape on purpose: the old six-entry base
 * block with no threads wildcard, and two slugs shared under the old
 * three-line negation set.
 */

const PRE_MIGRATION_BASE = [
  '_dream_context/automations/cache/*.lock',
  '_dream_context/automations/cache/*.run.json',
  '_dream_context/automations/cache/*.run.json.tmp',
  '_dream_context/automations/*.md',
  '_dream_context/automations/cache/*.json',
  '_dream_context/automations/output/*/*',
];

function oldNegations(slug: string): string[] {
  return [
    `!_dream_context/automations/${slug}.md`,
    `!_dream_context/automations/cache/${slug}.json`,
    `!_dream_context/automations/output/${slug}/*`,
  ];
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-threads-mig-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** A vault as 0.27 left it: old base block, two slugs shared, one private,
 *  and every one of them with a day file already in its channel. */
function seedPreMigrationVault(): void {
  git(projectRoot, ['init', '-q']);
  git(projectRoot, ['config', 'user.email', 'test@example.com']);
  git(projectRoot, ['config', 'user.name', 'Test']);

  for (const slug of ['shared-a', 'shared-b', 'private-c']) {
    mkdirSync(join(contextRoot, 'automations', 'threads', slug), { recursive: true });
    writeFileSync(join(contextRoot, 'automations', 'threads', slug, '2026-09-20.md'), '---\n', 'utf-8');
    writeFileSync(join(contextRoot, 'automations', `${slug}.md`), `# ${slug}\n`, 'utf-8');
  }

  writeFileSync(
    join(projectRoot, '.gitignore'),
    [...PRE_MIGRATION_BASE, ...oldNegations('shared-a'), ...oldNegations('shared-b')].join('\n') + '\n',
    'utf-8',
  );
}

function stagedPaths(): string[] {
  git(projectRoot, ['add', '-A']);
  return git(projectRoot, ['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean);
}

describe('migration 0.28.0 — automation thread channels follow their automation', () => {
  it('a private automation\'s channel is ignored and a shared one\'s publishes, proved by git', () => {
    seedPreMigrationVault();

    // BEFORE: the old block has no threads wildcard at all, so EVERY channel
    // publishes — including the private one. That is the leak being closed,
    // and it is asserted rather than assumed so the test fails loudly if the
    // pre-migration shape ever stops being the shape we are migrating from.
    expect(stagedPaths()).toContain('_dream_context/automations/threads/private-c/2026-09-20.md');
    git(projectRoot, ['reset', '-q']);

    const result = migration0280.steps[0](contextRoot);
    expect(result.detected).toBe(false);
    expect(result.filesTouched).toContain(join(projectRoot, '.gitignore'));

    const tracked = stagedPaths();
    expect(tracked).not.toContain('_dream_context/automations/threads/private-c/2026-09-20.md');
    expect(tracked).toContain('_dream_context/automations/threads/shared-a/2026-09-20.md');
    expect(tracked).toContain('_dream_context/automations/threads/shared-b/2026-09-20.md');
  });

  it('leaves every pre-existing share intact — the F2 regression this migration is for', () => {
    seedPreMigrationVault();
    migration0280.steps[0](contextRoot);

    // The whole hazard: a wildcard appended BELOW these negations disables
    // them, git says nothing, and both slugs go dark while their frontmatter
    // still claims shared: true.
    const text = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    for (const slug of ['shared-a', 'shared-b']) {
      for (const line of oldNegations(slug)) {
        expect(negationIsEffective(text, line, AUTOMATIONS_GITIGNORE_ENTRIES_ROOT)).toBe(true);
      }
    }
    expect(assertShareOrdering(contextRoot).ok).toBe(true);
    expect(listSharedSlugs(contextRoot).sort()).toEqual(['shared-a', 'shared-b']);

    const tracked = stagedPaths();
    expect(tracked).toContain('_dream_context/automations/shared-a.md');
    expect(tracked).toContain('_dream_context/automations/shared-b.md');
    expect(tracked).not.toContain('_dream_context/automations/private-c.md');
  });

  it('is idempotent — a second run writes nothing and reports detected', () => {
    seedPreMigrationVault();
    migration0280.steps[0](contextRoot);
    const after = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');

    const second = migration0280.steps[0](contextRoot);
    expect(second.detected).toBe(true);
    expect(second.filesTouched).toEqual([]);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toBe(after);
  });

  it('never conjures an automations block into a vault that has none', () => {
    git(projectRoot, ['init', '-q']);
    writeFileSync(join(projectRoot, '.gitignore'), 'node_modules/\n', 'utf-8');

    const result = migration0280.steps[0](contextRoot);
    expect(result.detected).toBe(true);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toBe('node_modules/\n');
  });
});
