import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  shareAutomation,
  unshareAutomation,
  assertShareOrdering,
  listSharedSlugs,
  pruneStrayNegations,
} from '../../src/lib/automations/sharing.js';
import {
  AUTOMATIONS_GITIGNORE_ENTRIES,
  AUTOMATIONS_GITIGNORE_ENTRIES_ROOT,
  sharedSlugNegations,
  sharedSlugNegationsRoot,
} from '../../src/lib/automations/types.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function initRepo(cwd: string): void {
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test']);
}

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-sharing-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('shareAutomation — real git verification (in-tree topology: project root IS the git root)', () => {
  it('publishes exactly one slug\'s manifest, cache and output while a sibling stays private, and lock/sidecar stay ignored', () => {
    initRepo(projectRoot);

    mkdirSync(join(contextRoot, 'automations', 'cache'), { recursive: true });
    mkdirSync(join(contextRoot, 'automations', 'output', 'shared-one'), { recursive: true });
    mkdirSync(join(contextRoot, 'automations', 'output', 'private-one'), { recursive: true });
    for (const slug of ['shared-one', 'private-one']) {
      writeFileSync(join(contextRoot, 'automations', `${slug}.md`), `# ${slug}\n`, 'utf-8');
      writeFileSync(join(contextRoot, 'automations', 'cache', `${slug}.json`), '{}', 'utf-8');
      writeFileSync(join(contextRoot, 'automations', 'output', slug, '2026-07-26.md'), 'output\n', 'utf-8');
    }
    writeFileSync(join(contextRoot, 'automations', 'cache', '.shared-one.lock'), '{}', 'utf-8');
    writeFileSync(join(contextRoot, 'automations', 'cache', '.shared-one.run.json'), '{}', 'utf-8');

    // The base block already exists at manifest-creation time in the real
    // system (store.ts writes it before the first manifest); write it
    // directly here since this test targets sharing.ts in isolation.
    writeFileSync(join(projectRoot, '.gitignore'), AUTOMATIONS_GITIGNORE_ENTRIES_ROOT.join('\n') + '\n', 'utf-8');

    const result = shareAutomation(contextRoot, 'shared-one');
    expect(result.shared).toBe(true);
    expect(result.repairedOrdering).toBe(false);
    // shareAutomation always writes BOTH governing files — contextRoot's
    // .gitignore didn't exist yet in this fixture, so it is created fresh and
    // its three brain-relative negations count as "added" too, alongside the
    // root-relative ones this test cares about.
    expect([...result.added].sort()).toEqual(
      [...sharedSlugNegations('shared-one'), ...sharedSlugNegationsRoot('shared-one')].sort(),
    );

    // Literal check-ignore proof.
    expect(() =>
      git(projectRoot, ['check-ignore', '_dream_context/automations/private-one.md']),
    ).not.toThrow();
    expect(() => git(projectRoot, ['check-ignore', '_dream_context/automations/shared-one.md'])).toThrow();
    expect(() =>
      git(projectRoot, ['check-ignore', '_dream_context/automations/cache/.shared-one.lock']),
    ).not.toThrow();
    expect(() =>
      git(projectRoot, ['check-ignore', '_dream_context/automations/cache/.shared-one.run.json']),
    ).not.toThrow();

    // Real staging proof — the actual population that would land in a commit.
    git(projectRoot, ['add', '-A']);
    const tracked = git(projectRoot, ['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean);

    expect(tracked).toContain('_dream_context/automations/shared-one.md');
    expect(tracked).toContain('_dream_context/automations/cache/shared-one.json');
    expect(tracked).toContain('_dream_context/automations/output/shared-one/2026-07-26.md');

    expect(tracked).not.toContain('_dream_context/automations/private-one.md');
    expect(tracked).not.toContain('_dream_context/automations/cache/private-one.json');
    expect(tracked).not.toContain('_dream_context/automations/output/private-one/2026-07-26.md');

    expect(tracked).not.toContain('_dream_context/automations/cache/.shared-one.lock');
    expect(tracked).not.toContain('_dream_context/automations/cache/.shared-one.run.json');
  });
});

describe('shareAutomation — real git verification (full-repo topology: contextRoot IS the git root)', () => {
  it('publishes via the brain-relative gitignore when _dream_context is its own repo', () => {
    initRepo(contextRoot);

    mkdirSync(join(contextRoot, 'automations', 'cache'), { recursive: true });
    mkdirSync(join(contextRoot, 'automations', 'output', 'shared-two'), { recursive: true });
    writeFileSync(join(contextRoot, 'automations', 'shared-two.md'), '# shared-two\n', 'utf-8');
    writeFileSync(join(contextRoot, 'automations', 'cache', 'shared-two.json'), '{}', 'utf-8');
    writeFileSync(join(contextRoot, 'automations', 'output', 'shared-two', '2026-07-26.md'), 'output\n', 'utf-8');
    writeFileSync(join(contextRoot, 'automations', 'cache', '.shared-two.lock'), '{}', 'utf-8');

    writeFileSync(join(contextRoot, '.gitignore'), AUTOMATIONS_GITIGNORE_ENTRIES.join('\n') + '\n', 'utf-8');

    shareAutomation(contextRoot, 'shared-two');

    git(contextRoot, ['add', '-A']);
    const tracked = git(contextRoot, ['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean);

    expect(tracked).toContain('automations/shared-two.md');
    expect(tracked).toContain('automations/cache/shared-two.json');
    expect(tracked).toContain('automations/output/shared-two/2026-07-26.md');
    expect(tracked).not.toContain('automations/cache/.shared-two.lock');
  });
});

describe('assertShareOrdering + shareAutomation repair (F2)', () => {
  it('reports ok:false when a negation sits above its wildcard, and shareAutomation repairs it before appending', () => {
    // Hand-craft a BROKEN root .gitignore: negation for "broken-one" placed
    // ABOVE the base wildcard block — the exact F2 shape, silently dropped by
    // git with no error and no warning.
    const brokenText = ['!_dream_context/automations/broken-one.md', ...AUTOMATIONS_GITIGNORE_ENTRIES_ROOT].join('\n') + '\n';
    writeFileSync(join(projectRoot, '.gitignore'), brokenText, 'utf-8');

    const before = assertShareOrdering(contextRoot);
    expect(before.ok).toBe(false);
    expect(before.problems.length).toBeGreaterThan(0);

    const result = shareAutomation(contextRoot, 'broken-one');
    expect(result.repairedOrdering).toBe(true);

    const after = assertShareOrdering(contextRoot);
    expect(after.ok).toBe(true);

    const lines = readFileSync(join(projectRoot, '.gitignore'), 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const negIndex = lines.indexOf('!_dream_context/automations/broken-one.md');
    expect(negIndex).toBeGreaterThan(-1);
    for (const entry of AUTOMATIONS_GITIGNORE_ENTRIES_ROOT) {
      expect(lines.indexOf(entry)).toBeLessThan(negIndex);
    }

    // The repair must be real, not just self-reported: stage it for real.
    initRepo(projectRoot);
    mkdirSync(join(contextRoot, 'automations'), { recursive: true });
    writeFileSync(join(contextRoot, 'automations', 'broken-one.md'), '# broken-one\n', 'utf-8');
    git(projectRoot, ['add', '-A']);
    const tracked = git(projectRoot, ['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean);
    expect(tracked).toContain('_dream_context/automations/broken-one.md');
  });

  it('does not repair (and reports repairedOrdering: false) when the block is already well-formed', () => {
    writeFileSync(join(projectRoot, '.gitignore'), AUTOMATIONS_GITIGNORE_ENTRIES_ROOT.join('\n') + '\n', 'utf-8');
    expect(assertShareOrdering(contextRoot).ok).toBe(true);

    const result = shareAutomation(contextRoot, 'clean-one');
    expect(result.repairedOrdering).toBe(false);
  });
});

describe('listSharedSlugs — order-aware, not set-membership', () => {
  it('returns [] for a slug whose negation exists but is misordered (silently ineffective)', () => {
    const brokenText = ['!_dream_context/automations/ghost.md', ...AUTOMATIONS_GITIGNORE_ENTRIES_ROOT].join('\n') + '\n';
    writeFileSync(join(projectRoot, '.gitignore'), brokenText, 'utf-8');
    expect(listSharedSlugs(contextRoot)).toEqual([]);
  });

  it('returns the slug once its negation is correctly ordered', () => {
    writeFileSync(
      join(projectRoot, '.gitignore'),
      [...AUTOMATIONS_GITIGNORE_ENTRIES_ROOT, ...sharedSlugNegationsRoot('real-one')].join('\n') + '\n',
      'utf-8',
    );
    expect(listSharedSlugs(contextRoot)).toEqual(['real-one']);
  });

  it('unions both governing files, dedupes and sorts', () => {
    writeFileSync(
      join(projectRoot, '.gitignore'),
      [...AUTOMATIONS_GITIGNORE_ENTRIES_ROOT, ...sharedSlugNegationsRoot('b-slug')].join('\n') + '\n',
      'utf-8',
    );
    writeFileSync(
      join(contextRoot, '.gitignore'),
      [...AUTOMATIONS_GITIGNORE_ENTRIES, ...sharedSlugNegations('a-slug')].join('\n') + '\n',
      'utf-8',
    );
    expect(listSharedSlugs(contextRoot)).toEqual(['a-slug', 'b-slug']);
  });
});

describe('unshareAutomation', () => {
  it('removes exactly the three negation lines from both gitignore files, and nothing else', () => {
    writeFileSync(
      join(projectRoot, '.gitignore'),
      [...AUTOMATIONS_GITIGNORE_ENTRIES_ROOT, ...sharedSlugNegationsRoot('to-unshare'), '!other/unrelated.txt'].join('\n') +
        '\n',
      'utf-8',
    );
    writeFileSync(
      join(contextRoot, '.gitignore'),
      [...AUTOMATIONS_GITIGNORE_ENTRIES, ...sharedSlugNegations('to-unshare')].join('\n') + '\n',
      'utf-8',
    );

    const result = unshareAutomation(contextRoot, 'to-unshare');
    expect(result.shared).toBe(false);
    expect([...result.removed].sort()).toEqual(
      [...sharedSlugNegations('to-unshare'), ...sharedSlugNegationsRoot('to-unshare')].sort(),
    );

    expect(listSharedSlugs(contextRoot)).toEqual([]);

    const rootLines = readFileSync(join(projectRoot, '.gitignore'), 'utf-8')
      .split('\n')
      .map((l) => l.trim());
    expect(rootLines).toContain('!other/unrelated.txt');
    for (const entry of AUTOMATIONS_GITIGNORE_ENTRIES_ROOT) expect(rootLines).toContain(entry);
  });
});

describe('pruneStrayNegations (S3 — auto-repair the unsafe drift direction)', () => {
  it('removes negations for slugs whose flag is false, leaving others alone', () => {
    writeFileSync(
      join(projectRoot, '.gitignore'),
      [...AUTOMATIONS_GITIGNORE_ENTRIES_ROOT, ...sharedSlugNegationsRoot('stray'), ...sharedSlugNegationsRoot('keep')].join(
        '\n',
      ) + '\n',
      'utf-8',
    );

    const removed = pruneStrayNegations(contextRoot, ['stray']);
    expect([...removed].sort()).toEqual([...sharedSlugNegationsRoot('stray')].sort());
    expect(listSharedSlugs(contextRoot)).toEqual(['keep']);
  });

  it('is a no-op when no slug in the list has a stray negation', () => {
    writeFileSync(join(projectRoot, '.gitignore'), AUTOMATIONS_GITIGNORE_ENTRIES_ROOT.join('\n') + '\n', 'utf-8');
    expect(pruneStrayNegations(contextRoot, ['never-shared'])).toEqual([]);
  });
});

describe('input guards', () => {
  it('throws on an empty or whitespace-only slug rather than writing a corrupt negation', () => {
    expect(() => shareAutomation(contextRoot, '')).toThrow();
    expect(() => unshareAutomation(contextRoot, '   ')).toThrow();
  });
});
