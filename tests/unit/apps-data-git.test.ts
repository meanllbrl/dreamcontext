import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAppDataDir } from '../../src/lib/apps/data-dir.js';
import { appDataInPushRange, appDataStagePass, incomingAppData } from '../../src/lib/apps/data-stage.js';
import { listInboxRows } from '../../src/lib/owner-inbox.js';

/** plan-veri r3 K2, AC4-6, with real git: app data never enters a commit, a push or a pull. */
let base: string; let home: string;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', env });
/** A blob of `text` in the repo's object store. */
const blob = (cwd: string, text: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: text, encoding: 'utf-8', env }).trim();

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

describe('staging', () => {
  it('`git add -A` never takes app data; `git add -f` is unstaged again with an inbox row', () => {
    const p = project(join(base, 'p'));
    git(p.root, 'add', '-A');
    expect(git(p.root, 'diff', '--cached', '--name-only')).not.toContain('apps/');
    expect(git(p.root, 'diff', '--cached', '--name-only')).toContain('_dream_context/.gitignore');
    git(p.root, 'add', '-f', '_dream_context/apps/yuk/yuk-bildir.json');
    expect(appDataStagePass(p.root, p.ctx, { home })).toEqual(['_dream_context/apps/yuk/yuk-bildir.json']);
    expect(git(p.root, 'ls-files', '--', '_dream_context/apps')).toBe('');
    expect(readFileSync(join(p.data, 'yuk-bildir.json'), 'utf-8')).toBe('{"count":3}');
    expect(listInboxRows(p.root, home).some((r) => r.kind === 'app-data-held')).toBe(true);
  });

  it('a knowledge/apps note is staged normally next to it', () => {
    const p = project(join(base, 'p'));
    mkdirSync(join(p.ctx, 'knowledge', 'apps'), { recursive: true });
    writeFileSync(join(p.ctx, 'knowledge', 'apps', 'yuk.md'), '---\napp: yuk\n---\n');
    git(p.root, 'add', '-A');
    appDataStagePass(p.root, p.ctx, { home });
    expect(git(p.root, 'diff', '--cached', '--name-only')).toContain('_dream_context/knowledge/apps/yuk.md');
  });

  it('a nested brain (project in a subfolder of its repo) is covered the same way', () => {
    const top = join(base, 'mono'); mkdirSync(top);
    git(top, 'init', '-q', '-b', 'main');
    const sub = join(top, 'pkg'); mkdirSync(join(sub, '_dream_context'), { recursive: true });
    const data = ensureAppDataDir(sub, 'yuk');
    writeFileSync(join(data, 'x.json'), '{}');
    git(top, 'add', '-A');
    expect(git(top, 'diff', '--cached', '--name-only')).not.toContain('apps/');
    git(top, 'add', '-f', 'pkg/_dream_context/apps/yuk/x.json');
    // The sync engine runs from the PROJECT folder (gitCwd = projectRoot), not the repo top (security r1 M3).
    expect(appDataStagePass(sub, join(sub, '_dream_context'), { home })).toEqual(['pkg/_dream_context/apps/yuk/x.json']);
    expect(git(top, 'ls-files', '--', 'pkg/_dream_context/apps')).toBe('');
  });
});

describe('the push range', () => {
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
    expect(appDataInPushRange(p.root, p.ctx, 'origin/main')).toBeNull();
  });

  it('data added in one commit and deleted in the next is still held', () => {
    const { p } = withRemote();
    git(p.root, 'add', '-f', '_dream_context/apps/yuk/yuk-bildir.json'); git(p.root, 'commit', '-q', '-m', 'oops');
    const bad = git(p.root, 'rev-parse', 'HEAD').trim();
    git(p.root, 'rm', '-q', '--cached', '_dream_context/apps/yuk/yuk-bildir.json'); git(p.root, 'commit', '-q', '-m', 'undo');
    expect(appDataInPushRange(p.root, p.ctx, 'origin/main')).toBe(bad);
  });

  it('data that arrives only in a merge commit is held', () => {
    const { p } = withRemote();
    git(p.root, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(p.ctx, 'knowledge', 'b.md'), '# b\n'); git(p.root, 'add', '-A'); git(p.root, 'commit', '-q', '-m', 'side');
    git(p.root, 'checkout', '-q', 'main');
    writeFileSync(join(p.ctx, 'knowledge', 'c.md'), '# c\n'); git(p.root, 'add', '-A'); git(p.root, 'commit', '-q', '-m', 'main');
    git(p.root, 'merge', '-q', '--no-ff', '--no-commit', 'side');
    git(p.root, 'add', '-f', '_dream_context/apps/yuk/yuk-bildir.json');
    git(p.root, 'commit', '-q', '-m', 'merge');
    const merge = git(p.root, 'rev-parse', 'HEAD').trim();
    expect(appDataInPushRange(p.root, p.ctx, 'origin/main')).toBe(merge);
  });

  it('a different letter case is held too', () => {
    const { p } = withRemote();
    git(p.root, 'update-index', '--add', '--cacheinfo', `100644,${blob(p.root, '{}')},_dream_context/Apps/yuk/x.json`);
    git(p.root, 'commit', '-q', '-m', 'case');
    expect(appDataInPushRange(p.root, p.ctx, 'origin/main')).not.toBeNull();
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
    expect(incomingAppData(b, ctxB, 'origin/main')).toEqual(['_dream_context/apps/x']);
    expect(readFileSync(join(dataB, 'yuk-bildir.json'), 'utf-8')).toBe('{"mine":true}');
  });

  it('a teammate adding a symlink under apps/ stops the pull', () => {
    const { a, b, ctxB, dataB } = clones();
    git(a, 'update-index', '--add', '--cacheinfo', `120000,${blob(a, '/etc')},_dream_context/apps/x/etc`);
    git(a, 'commit', '-q', '-m', 'link'); git(a, 'push', '-q', 'origin', 'main');
    git(b, 'fetch', '-q', 'origin');
    expect(incomingAppData(b, ctxB, 'origin/main')).toEqual(['_dream_context/apps/x/etc']);
    expect(existsSync(join(dataB, 'yuk-bildir.json'))).toBe(true);
  });

  it('an update that touches no app data passes', () => {
    const { a, b, ctxB } = clones();
    writeFileSync(join(a, '_dream_context', 'knowledge', 'n.md'), '# n\n');
    git(a, 'add', '-A'); git(a, 'commit', '-q', '-m', 'note'); git(a, 'push', '-q', 'origin', 'main');
    git(b, 'fetch', '-q', 'origin');
    expect(incomingAppData(b, ctxB, 'origin/main')).toEqual([]);
  });
});
