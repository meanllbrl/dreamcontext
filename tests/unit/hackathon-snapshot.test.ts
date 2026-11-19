/**
 * Hackathon criterion 12 (snapshot half): a team's work is kept by the conductor's own copy,
 * every round, whether or not the team ever commits; a deleted file shows as deleted; a symlink
 * the team planted is recorded as a link and never followed; the team's `.git` is never read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SNAPSHOT_FILE_MAX, changedPaths, git, headSha, initSnapshots, prepareWorkspace, snapPaths, snapshotHead, takeSnapshot } from '../../src/lib/hackathon/snapshot.js';
import { teamWorkspace } from '../../src/lib/hackathon/run-store.js';

const RUN = '20261118-snapshot-test';
let root: string;
let ws: string;
let target: string;
let base: string;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hk-snap-'));
  ws = join(root, 'ws');
  target = join(root, 'target');
  mkdirSync(target);
  sh(target, 'init', '-q', '-b', 'main');
  writeFileSync(join(target, 'index.html'), '<h1>Eski</h1>\n');
  writeFileSync(join(target, 'old.txt'), 'silinecek\n');
  sh(target, 'add', '-A');
  sh(target, 'commit', '-q', '-m', 'base');
  base = headSha(target);
  prepareWorkspace(RUN, 'alfa', target, base, { wsHome: ws, install: false });
  prepareWorkspace(RUN, 'beta', target, base, { wsHome: ws, install: false });
  initSnapshots(RUN, target, base, ['alfa', 'beta'], ws);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('team snapshots', () => {
  it('keeps a team that never commits: edits, new files and deletions land on team/<team>', () => {
    const repo = teamWorkspace(RUN, 'alfa', ws).repo;
    writeFileSync(join(repo, 'index.html'), '<h1>Yeni</h1>\n');
    writeFileSync(join(repo, 'new.css'), 'h1{color:red}\n');
    unlinkSync(join(repo, 'old.txt'));
    const r = takeSnapshot(RUN, 'alfa', 'alfa r1', { wsHome: ws });
    expect(r.ok).toBe(true);
    expect(r.commit).toBe(snapshotHead(RUN, 'alfa', ws));
    // The team itself committed nothing.
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(base);
    const rows = changedPaths(RUN, 'alfa', base, ws);
    expect(rows).toEqual(expect.arrayContaining([
      { status: 'M', path: 'index.html' }, { status: 'A', path: 'new.css' }, { status: 'D', path: 'old.txt' },
    ]));
    // The other team is untouched.
    expect(changedPaths(RUN, 'beta', base, ws)).toEqual([]);
  });

  it('an over-size file holds the copy back only when the team changed it', () => {
    const big = Buffer.alloc(SNAPSHOT_FILE_MAX + 10, 7);
    writeFileSync(join(target, 'asset.bin'), big);
    sh(target, 'add', '-A');
    sh(target, 'commit', '-q', '-m', 'big asset');
    const base2 = headSha(target);
    const RUN2 = '20261118-snapshot-big';
    prepareWorkspace(RUN2, 'alfa', target, base2, { wsHome: ws, install: false });
    initSnapshots(RUN2, target, base2, ['alfa'], ws);
    const repo = teamWorkspace(RUN2, 'alfa', ws).repo;
    writeFileSync(join(repo, 'index.html'), '<h1>Yeni</h1>\n');
    expect(takeSnapshot(RUN2, 'alfa', 'alfa r1', { wsHome: ws }).kept).toEqual([]);
    big[0] = 9;
    writeFileSync(join(repo, 'asset.bin'), big);
    expect(takeSnapshot(RUN2, 'alfa', 'alfa r2', { wsHome: ws }).kept).toEqual(['asset.bin']);
  });

  it('a second round is a child of the first; an unchanged tree adds no commit', () => {
    const repo = teamWorkspace(RUN, 'alfa', ws).repo;
    writeFileSync(join(repo, 'a.txt'), '1\n');
    const r1 = takeSnapshot(RUN, 'alfa', 'r1', { wsHome: ws });
    writeFileSync(join(repo, 'a.txt'), '2\n');
    const r2 = takeSnapshot(RUN, 'alfa', 'r2', { wsHome: ws });
    const gitDir = snapPaths(RUN, 'alfa', ws).gitDir;
    expect(git(['--git-dir', gitDir, 'rev-parse', `${r2.commit}^`])).toBe(r1.commit);
    const r3 = takeSnapshot(RUN, 'alfa', 'r3', { wsHome: ws });
    expect(r3.commit).toBe(r2.commit);
    expect(r3.changed).toBe(0);
  });

  it('records a planted symlink as a link and never follows it', () => {
    const repo = teamWorkspace(RUN, 'alfa', ws).repo;
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'GIZLI-ICERIK-12345\n');
    symlinkSync(outside, join(repo, 'link.txt'));
    const r = takeSnapshot(RUN, 'alfa', 'r1', { wsHome: ws });
    expect(r.ok).toBe(true);
    const mirrored = join(snapPaths(RUN, 'alfa', ws).workTree, 'link.txt');
    expect(lstatSync(mirrored).isSymbolicLink()).toBe(true);
    expect(readlinkSync(mirrored)).toBe(outside);
    const gitDir = snapPaths(RUN, 'alfa', ws).gitDir;
    // The blob is the link's target path, not the file's bytes.
    expect(git(['--git-dir', gitDir, 'cat-file', '-p', `${r.commit}:link.txt`])).toBe(outside);
    expect(git(['--git-dir', gitDir, 'ls-tree', r.commit!, 'link.txt'])).toMatch(/^120000 /);
  });

  it('never copies the team .git (planted hooks or config stay in the team clone)', () => {
    const repo = teamWorkspace(RUN, 'alfa', ws).repo;
    writeFileSync(join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\ntouch /tmp/pwned\n');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    takeSnapshot(RUN, 'alfa', 'r1', { wsHome: ws });
    expect(existsSync(join(snapPaths(RUN, 'alfa', ws).workTree, '.git'))).toBe(false);
    expect(changedPaths(RUN, 'alfa', base, ws).map((r) => r.path)).toEqual(['x.txt']);
  });

  it('skips the recorded install paths', () => {
    const repo = teamWorkspace(RUN, 'alfa', ws).repo;
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports=1\n');
    takeSnapshot(RUN, 'alfa', 'r1', { wsHome: ws, skip: ['node_modules'] });
    expect(changedPaths(RUN, 'alfa', base, ws)).toEqual([]);
  });
});
