import { describe, it, expect } from 'vitest';
import {
  collectBrainDirty,
  renderBrainDirtyWarning,
  BRAIN_DIRTY_MAX_LISTED,
} from '../../src/lib/brain-dirty.js';

describe('collectBrainDirty', () => {
  // A topLevelImpl that agrees projectRoot IS the repo's own top-level — the
  // baseline used by every test below that is NOT specifically exercising the
  // toplevel guard itself.
  const sameRootTopLevel = (cwd: string) => cwd;

  it('scopes results to the context dir, excluding code paths', () => {
    const statusImpl = () => [
      '_dream_context/core/CHANGELOG.json',
      'src/foo.ts',
      '_dream_context/knowledge/x.md',
    ];
    const report = collectBrainDirty('/repo', { statusImpl, topLevelImpl: sameRootTopLevel });
    expect(report.unavailable).toBe(false);
    expect(report.paths).toEqual([
      '_dream_context/core/CHANGELOG.json',
      '_dream_context/knowledge/x.md',
    ]);
  });

  it('returns an empty report (no warning) on a clean tree', () => {
    const report = collectBrainDirty('/repo', { statusImpl: () => [], topLevelImpl: sameRootTopLevel });
    expect(report.paths).toEqual([]);
    expect(report.unavailable).toBe(false);
  });

  it('marks unavailable when the status probe throws, rather than reporting clean', () => {
    const statusImpl = () => { throw new Error('git not found'); };
    const report = collectBrainDirty('/repo', { statusImpl, topLevelImpl: sameRootTopLevel });
    expect(report.paths).toEqual([]);
    expect(report.unavailable).toBe(true);
  });

  it('respects a custom contextDirName', () => {
    const statusImpl = () => ['my-brain/state/x.json', 'src/bar.ts'];
    const report = collectBrainDirty('/repo', { statusImpl, contextDirName: 'my-brain', topLevelImpl: sameRootTopLevel });
    expect(report.paths).toEqual(['my-brain/state/x.json']);
  });

  it('repo-root-match: projectRoot IS the repo top-level — reports normally', () => {
    const statusImpl = () => ['_dream_context/state/x.json'];
    const report = collectBrainDirty('/repo', { statusImpl, topLevelImpl: (cwd) => cwd });
    expect(report.unavailable).toBe(false);
    expect(report.paths).toEqual(['_dream_context/state/x.json']);
  });

  it('nested-non-repo: projectRoot sits inside an enclosing repo — reports unavailable, never the enclosing repo\'s files', () => {
    const statusImpl = () => [
      // What the ENCLOSING repo's status would show — must NEVER surface.
      'some-other-project/_dream_context/state/x.json',
    ];
    const report = collectBrainDirty('/enclosing/nested-vault', {
      statusImpl,
      topLevelImpl: () => '/enclosing', // toplevel walks UP past the nested vault
    });
    expect(report.unavailable).toBe(true);
    expect(report.paths).toEqual([]);
  });

  it('rev-parse failure (not a repo at all, or git absent): unavailable', () => {
    const statusImpl = () => ['_dream_context/state/x.json'];
    const report = collectBrainDirty('/no/repo/here', { statusImpl, topLevelImpl: () => null });
    expect(report.unavailable).toBe(true);
    expect(report.paths).toEqual([]);
  });

  it('rev-parse throwing is also treated as unavailable', () => {
    const statusImpl = () => ['_dream_context/state/x.json'];
    const topLevelImpl = () => { throw new Error('not a git repository'); };
    const report = collectBrainDirty('/no/repo/here', { statusImpl, topLevelImpl });
    expect(report.unavailable).toBe(true);
    expect(report.paths).toEqual([]);
  });

  it('defaults to the real repoToplevel/statusPorcelainTracked when no impls are injected (production wiring)', () => {
    // A bogus path is neither a repo nor its own top-level — real repoToplevel
    // returns null (or an unrelated ancestor), never a match, so this must be
    // unavailable rather than accidentally trusting an ancestor repo's status.
    const report = collectBrainDirty('/definitely/not/a/real/repo/path/xyz');
    expect(report.unavailable).toBe(true);
    expect(report.paths).toEqual([]);
  });
});

describe('renderBrainDirtyWarning', () => {
  const opts = { contextDirName: '_dream_context', today: '2026-07-18' };

  it('emits nothing for a clean tree', () => {
    const lines = renderBrainDirtyWarning({ paths: [], unavailable: false }, opts);
    expect(lines).toEqual([]);
  });

  it('reports inconclusive rather than clean when unavailable', () => {
    const lines = renderBrainDirtyWarning({ paths: [], unavailable: true }, opts);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toMatch(/clean/i);
    expect(lines.join('\n')).toMatch(/could not verify/i);
  });

  it('lists dirty paths and the exact ready-to-run commit command', () => {
    const lines = renderBrainDirtyWarning(
      { paths: ['_dream_context/core/CHANGELOG.json'], unavailable: false },
      opts,
    );
    const joined = lines.join('\n');
    expect(joined).toContain('_dream_context/core/CHANGELOG.json');
    expect(joined).toContain('git add -A -- _dream_context');
    expect(joined).toContain('chore(brain): consolidate 2026-07-18 sleep output');
  });

  it('never emits a bare `git add -A` or executes a commit', () => {
    const lines = renderBrainDirtyWarning(
      { paths: ['_dream_context/x.md'], unavailable: false },
      opts,
    );
    const joined = lines.join('\n');
    expect(joined).not.toMatch(/git add -A(?! -- )/);
    expect(joined).not.toMatch(/git add -A$/m);
  });

  it('caps the listed paths at BRAIN_DIRTY_MAX_LISTED and summarizes the rest', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `_dream_context/state/file-${i}.md`);
    const lines = renderBrainDirtyWarning({ paths, unavailable: false }, opts);
    const listedLines = lines.filter((l) => l.trim().startsWith('- '));
    expect(listedLines).toHaveLength(BRAIN_DIRTY_MAX_LISTED);
    expect(lines.join('\n')).toContain('and 25 more');
  });

  it('BRAIN_DIRTY_MAX_LISTED is 15', () => {
    expect(BRAIN_DIRTY_MAX_LISTED).toBe(15);
  });
});
