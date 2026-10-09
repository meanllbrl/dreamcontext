/**
 * The pending `git init` record (`~/.dreamcontext/onboarding.json`): a project created while
 * the macOS developer tools were still installing gets its `git init` once Git is usable.
 * Every test runs against an injected tmp HOME and injected git functions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addVault } from '../../src/lib/vaults.js';
import {
  listPendingGitInits,
  recordPendingGitInit,
  runPendingGitInits,
} from '../../src/lib/onboarding/pending-git.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function mkTmp(prefix = 'dc-pending'): string {
  const raw = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const real = realpathSync(raw);
  dirs.push(real);
  return real;
}

/** A registered vault folder under `root`. */
function project(root: string, home: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '_dream_context'), { recursive: true });
  addVault(name, dir, home);
  return dir;
}

function recorder(): { inits: string[]; initRepo: (d: string) => void } {
  const inits: string[] = [];
  return { inits, initRepo: (d) => { inits.push(d); mkdirSync(join(d, '.git')); } };
}

const onboardingFile = (home: string) => join(home, '.dreamcontext', 'onboarding.json');

describe('recordPendingGitInit', () => {
  it('writes the file through a temp file and rename, de-duplicated, NFC', () => {
    const home = mkTmp('dc-home');
    const nfc = join(home, 'Öğretmen Notları');
    expect(recordPendingGitInit(nfc.normalize('NFD'), home)).toBe(true);
    expect(recordPendingGitInit(nfc, home)).toBe(true);
    expect(JSON.parse(readFileSync(onboardingFile(home), 'utf-8')).pendingGitInits).toEqual([nfc]);
    expect(readdirSync(join(home, '.dreamcontext')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('keeps other keys in the file and survives a stray temp file from an earlier crash', () => {
    const home = mkTmp('dc-home');
    mkdirSync(join(home, '.dreamcontext'));
    writeFileSync(onboardingFile(home), JSON.stringify({ other: 1 }));
    writeFileSync(`${onboardingFile(home)}.tmp-999-abc`, '{"pendingGit');
    expect(recordPendingGitInit('/x/a', home)).toBe(true);
    const parsed = JSON.parse(readFileSync(onboardingFile(home), 'utf-8'));
    expect(parsed.other).toBe(1);
    expect(parsed.pendingGitInits).toEqual(['/x/a']);
  });

  it('refuses a symlinked ~/.dreamcontext and writes nothing', () => {
    const home = mkTmp('dc-home');
    const elsewhere = mkTmp('dc-else');
    symlinkSync(elsewhere, join(home, '.dreamcontext'));
    expect(recordPendingGitInit('/x/a', home)).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a symlinked onboarding.json and leaves its target untouched', () => {
    const home = mkTmp('dc-home');
    const elsewhere = mkTmp('dc-else');
    const target = join(elsewhere, 'victim.json');
    writeFileSync(target, 'untouched');
    mkdirSync(join(home, '.dreamcontext'));
    symlinkSync(target, onboardingFile(home));
    expect(recordPendingGitInit('/x/a', home)).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe('untouched');
    expect(listPendingGitInits(home)).toEqual([]);
  });
});

describe('runPendingGitInits', () => {
  it('does nothing and keeps the entry while Git is unusable', () => {
    const home = mkTmp('dc-home');
    const dir = project(mkTmp(), home, 'p');
    recordPendingGitInit(dir, home);
    const r = recorder();
    expect(runPendingGitInits({ home, gitAvailable: () => false, initRepo: r.initRepo })).toEqual([]);
    expect(r.inits).toEqual([]);
    expect(listPendingGitInits(home)).toEqual([dir]);
  });

  it('initialises registered folders once Git is usable and empties the list', () => {
    const home = mkTmp('dc-home');
    const dir = project(mkTmp(), home, 'p');
    recordPendingGitInit(dir, home);
    const r = recorder();
    expect(runPendingGitInits({ home, gitAvailable: () => true, initRepo: r.initRepo })).toEqual([dir]);
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(listPendingGitInits(home)).toEqual([]);
    // A second trigger finds nothing to do.
    expect(runPendingGitInits({ home, gitAvailable: () => true, initRepo: r.initRepo })).toEqual([]);
    expect(r.inits).toEqual([dir]);
  });

  it('drops unregistered, vanished, symlinked and already-a-repo entries without initialising them', () => {
    const home = mkTmp('dc-home');
    const root = mkTmp();
    const unregistered = join(root, 'stranger');
    mkdirSync(unregistered);
    const vanished = project(root, home, 'gone');
    rmSync(vanished, { recursive: true, force: true });
    const repo = project(root, home, 'repo');
    mkdirSync(join(repo, '.git'));
    const realTarget = project(root, home, 'real');
    const linkHolder = mkTmp('dc-link');
    const link = join(linkHolder, 'link');
    symlinkSync(realTarget, link);
    for (const p of [unregistered, vanished, repo, link]) recordPendingGitInit(p, home);
    const r = recorder();
    expect(runPendingGitInits({ home, gitAvailable: () => true, initRepo: r.initRepo })).toEqual([]);
    expect(r.inits).toEqual([]);
    expect(listPendingGitInits(home)).toEqual([]);
  });

  it('keeps an entry whose git init failed, for the next trigger', () => {
    const home = mkTmp('dc-home');
    const dir = project(mkTmp(), home, 'p');
    recordPendingGitInit(dir, home);
    const failing = () => { throw new Error('git exploded'); };
    expect(runPendingGitInits({ home, gitAvailable: () => true, initRepo: failing })).toEqual([]);
    expect(listPendingGitInits(home)).toEqual([dir]);
  });

  it('returns [] with no file at all', () => {
    const home = mkTmp('dc-home');
    expect(runPendingGitInits({ home, gitAvailable: () => true, initRepo: () => { throw new Error('never'); } })).toEqual([]);
  });
});
