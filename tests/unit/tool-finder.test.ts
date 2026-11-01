import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findTool, parseLoginPath, pathWithDirs, resetToolFinderForTests } from '../../src/lib/tool-finder.js';

const NARROW = '/usr/bin:/bin:/usr/sbin:/sbin';
let home = '';
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-tool-finder-')); resetToolFinderForTests(); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const tool = (rel: string, name = 'codex'): string => {
  const p = join(home, rel, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, 0o755);
  return p;
};
/** A launchd-like search: only what the fake home holds, no real shell, no real Homebrew. */
const search = (extra: object = {}) => ({ home, path: NARROW, env: {}, loginPath: null, system: [] as string[], ...extra });

describe('findTool on a launchd-like PATH', () => {
  it('finds nothing where nothing is installed', () => {
    expect(findTool(['codex'], search())).toBeNull();
  });

  it('nvm: the newest version that holds it, not just the newest version', () => {
    tool('.nvm/versions/node/v20.18.1/bin');
    const want = tool('.nvm/versions/node/v20.19.0/bin');
    mkdirSync(join(home, '.nvm/versions/node/v22.16.0/bin'), { recursive: true });
    expect(findTool(['codex'], search())).toBe(want);
    const newer = tool('.nvm/versions/node/v24.1.0/bin');
    resetToolFinderForTests();
    expect(findTool(['codex'], search())).toBe(newer);
  });

  it('honours NVM_DIR', () => {
    const want = tool('elsewhere/versions/node/v22.0.0/bin');
    expect(findTool(['codex'], search({ env: { NVM_DIR: join(home, 'elsewhere') } }))).toBe(want);
  });

  it('fnm', () => {
    const want = tool('.local/share/fnm/node-versions/v22.3.0/installation/bin');
    expect(findTool(['codex'], search())).toBe(want);
  });

  it('volta', () => {
    const want = tool('.volta/bin');
    expect(findTool(['codex'], search())).toBe(want);
  });

  it('the npm global prefix from ~/.npmrc', () => {
    const want = tool('my-prefix/bin');
    writeFileSync(join(home, '.npmrc'), `registry=https://registry.npmjs.org/\nprefix=${join(home, 'my-prefix')}\n`);
    expect(findTool(['codex'], search())).toBe(want);
  });

  it('Homebrew and ~/.local/bin', () => {
    const brew = tool('brew/bin');
    expect(findTool(['codex'], search({ system: [join(home, 'brew/bin')] }))).toBe(brew);
    rmSync(brew);
    resetToolFinderForTests();
    const local = tool('.local/bin');
    expect(findTool(['codex'], search({ system: [join(home, 'brew/bin')] }))).toBe(local);
  });

  it('what the login shell sees beats a guess: it knows which install is the default', () => {
    tool('.nvm/versions/node/v24.0.0/bin');
    const chosen = tool('.nvm/versions/node/v20.19.0/bin');
    expect(findTool(['codex'], search({ loginPath: () => `${dirname(chosen)}:/usr/bin` }))).toBe(chosen);
  });

  it('a login shell that does not answer still leaves the folders', () => {
    const want = tool('.volta/bin');
    expect(findTool(['codex'], search({ loginPath: () => null }))).toBe(want);
  });

  it('the process PATH wins over everything but a managed install', () => {
    const onPath = tool('mine');
    tool('.nvm/versions/node/v24.0.0/bin');
    expect(findTool(['codex'], search({ path: `${dirname(onPath)}:${NARROW}` }))).toBe(onPath);
    const managed = tool('managed');
    expect(findTool(['codex'], search({ path: `${dirname(onPath)}:${NARROW}`, first: [dirname(managed)] }))).toBe(managed);
  });

  it('a path that vanished is searched for again', () => {
    const first = tool('.nvm/versions/node/v24.0.0/bin');
    const later = tool('.volta/bin');
    expect(findTool(['codex'], search())).toBe(first);
    rmSync(first);
    expect(findTool(['codex'], search())).toBe(later);
    rmSync(later);
    expect(findTool(['codex'], search())).toBeNull();
  });

  it('a file that cannot run is not a tool', () => {
    const p = tool('.volta/bin');
    chmodSync(p, 0o644);
    expect(findTool(['codex'], search())).toBeNull();
  });
});

describe('the login shell line', () => {
  it('survives an rc file that prints to stdout', () => {
    expect(parseLoginPath('Welcome back!\nnvm says hi\n__DC_LOGIN_PATH__/a/bin:/usr/bin\n')).toBe('/a/bin:/usr/bin');
  });
  it('no line, no PATH', () => {
    expect(parseLoginPath('command not found')).toBeNull();
  });
});

it('pathWithDirs appends, keeps order, skips empties', () => {
  expect(pathWithDirs('/a:/b', ['/b', '/c', null])).toBe('/a:/b:/c');
});
