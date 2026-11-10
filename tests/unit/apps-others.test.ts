/**
 * A teammate's app on this Mac (app-veri-ortak r6, K9; criterion 10). Its hand-made data came with
 * the brain (tracked under `_dream_context/apps/<slug>/`) though the app is not installed here:
 *  - the Apps page shows ONE row, "Takımın app'i · verisi bu beyinde (N dosya)", titled from its
 *    knowledge note, and never also an orphan-data row for the same slug;
 *  - an install keeps the slug and the folder (`freeSlug` treats the team folder as "keep this
 *    slug"); a slug another registered app holds is `team_slug_taken`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appOthers, trackedAppFiles } from '../../src/lib/apps/others.js';
import { ensureAppDataDir } from '../../src/lib/apps/data-dir.js';
import { registerApp } from '../../src/lib/apps/registry.js';
import { freeSlug, InstallError } from '../../src/lib/apps/share/install.js';

let home: string;
let project: string;
let ctx: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'pipe' }).toString();

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-others-')));
  project = join(home, 'acme');
  ctx = join(project, '_dream_context');
  mkdirSync(ctx, { recursive: true });
  git('init', '-q');
  // The team's data: tracked (a teammate pushed it), here on disk after the pull.
  const crm = ensureAppDataDir(project, 'rakip');
  mkdirSync(join(crm, 'favorites'), { recursive: true });
  writeFileSync(join(crm, 'favorites', 'a1.json'), '{"id":"a1"}');
  writeFileSync(join(crm, 'favorites', 'b2.json'), '{"id":"b2"}');
  git('add', '-f', '--', '_dream_context/apps/rakip/favorites');
  // A removed app's data: on disk, never tracked.
  writeFileSync(join(ensureAppDataDir(project, 'old-app'), 'x.json'), '{}');
  mkdirSync(join(ctx, 'knowledge', 'apps'), { recursive: true });
  writeFileSync(join(ctx, 'knowledge', 'apps', 'rakip.md'), '---\napp: rakip\ntitle: Rakip İstihbaratı\n---\n');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the team row (criterion 10)', () => {
  it('a tracked, unregistered app folder is "the team\'s app · its data in this brain", once, titled from its note', () => {
    expect(trackedAppFiles(project).get('rakip')?.sort()).toEqual(['favorites/a1.json', 'favorites/b2.json']);
    const others = appOthers(project, new Set());
    expect(others).toEqual([
      { kind: 'team-data', slug: 'rakip', title: 'Rakip İstihbaratı', files: 2, dataPath: '_dream_context/apps/rakip', knowledgeId: 'apps/rakip' },
      { kind: 'orphan-data', slug: 'old-app', dataPath: '_dream_context/apps/old-app' },
    ]);
    expect(others.filter((o) => o.slug === 'rakip')).toHaveLength(1);
  });

  it('the row goes once the app is installed here', () => {
    expect(appOthers(project, new Set(['rakip'])).map((o) => o.slug)).toEqual(['old-app']);
  });

  it('with no note, the slug is its title and there is no note to open', () => {
    rmSync(join(ctx, 'knowledge', 'apps', 'rakip.md'));
    expect(appOthers(project, new Set())[0]).toMatchObject({ kind: 'team-data', title: 'rakip', knowledgeId: null });
  });
});

describe('installing onto the team\'s folder keeps the slug', () => {
  it('the team folder keeps its slug; without the team it would be renamed', () => {
    expect(freeSlug(home, project, 'rakip', true)).toBe('rakip');
    expect(freeSlug(home, project, 'rakip', false)).toBe('rakip-2');
  });

  it('a slug another registered app holds: team_slug_taken, nothing renamed', () => {
    const root = join(`${project}-apps`, 'rakip');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'rakip', name: 'Mine' }));
    registerApp(home, { projectRoot: project, vault: 'acme', slug: 'rakip', name: 'Mine', root });
    let err: unknown = null;
    try { freeSlug(home, project, 'rakip', true); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).code).toBe('team_slug_taken');
  });
});
