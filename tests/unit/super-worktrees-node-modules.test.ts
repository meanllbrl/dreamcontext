import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMatchesLock, seedNodeModules } from '../../src/lib/super/worktrees.js';

/** A new worktree's node_modules (D11, AC7): an APFS clone when it provably fits, never a symlink. */
const lock = (v: string) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'demo' }, 'node_modules/leftpad': { version: v } } });
const hidden = (v: string) => JSON.stringify({ packages: { 'node_modules/leftpad': { version: v } } });

describe('seedNodeModules', () => {
  let dir: string;
  let src: string;
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'seed-nm-')));
    src = join(dir, 'src');
    mkdirSync(join(src, 'node_modules', 'leftpad'), { recursive: true });
    git(src, 'init', '-q', '-b', 'main'); git(src, 'config', 'user.email', 't@e.st'); git(src, 'config', 'user.name', 't');
    writeFileSync(join(src, '.gitignore'), 'node_modules\n');
    writeFileSync(join(src, 'package-lock.json'), lock('1.0.0'));
    writeFileSync(join(src, 'node_modules', '.package-lock.json'), hidden('1.0.0'));
    writeFileSync(join(src, 'node_modules', 'leftpad', 'index.js'), 'module.exports = 1;\n');
    git(src, 'add', '-A'); git(src, 'commit', '-qm', 'base');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const add = (name: string, noCheckout = false) => {
    const wt = join(dir, name);
    git(src, 'worktree', 'add', '-q', ...(noCheckout ? ['--no-checkout'] : []), '-b', `super/${name}`, wt, 'HEAD');
    return wt;
  };

  it.runIf(process.platform === 'darwin')('the same lockfile and a matching install: a real folder, not a link (checkout and --no-checkout)', async () => {
    for (const [name, nc] of [['one', false], ['two', true]] as const) {
      const wt = add(name, nc);
      const r = await seedNodeModules(src, wt, git(src, 'rev-parse', 'HEAD'));
      expect(r.seeded).toBe(true);
      const st = lstatSync(join(wt, 'node_modules'));
      expect(st.isDirectory() && !st.isSymbolicLink()).toBe(true);
      expect(lstatSync(join(wt, 'node_modules', 'leftpad', 'index.js')).isFile()).toBe(true);
    }
  });

  it('another lockfile at the worktree\'s start: nothing, with why', async () => {
    const before = git(src, 'rev-parse', 'HEAD');
    writeFileSync(join(src, 'package-lock.json'), lock('2.0.0'));
    writeFileSync(join(src, 'node_modules', '.package-lock.json'), hidden('2.0.0'));
    const wt = add('three');
    const r = await seedNodeModules(src, wt, before, { platform: 'darwin' });
    expect(r).toMatchObject({ seeded: false, why: expect.stringMatching(/differs/) });
    expect(() => lstatSync(join(wt, 'node_modules'))).toThrow();
  });

  it('a stale install: nothing', async () => {
    writeFileSync(join(src, 'node_modules', '.package-lock.json'), hidden('0.9.0'));
    const wt = add('four');
    const r = await seedNodeModules(src, wt, git(src, 'rev-parse', 'HEAD'), { platform: 'darwin' });
    expect(r).toMatchObject({ seeded: false, why: expect.stringMatching(/stale/) });
  });

  it('not macOS: nothing', async () => {
    const wt = add('five');
    expect((await seedNodeModules(src, wt, git(src, 'rev-parse', 'HEAD'), { platform: 'linux' })).seeded).toBe(false);
  });

  it('installMatchesLock', () => {
    expect(installMatchesLock(lock('1.0.0'), hidden('1.0.0'))).toBe(true);
    expect(installMatchesLock(lock('1.0.0'), hidden('1.1.0'))).toBe(false);
    expect(installMatchesLock(lock('1.0.0'), '{}')).toBe(false);
    expect(installMatchesLock('nope', hidden('1.0.0'))).toBe(false);
  });
});
