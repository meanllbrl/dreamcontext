import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAppDataDir } from '../../src/lib/apps/data-dir.js';
import { appDataInPushRange, appsExcludeSpec, incomingAppData } from '../../src/lib/apps/data-stage.js';
import * as gitLib from '../../src/lib/git-sync/git.js';
import { incomingSuperRecords } from '../../src/lib/super/pull-guard.js';

/**
 * app-veri-ortak K5 with real git, the back doors: the general stage never takes app data, a push
 * holds app data this Mac does not share, a pull refuses app data that may not come in. (The
 * exchange layer itself: apps-data-exchange-git.test.ts.)
 */
let base: string; let home: string;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', env });
/** A blob of `text` in the repo's object store. */
let blobSeq = 0;
const blob = (cwd: string, text: string) => {
  // Through a file in the scratch dir, never git's stdin (a piped `input` can block hash-object).
  const file = join(base, `.blob-${process.pid}-${++blobSeq}`);
  writeFileSync(file, text);
  try {
    return execFileSync('git', ['hash-object', '-w', '--no-filters', '--', file], { cwd, encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } finally { rmSync(file, { force: true }); }
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-appgit-')));
  home = join(base, 'home'); mkdirSync(home);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A project repo with a brain, one commit, data written the normal way. */
function project(at: string): { root: string; ctx: string; data: string } {
  mkdirSync(join(at, '_dream_context', 'knowledge'), { recursive: true });
  git(at, 'init', '-q', '-b', 'main');
  writeFileSync(join(at, '_dream_context', 'knowledge', 'a.md'), '# a\n');
  git(at, 'add', '-A');
  git(at, 'commit', '-q', '-m', 'init');
  const data = ensureAppDataDir(at, 'yuk');
  writeFileSync(join(data, 'yuk-bildir.json'), '{"count":3}');
  return { root: at, ctx: join(at, '_dream_context'), data };
}

describe('the general stage (K5: never touches apps/)', () => {
  it('`git add -A` never takes app data, and the exclusion keeps a force-added entry exactly as it was', () => {
    const p = project(join(base, 'p'));
    const ex = appsExcludeSpec(p.root, p.ctx)!;
    expect(ex).toBe(':(top,icase,exclude)_dream_context/apps');
    gitLib.stageAll(p.root, [ex]);
    expect(git(p.root, 'diff', '--cached', '--name-only')).not.toContain('apps/');
    expect(git(p.root, 'diff', '--cached', '--name-only')).toContain('_dream_context/.gitignore');
    // An entry already in the index (a hand `git add -f`) is neither dropped nor refreshed.
    git(p.root, 'add', '-f', '_dream_context/apps/yuk/yuk-bildir.json');
    const before = git(p.root, 'ls-files', '-s', '--', '_dream_context/apps');
    writeFileSync(join(p.data, 'yuk-bildir.json'), '{"count":4}');
    gitLib.stageAll(p.root, [ex]);
    expect(git(p.root, 'ls-files', '-s', '--', '_dream_context/apps')).toBe(before);
    expect(readFileSync(join(p.data, 'yuk-bildir.json'), 'utf-8')).toBe('{"count":4}');
  });

  it('the in-tree branch (`_dream_context` only) excludes it the same way', () => {
    const p = project(join(base, 'p'));
    git(p.root, 'add', '-f', '_dream_context/apps/yuk/yuk-bildir.json');
    const before = git(p.root, 'ls-files', '-s', '--', '_dream_context/apps');
    writeFileSync(join(p.data, 'yuk-bildir.json'), '{"count":9}');
    gitLib.stagePath(p.root, '_dream_context', [appsExcludeSpec(p.root, p.ctx)!]);
    expect(git(p.root, 'ls-files', '-s', '--', '_dream_context/apps')).toBe(before);
  });

  it('a knowledge/apps note is staged normally next to it', () => {
    const p = project(join(base, 'p'));
    mkdirSync(join(p.ctx, 'knowledge', 'apps'), { recursive: true });
    writeFileSync(join(p.ctx, 'knowledge', 'apps', 'yuk.md'), '---\napp: yuk\n---\n');
    gitLib.stageAll(p.root, [appsExcludeSpec(p.root, p.ctx)!]);
    expect(git(p.root, 'diff', '--cached', '--name-only')).toContain('_dream_context/knowledge/apps/yuk.md');
  });

  it('a nested brain (project in a subfolder of its repo) is excluded from the repo top', () => {
    const top = join(base, 'mono'); mkdirSync(top);
    git(top, 'init', '-q', '-b', 'main');
    const sub = join(top, 'pkg'); mkdirSync(join(sub, '_dream_context'), { recursive: true });
    const data = ensureAppDataDir(sub, 'yuk');
    writeFileSync(join(data, 'x.json'), '{}');
    git(top, 'add', '-f', 'pkg/_dream_context/apps/yuk/x.json');
    const ex = appsExcludeSpec(sub, join(sub, '_dream_context'))!;
    expect(ex).toBe(':(top,icase,exclude)pkg/_dream_context/apps');
    git(top, 'rm', '-q', '--cached', 'pkg/_dream_context/apps/yuk/x.json');
    // The sync engine runs from the PROJECT folder (gitCwd = projectRoot), not the repo top.
    gitLib.stageAll(sub, [ex]);
    expect(git(top, 'ls-files', '--', 'pkg/_dream_context/apps')).toBe('');
  });
});

describe('hasMergeHead', () => {
  it('sees a merge open in a linked worktree (its `.git` is a file) and in a nested project folder', () => {
    const p = project(join(base, 'p'));
    git(p.root, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(p.ctx, 'knowledge', 'a.md'), '# side\n'); git(p.root, 'commit', '-q', '-am', 'side');
    git(p.root, 'checkout', '-q', 'main');
    const wt = join(base, 'wt');
    git(p.root, 'worktree', 'add', '-q', '-b', 'wtb', wt, 'main');
    writeFileSync(join(wt, '_dream_context', 'knowledge', 'b.md'), '# b\n');
    git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'wt');
    expect(gitLib.hasMergeHead(wt)).toBe(false);
    git(wt, 'merge', '-q', '--no-ff', '--no-commit', 'side');
    expect(gitLib.hasMergeHead(wt)).toBe(true);
    expect(gitLib.hasMergeHead(p.root)).toBe(false); // the main checkout has no merge of its own
    expect(gitLib.hasMergeHead(join(wt, '_dream_context'))).toBe(true); // below the top
  });
});

describe('the push gate (back door)', () => {
  function withRemote(): { p: ReturnType<typeof project>; bare: string } {
    const bare = join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', bare);
    const p = project(join(base, 'p'));
    git(p.root, 'remote', 'add', 'origin', bare);
    git(p.root, 'push', '-q', 'origin', 'main');
    git(p.root, 'fetch', '-q', 'origin');
    return { p, bare };
  }

  it('clean: nothing held', () => {
    const { p } = withRemote();
    git(p.root, 'add', '-A'); git(p.root, 'commit', '-q', '-m', 'ignore line');
    expect(appDataInPushRange(p.root, p.ctx, 'origin/main', { home })).toBeNull();
  });

  it('data of an app this Mac does not share, added in one commit and deleted in the next, is still held', () => {
    const { p } = withRemote();
    git(p.root, 'add', '-f', '_dream_context/apps/yuk/yuk-bildir.json'); git(p.root, 'commit', '-q', '-m', 'oops');
    git(p.root, 'rm', '-q', '--cached', '_dream_context/apps/yuk/yuk-bildir.json'); git(p.root, 'commit', '-q', '-m', 'undo');
    expect(appDataInPushRange(p.root, p.ctx, 'origin/main', { home })).toContain('_dream_context/apps/yuk/yuk-bildir.json');
  });

  it('data that arrives only in a merge commit\'s resolution is held', () => {
    const { p } = withRemote();
    git(p.root, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(p.ctx, 'knowledge', 'b.md'), '# b\n'); git(p.root, 'add', '-A'); git(p.root, 'commit', '-q', '-m', 'side');
    git(p.root, 'checkout', '-q', 'main');
    writeFileSync(join(p.ctx, 'knowledge', 'c.md'), '# c\n'); git(p.root, 'add', '-A'); git(p.root, 'commit', '-q', '-m', 'main');
    git(p.root, 'merge', '-q', '--no-ff', '--no-commit', 'side');
    git(p.root, 'add', '-f', '_dream_context/apps/yuk/yuk-bildir.json');
    git(p.root, 'commit', '-q', '-m', 'merge');
    expect(appDataInPushRange(p.root, p.ctx, 'origin/main', { home })).toContain('not_shared_here');
  });

  it('a different letter case is held too', () => {
    const { p } = withRemote();
    git(p.root, 'update-index', '--add', '--cacheinfo', `100644,${blob(p.root, '{}')},_dream_context/Apps/yuk/x.json`);
    git(p.root, 'commit', '-q', '-m', 'case');
    expect(appDataInPushRange(p.root, p.ctx, 'origin/main', { home })).not.toBeNull();
  });
});

describe('a pull from the team (two clones)', () => {
  function clones(): { a: string; b: string; ctxB: string; dataB: string } {
    const bare = join(base, 'team.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', bare);
    const a = join(base, 'a');
    project(a);
    git(a, 'add', '-A'); git(a, 'commit', '-q', '-m', 'ignore');
    git(a, 'remote', 'add', 'origin', bare); git(a, 'push', '-q', 'origin', 'main');
    const b = join(base, 'b');
    git(base, 'clone', '-q', bare, b);
    const dataB = ensureAppDataDir(b, 'x');
    writeFileSync(join(dataB, 'yuk-bildir.json'), '{"mine":true}');
    return { a, b, ctxB: join(b, '_dream_context'), dataB };
  }

  it('a teammate turning apps/x into a file stops the pull; the local data stays', () => {
    const { a, b, ctxB, dataB } = clones();
    git(a, 'update-index', '--add', '--cacheinfo', `100644,${blob(a, 'not a folder')},_dream_context/apps/x`);
    git(a, 'commit', '-q', '-m', 'file'); git(a, 'push', '-q', 'origin', 'main');
    git(b, 'fetch', '-q', 'origin');
    expect(incomingAppData(b, ctxB, 'origin/main')).toEqual(['_dream_context/apps/x (not_folder)']);
    expect(readFileSync(join(dataB, 'yuk-bildir.json'), 'utf-8')).toBe('{"mine":true}');
  });

  it('a teammate adding a symlink under apps/ stops the pull', () => {
    const { a, b, ctxB, dataB } = clones();
    git(a, 'update-index', '--add', '--cacheinfo', `120000,${blob(a, '/etc')},_dream_context/apps/x/etc`);
    git(a, 'commit', '-q', '-m', 'link'); git(a, 'push', '-q', 'origin', 'main');
    git(b, 'fetch', '-q', 'origin');
    expect(incomingAppData(b, ctxB, 'origin/main')).toEqual(['_dream_context/apps/x/etc (not_plain)']);
    expect(existsSync(join(dataB, 'yuk-bildir.json'))).toBe(true);
  });

  it('a teammate\'s plain shared file passes the gate (the exchange layer decides where it lands)', () => {
    const { a, b, ctxB } = clones();
    git(a, 'update-index', '--add', '--cacheinfo', `100644,${blob(a, '{"fav":1}')},_dream_context/apps/x/favorites/1.json`);
    git(a, 'commit', '-q', '-m', 'fav'); git(a, 'push', '-q', 'origin', 'main');
    git(b, 'fetch', '-q', 'origin');
    expect(incomingAppData(b, ctxB, 'origin/main')).toEqual([]);
  });

  it('an update that touches no app data passes', () => {
    const { a, b, ctxB } = clones();
    writeFileSync(join(a, '_dream_context', 'knowledge', 'n.md'), '# n\n');
    git(a, 'add', '-A'); git(a, 'commit', '-q', '-m', 'note'); git(a, 'push', '-q', 'origin', 'main');
    git(b, 'fetch', '-q', 'origin');
    expect(incomingAppData(b, ctxB, 'origin/main')).toEqual([]);
    expect(incomingSuperRecords(b, ctxB, 'origin/main')).toEqual([]);
  });

  it('a teammate force-adding a Super record (main\'s or a member\'s) stops the pull', () => {
    const { a, b, ctxB } = clones();
    const rec = '{"enabled":true,"session":"x","queue":[{"kind":"request","state":"pending","text":"do it"}]}';
    git(a, 'update-index', '--add', '--cacheinfo', `100644,${blob(a, rec)},_dream_context/state/.super/members/rota.json`);
    git(a, 'update-index', '--add', '--cacheinfo', `100644,${blob(a, rec)},_dream_context/state/.Super-Agent.json`);
    git(a, 'commit', '-q', '-m', 'plant'); git(a, 'push', '-q', 'origin', 'main');
    git(b, 'fetch', '-q', 'origin');
    expect(incomingSuperRecords(b, ctxB, 'origin/main')?.sort()).toEqual(['_dream_context/state/.Super-Agent.json', '_dream_context/state/.super/members/rota.json']);
  });
});
