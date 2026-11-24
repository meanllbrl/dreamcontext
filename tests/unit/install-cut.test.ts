/**
 * kesim-geri-donus K4 (C11, C12): `npm run install:cut` accepts `super returns` only as a receipt
 * of exactly what it asked, and stops before any `npm pack` / `npm i` with the reason named. Every
 * command is stubbed: nothing is built or installed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReceipt, installCut, npmCandidates, parseArgs, readStamp } from '../../scripts/install-cut.mjs';

const PIN = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
let dir: string;
let cwd: string;
let globalRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-cut-'));
  cwd = join(dir, 'wt');
  mkdirSync(join(cwd, 'dist'), { recursive: true });
  globalRoot = join(dir, 'global');
  mkdirSync(join(globalRoot, 'dreamcontext', 'dist'), { recursive: true });
  writeFileSync(join(globalRoot, 'dreamcontext', 'package.json'), '{}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const report = (o: { from?: string; asked?: Array<{ npm: string; installed: string }>; rows?: unknown[]; errors?: unknown[]; awaiting?: unknown[] } = {}) => JSON.stringify({
  from: { ref: PIN, sha: o.from ?? PIN }, dev: null, error: 'no remote dev', awaiting: o.awaiting ?? [],
  drops: { asked: o.asked ?? [{ npm: '/n/npm', installed: OLD }], rows: o.rows ?? [{ npm: '/n/npm', installed: OLD, source: 'flag', groups: [] }], errors: o.errors ?? [] },
});

type Call = { cmd: string; args: string[] };
function stubRun(o: { dirty?: boolean; stamp?: string | null; installedStamp?: string | null; returns?: string; failInstall?: boolean } = {}) {
  const calls: Call[] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const k = `${cmd} ${args.join(' ')}`;
    if (k === 'git rev-parse --verify HEAD') return { code: 0, stdout: `${PIN}\n`, stderr: '' };
    if (k === 'git status --porcelain') return { code: 0, stdout: o.dirty ? ' M x.ts\n' : '', stderr: '' };
    if (k === 'npm run build') {
      if (o.stamp !== null) writeFileSync(join(cwd, 'dist', 'build-commit.json'), JSON.stringify({ sha: o.stamp ?? PIN, branch: 'super/cut', dirty: false, builtAt: 'x' }));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (k.endsWith(' root -g')) {
      if (o.installedStamp !== null) writeFileSync(join(globalRoot, 'dreamcontext', 'dist', 'build-commit.json'), JSON.stringify({ sha: o.installedStamp ?? OLD, branch: 'super/old', dirty: false, builtAt: 'x' }));
      return { code: 0, stdout: `${globalRoot}\n`, stderr: '' };
    }
    if (cmd === 'git' && args[0] === 'cat-file') return { code: 0, stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: `${OLD}\n`, stderr: '' };
    if (args.includes('returns')) return { code: 0, stdout: o.returns ?? report(), stderr: '' };
    if (k === 'pgrep -f dreamcontext-desktop') return { code: 1, stdout: '', stderr: '' };
    if (k === 'npm pack --silent') return { code: 0, stdout: 'dreamcontext-1.0.0.tgz\n', stderr: '' };
    if (args[0] === 'i' && args[1] === '-g') return { code: o.failInstall ? 1 : 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}
const go = async (s: ReturnType<typeof stubRun>, argv: string[] = []) => {
  const out: string[] = [];
  const code = await installCut({ cwd, argv, run: s.run, log: (l: string) => out.push(l), warn: (l: string) => out.push(l), npms: ['/n/npm'] });
  return { code, out: out.join('\n'), installed: s.calls.some((c) => c.args[0] === 'i'), packed: s.calls.some((c) => c.args[0] === 'pack') };
};

describe('parseArgs', () => {
  it('reads --installed-from and --accept-drop, refuses the rest', () => {
    const a = parseArgs(['--installed-from', '/a/npm=main', '--installed-from=/b/npm=HEAD~1', '--accept-drop', 'eski deney']);
    expect([...a.installedFrom]).toEqual([['/a/npm', 'main'], ['/b/npm', 'HEAD~1']]);
    expect(a.acceptDrop).toBe('eski deney');
    expect(() => parseArgs(['--force'])).toThrow(/unknown/);
    expect(() => parseArgs(['--installed-from', 'nope'])).toThrow(/<npm>=<ref>/);
    expect(() => parseArgs(['--accept-drop', '  '])).toThrow(/reason/);
  });
});

describe('npmCandidates', () => {
  it('every distinct real npm on PATH plus npm_execpath\'s, one per real file', () => {
    const a = join(dir, 'a'); const b = join(dir, 'b'); const c = join(dir, 'p', 'bin');
    for (const d of [a, b, c]) mkdirSync(d, { recursive: true });
    writeFileSync(join(a, 'npm'), ''); symlinkSync(join(a, 'npm'), join(b, 'npm')); writeFileSync(join(c, 'npm'), '');
    const exec = join(dir, 'p', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(npmCandidates({ PATH: [a, b].join(':'), npm_execpath: exec }, 'darwin')).toEqual([join(a, 'npm'), join(c, 'npm')]);
  });
});

describe('readStamp', () => {
  it('refuses a symlinked stamp', () => {
    writeFileSync(join(dir, 'real.json'), JSON.stringify({ sha: PIN }));
    symlinkSync(join(dir, 'real.json'), join(cwd, 'dist', 'build-commit.json'));
    expect(readStamp(cwd)).toBeNull();
  });
});

describe('checkReceipt', () => {
  const asked = [{ npm: '/n/npm', sha: OLD }];
  it('only the exact receipt passes', () => {
    expect(checkReceipt(report(), { pinned: PIN, asked }).ok).toBe(true);
    expect(checkReceipt('not json', { pinned: PIN, asked }).reason).toMatch(/JSON/);
    expect(checkReceipt(report({ from: OLD }), { pinned: PIN, asked }).reason).toMatch(/pinned/);
    expect(checkReceipt(report({ asked: [{ npm: '/other', installed: OLD }] }), { pinned: PIN, asked }).reason).toMatch(/another set/);
    expect(checkReceipt(report({ errors: [{ npm: '/n/npm', error: 'boom' }] }), { pinned: PIN, asked }).reason).toMatch(/boom/);
    expect(checkReceipt(report({ rows: [] }), { pinned: PIN, asked }).reason).toMatch(/no single drops row/);
  });
});

describe('installCut', () => {
  it('a dirty worktree stops before the build', async () => {
    const s = stubRun({ dirty: true });
    const r = await go(s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/uncommitted/);
    expect(s.calls.some((c) => c.args.join(' ') === 'run build')).toBe(false);
  });

  it('a stamp that is not the pinned commit stops', async () => {
    const r = await go(stubRun({ stamp: OLD }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not the pinned/);
    expect(r.packed).toBe(false);
  });

  it('an installed CLI without a stamp stops unless --installed-from names it (D7)', async () => {
    let r = await go(stubRun({ installedStamp: null }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no build stamp: name what it holds with --installed-from \/n\/npm=<ref>/);
    r = await go(stubRun({ installedStamp: null }), ['--installed-from', '/n/npm=super/old']);
    expect(r.code).toBe(0);
  });

  it('a drop stops it with every group named; --accept-drop installs and writes the why into the stamp', async () => {
    const dropping = report({ rows: [{ npm: '/n/npm', installed: OLD, source: 'stamp', groups: [{ name: 'super/telegram-fix', commits: [{ sha: 'c'.repeat(40), subject: 'fix tg cards' }] }] }] });
    let r = await go(stubRun({ returns: dropping }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/super\/telegram-fix/);
    expect(r.out).toMatch(/fix tg cards/);
    expect(r.packed).toBe(false);
    expect(r.installed).toBe(false);
    r = await go(stubRun({ returns: dropping }), ['--accept-drop', 'sahip: eski deney']);
    expect(r.code).toBe(0);
    expect(r.installed).toBe(true);
    const st = JSON.parse(readFileSync(join(cwd, 'dist', 'build-commit.json'), 'utf-8'));
    expect(st.acceptedDrops).toMatchObject({ why: 'sahip: eski deney', rows: [{ npm: '/n/npm', groups: ['super/telegram-fix'] }] });
  });

  it('a clean receipt installs the tarball with the npm that had the package; a failing install says who holds what', async () => {
    let r = await go(stubRun());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/installed a{12} with 1 npm/);
    r = await go(stubRun({ failInstall: true }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\/n\/npm still holds b{12}/);
  });
});
