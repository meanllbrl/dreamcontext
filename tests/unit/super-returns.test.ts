/**
 * kesim-geri-donus K1 (C1-C6): a cut's work against remote dev, on real scratch git repos with a
 * bare remote and a stubbed `gh`. Membership from git (D1), destinations without branch names
 * (D2), rescue lifecycle (D11), drops from an installed build (D4).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTION_MEANING, droppedFrom, groupsOf, markFit, pendingReturns, renderReturns, type GhRunner, type ReturnGroup, type ReturnsReport } from '../../src/lib/super/returns.js';
import { actionLine, renderReturnsPage } from '../../src/lib/super/returns-page.js';

let base: string;
let repo: string;
let remote: string;
const savedEnv = { ...process.env };

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const sha = (ref: string) => g(repo, 'rev-parse', ref);
function commit(file: string, text = `${file}\n`, msg = `add ${file}`): string {
  writeFileSync(join(repo, file), text);
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', msg);
  return sha('HEAD');
}
/** A branch off `from` with one commit per file. */
function branch(name: string, files: string[], from = 'dev'): string {
  g(repo, 'checkout', '-q', '-b', name, from);
  for (const f of files) commit(f);
  return sha('HEAD');
}
const onto = (b: string) => g(repo, 'checkout', '-q', b);

interface Pr { number: number; state: 'open' | 'closed'; merged: boolean; head: string; headRef: string; mergeOid: string | null }
let prs: Pr[] = [];
let ghFails = false;
const gh: GhRunner = async () => {
  if (ghFails) return { code: 1, stdout: '' };
  return { code: 0, stdout: prs.map((p) => JSON.stringify({ ...p, url: `https://github.com/acme/app/pull/${p.number}` })).join('\n') + '\n' };
};

beforeEach(() => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  });
  base = mkdtempSync(join(tmpdir(), 'super-returns-'));
  remote = join(base, 'remote.git');
  repo = join(base, 'app');
  g(base, 'init', '-q', '--bare', remote);
  g(base, 'init', '-q', '-b', 'main', repo);
  g(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  g(repo, 'config', `url.${remote}.insteadOf`, 'https://github.com/acme/app.git');
  commit('README.md');
  g(repo, 'checkout', '-q', '-b', 'dev');
  g(repo, 'push', '-q', 'origin', 'dev');
  prs = [];
  ghFails = false;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(base, { recursive: true, force: true });
});

const names = (gs: ReturnsReport['awaiting']) => gs.map((x) => x.name).sort();
const run = (from: string, o: Parameters<typeof pendingReturns>[2] = {}) => pendingReturns(repo, from, { gh, installed: [], ...o });

describe('C1 membership from git', () => {
  it('groups every first-parent merge by its message, octopus by parent; fit and all-home groups leave the lists', { timeout: 60_000 }, async () => {
    branch('super/a', ['a.txt']);
    branch('super/i', ['i.txt']);
    branch('super/b', ['b.txt']);
    const cTip = branch('super/c', ['c.txt']);
    branch('super/e', ['e.txt']);
    branch('super/f', ['f.txt']);
    branch('super/g', ['g.txt']);
    branch('super/h', ['h.txt']);
    // a and i are home: merged into dev and pushed.
    onto('dev');
    g(repo, 'merge', '-q', '--no-ff', '-m', 'Merge a', 'super/a');
    g(repo, 'merge', '-q', '--no-ff', '-m', 'Merge i', 'super/i');
    g(repo, 'push', '-q', 'origin', 'dev');
    prs = [{ number: 3, state: 'open', merged: false, head: cTip, headRef: 'super/c', mergeOid: null }];
    // The cut, from dev's first commit.
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev~2');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/a'", 'super/a');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/b'", 'super/b');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/c'", 'super/c');
    g(repo, 'merge', '-q', '--no-ff', '-m', 'Merge super/e', 'super/e');
    g(repo, 'merge', '-q', '--no-ff', '-m', 'merge super/f (the note)', 'super/f');
    g(repo, 'merge', '-q', '--no-ff', 'super/g', 'super/h');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/i'", 'super/i');
    commit('direct.txt', 'x\n', 'direct work on the cut');
    commit('fit1.txt', 'x\n', 'bump version\n\nCut-fit: version bump for the cut');
    const fit2 = commit('fit2.txt', 'x\n', 'regenerate manifest');
    g(repo, 'notes', '--ref=refs/notes/dreamcontext-cut-fit', 'add', '-m', 'Cut-fit: manifest', fit2);

    const r = await run('super/cut');
    expect(r.error).toBeUndefined();
    expect(names(r.awaiting)).toEqual(['direct', 'super/b', 'super/e', 'super/f', 'super/g', 'super/h'].sort());
    expect(names(r.inPr)).toEqual(['super/c']);
    expect(r.fit.map((c) => c.subject).sort()).toEqual(['bump version', 'regenerate manifest']);
    const all = [...r.awaiting, ...r.inPr, ...r.inRescue].map((x) => x.name);
    expect(all).not.toContain('super/a');
    expect(all).not.toContain('super/i');
    // No commit of the cut past dev outside a group.
    const owned = new Set((await groupsOf(repo, sha('super/cut'), [sha('origin/dev')])).flatMap((x) => x.commits));
    for (const c of g(repo, 'rev-list', '--no-merges', 'super/cut', '^origin/dev').split('\n').filter(Boolean)) expect(owned.has(c)).toBe(true);
    // Actions: a PR-less branch gets push + PR, the direct group a rescue.
    expect(r.awaiting.find((x) => x.name === 'super/b')).toMatchObject({ action: 'push-pr' });
    expect(r.awaiting.find((x) => x.name === 'direct')).toMatchObject({ action: 'rescue', rescueBranch: 'super/cut-iade' });
    expect(r.key).toMatch(/^[0-9a-f]{64}$/);
    expect(renderReturns(r)).toContain('super/b');
  });
});

describe('C2 PR destinations without branch names', () => {
  it('squash-merged PR → represented; a commit after its head → awaiting; local work ahead of an open PR → push', { timeout: 60_000 }, async () => {
    const d1 = branch('super/d', ['d1.txt']);
    onto('dev');
    g(repo, 'merge', '-q', '--squash', 'super/d');
    g(repo, 'commit', '-q', '-m', 'squash of d (#4)');
    g(repo, 'push', '-q', 'origin', 'dev');
    prs = [{ number: 4, state: 'closed', merged: true, head: d1, headRef: 'super/d', mergeOid: sha('dev') }];
    onto('super/d');
    commit('d2.txt');
    const cHead = branch('super/c', ['c1.txt']);
    commit('c2.txt');
    prs.push({ number: 5, state: 'open', merged: false, head: cHead, headRef: 'super/c', mergeOid: null });
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/d'", 'super/d');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/c'", 'super/c');
    const r = await run('super/cut');
    const d = r.awaiting.find((x) => x.name === 'super/d')!;
    expect(d.commits.find((c) => c.sha === d1)).toMatchObject({ state: 'represented', via: { kind: 'pr-merged', pr: 4 } });
    expect(d.commits.filter((c) => c.state === 'awaiting')).toHaveLength(1);
    expect(d.action).toBe('push-pr');
    const c = r.awaiting.find((x) => x.name === 'super/c')!;
    expect(c.commits.find((x) => x.sha === cHead)).toMatchObject({ state: 'inPr' });
    expect(c.action).toBe('push');
    // The owner's page says what the code does: PR-less = a new draft PR, open PR = push only.
    expect(actionLine(d)).toMatch(/PR'ı yok/);
    expect(actionLine(c)).toMatch(/Açık bir PR'ı var/);
    expect(renderReturns(r)).toContain(ACTION_MEANING.push.en);
  });

  it('a group with commits only in a MERGED (not home) PR plus new ones needs a new PR (push-pr), never push', { timeout: 60_000 }, async () => {
    const e1 = branch('super/e', ['e1.txt']);
    // Merged on GitHub, but its merge commit is not in the fetched dev (dev went another way).
    prs = [{ number: 8, state: 'closed', merged: true, head: e1, headRef: 'super/e', mergeOid: 'e'.repeat(40) }];
    commit('e2.txt');
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/e'", 'super/e');
    const r = await run('super/cut');
    const e = r.awaiting.find((x) => x.name === 'super/e')!;
    expect(e.commits.find((c) => c.sha === e1)).toMatchObject({ state: 'inPr', via: { kind: 'pr-merged' } });
    expect(e.action).toBe('push-pr');
  });
});

describe('review r1: one meaning per action', () => {
  it('the CLI reference states each action exactly as ACTION_MEANING; the page reads the same table', () => {
    const doc = readFileSync(join(__dirname, '..', '..', 'skill', 'references', 'cli-reference.md'), 'utf-8');
    for (const a of ['push', 'push-pr', 'rescue'] as const) expect(doc).toContain(ACTION_MEANING[a].en);
    expect(doc).not.toContain('super/rescue-*');
    const g0: ReturnGroup = { name: 'super/x', branchExists: true, tips: [], commits: [], foreign: 0, action: 'rescue', rescueBranch: 'super/x-iade', commands: [] };
    expect(actionLine(g0)).toContain('super/x-iade');
  });

  it('the page draws only with kit tokens: no literal colour outside a var() fallback, no own dark rule; numbers readable', () => {
    const r: ReturnsReport = {
      key: 'k', from: { ref: 'super/cut', sha: 'a'.repeat(40) }, dev: { ref: 'origin/dev', sha: 'b'.repeat(40), stale: false }, localDevBehind: null,
      awaiting: [{ name: 'super/x', branchExists: true, tips: [], commits: [], foreign: 0, action: 'push-pr', commands: [] }],
      inPr: [], inRescue: [], fit: [], drops: { asked: [], rows: [], errors: [] }, notes: [],
    };
    const html = renderReturnsPage('cut', r, new Date('2026-11-23T10:00:00Z'));
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    expect(css).not.toMatch(/prefers-color-scheme|color-scheme/);
    const noVars = css.replace(/var\([^()]*\)/g, '');
    expect(noVars).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).toMatch(/\.n\{[^}]*color:var\(--color-text/);
    // An empty group draws no empty list; the time names its zone; the instruction stands alone.
    expect(html).not.toContain('<ul></ul>');
    expect(html).toContain('10:00 UTC');
    expect(html).toMatch(/<p class="ask">Seçmek için numaraları yaz/);
  });
});

describe('C2b home decided once per destination', () => {
  it('one merge-base per merged PR, never one per commit', { timeout: 60_000 }, async () => {
    const tips: string[] = [];
    for (let i = 0; i < 3; i++) tips.push(branch(`super/p${i}`, [`p${i}a.txt`, `p${i}b.txt`, `p${i}c.txt`]));
    prs = tips.map((t, i) => ({ number: 20 + i, state: 'closed' as const, merged: true, head: t, headRef: `super/p${i}`, mergeOid: 'c'.repeat(40) }));
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev');
    for (let i = 0; i < 3; i++) g(repo, 'merge', '-q', '--no-ff', '-m', `Merge branch 'super/p${i}'`, `super/p${i}`);
    const trace = join(base, 'trace.log');
    process.env.GIT_TRACE = trace;
    try { await run('super/cut', { fetch: false }); } finally { delete process.env.GIT_TRACE; }
    const calls = readFileSync(trace, 'utf-8').split('\n').filter((l) => /merge-base --is-ancestor/.test(l) && /built-in/.test(l));
    // 3 merged PRs, 9 commits: 3 calls (one per PR), not 27.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it('gh failing: PR destinations dropped with a note, never "no PR"; an unreadable head is named', { timeout: 60_000 }, async () => {
    const cTip = branch('super/c', ['c.txt']);
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/c'", 'super/c');
    prs = [{ number: 6, state: 'open', merged: false, head: cTip, headRef: 'super/c', mergeOid: null }];
    ghFails = true;
    const r = await run('super/cut');
    expect(r.notes.join(' ')).toMatch(/PR destinations unknown/);
    expect(names(r.awaiting)).toEqual(['super/c']);
    ghFails = false;
    prs = [{ number: 7, state: 'open', merged: false, head: 'f'.repeat(40), headRef: 'super/c', mergeOid: null }];
    const r2 = await run('super/cut');
    expect(r2.notes.join(' ')).toContain('PR head okunamadı: #7');
    expect(r2.awaiting.find((x) => x.name === 'super/c')!.commits[0].note).toBe('PR head okunamadı');
  });
});

describe('C3 rescue lifecycle', () => {
  it('a -x copy on the rescue branch → inRescue (push-pr, no new rescue); its open PR → inPr; merged → represented; a later one → dated rescue', { timeout: 90_000 }, async () => {
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev');
    const x = commit('x.txt', 'x\n', 'direct fix');
    g(repo, 'checkout', '-q', '-b', 'super/cut-iade', 'origin/dev');
    g(repo, 'cherry-pick', '-x', x);
    let r = await run('super/cut');
    expect(r.awaiting).toHaveLength(0);
    expect(r.inRescue.map((y) => y.name)).toEqual(['direct']);
    expect(r.inRescue[0]).toMatchObject({ action: 'push-pr', rescueBranch: 'super/cut-iade' });

    g(repo, 'push', '-q', 'origin', 'super/cut-iade');
    prs = [{ number: 8, state: 'open', merged: false, head: sha('super/cut-iade'), headRef: 'super/cut-iade', mergeOid: null }];
    r = await run('super/cut');
    expect(r.inPr.map((y) => y.name)).toEqual(['direct']);

    // Squash-merged with the PR body as its message: represented through the merged head.
    onto('dev');
    g(repo, 'merge', '-q', '--squash', 'super/cut-iade');
    g(repo, 'commit', '-q', '-m', 'Rescue (#8)\n\nthe PR body');
    g(repo, 'push', '-q', 'origin', 'dev');
    prs = [{ number: 8, state: 'closed', merged: true, head: sha('super/cut-iade'), headRef: 'super/cut-iade', mergeOid: sha('dev') }];
    r = await run('super/cut');
    expect(r.awaiting).toHaveLength(0);
    expect(r.inPr).toHaveLength(0);
    expect(r.inRescue).toHaveLength(0);

    // A later direct commit while the rescue's PR is merged: a dated rescue, the old one untouched.
    onto('super/cut');
    commit('y.txt', 'y\n', 'later direct fix');
    r = await run('super/cut');
    expect(r.awaiting[0].rescueBranch).toMatch(/^super\/cut-iade-\d{6}$/);
    expect(r.awaiting[0].commits.filter((c) => c.state === 'awaiting')).toHaveLength(1);
  });

  it('a conflicting cherry-pick merged normally is represented through its origin', { timeout: 60_000 }, async () => {
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev');
    const x = commit('x.txt', 'cut version\n', 'direct fix');
    g(repo, 'checkout', '-q', '-b', 'super/cut-iade', 'origin/dev');
    commit('x.txt', 'dev version\n', 'dev edit');
    // A resolved copy: another patch, the same origin.
    writeFileSync(join(repo, 'x.txt'), 'resolved\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', `direct fix\n\n(cherry picked from commit ${x})`);
    onto('dev');
    g(repo, 'merge', '-q', '--no-ff', '-m', 'Merge rescue', 'super/cut-iade');
    g(repo, 'push', '-q', 'origin', 'dev');
    g(repo, 'branch', '-q', '-D', 'super/cut-iade');
    const r = await run('super/cut');
    expect(r.awaiting).toHaveLength(0);
  });
});

describe('C4 one group per branch; foreign work is a rescue', () => {
  it('a branch merged twice is one group with two tips; a branch carrying another branch\'s work → rescue', { timeout: 60_000 }, async () => {
    branch('super/p', ['p1.txt']);
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/p'", 'super/p');
    onto('super/p');
    commit('p2.txt');
    onto('super/cut');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/p'", 'super/p');
    let r = await run('super/cut');
    const p = r.awaiting.filter((x) => x.name === 'super/p');
    expect(p).toHaveLength(1);
    expect(p[0].tips).toHaveLength(2);
    expect(p[0].commits).toHaveLength(2);
    expect(p[0].action).toBe('push-pr');
  });

  it('a branch carrying work beyond its group that is not home → rescue under its own name, no push of the branch', { timeout: 60_000 }, async () => {
    branch('super/s', ['s1.txt']);
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/s'", 'super/s');
    // After the cut took it, s took in another branch that is home nowhere.
    const t = branch('super/t', ['t.txt']);
    onto('super/s');
    g(repo, 'merge', '-q', '--no-ff', '-m', 'take t', t);
    commit('s2.txt');
    const r = await run('super/cut');
    const sg = r.awaiting.find((x) => x.name === 'super/s')!;
    expect(sg.foreign).toBe(2);
    expect(sg).toMatchObject({ action: 'rescue', rescueBranch: 'super/s-iade' });
    expect(sg.commands.join('\n')).not.toMatch(/push \S+ refs\/heads\/super\/s:/);
    expect(sg.commands.join('\n')).toContain('cherry-pick -x');
  });
});

describe('C5 remote dev', () => {
  it('unreachable after one fetch → stale with why; no remote → error, drops still computed; local dev behind is counted', { timeout: 60_000 }, async () => {
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev');
    commit('w.txt');
    onto('dev');
    commit('dev2.txt');
    g(repo, 'push', '-q', 'origin', 'dev');
    g(repo, 'reset', '-q', '--hard', 'HEAD~1');
    let r = await run('super/cut');
    expect(r.localDevBehind).toBe(1);
    expect(sha('dev')).not.toBe(sha('origin/dev'));
    g(repo, 'config', '--unset', `url.${remote}.insteadOf`);
    g(repo, 'config', `url.${join(base, 'nowhere.git')}.insteadOf`, 'https://github.com/acme/app.git');
    r = await run('super/cut');
    expect(r.dev).toMatchObject({ stale: true });
    expect(r.dev?.why).toMatch(/fetch/);
    g(repo, 'remote', 'remove', 'origin');
    r = await run('super/cut', { installed: [{ npm: '/usr/bin/npm', sha: sha('super/cut'), source: 'flag' }] });
    expect(r.error).toBe('no remote dev');
    expect(r.drops.rows).toHaveLength(1);
  });
});

describe('C6 droppedFrom', () => {
  it('a commit the candidate lacks drops; a squash-merged PR in the candidate and a -x copy do not', { timeout: 60_000 }, async () => {
    const k1 = branch('super/k', ['k.txt']);
    const l1 = branch('super/l', ['l.txt']);
    const m1 = branch('super/m', ['m.txt']);
    g(repo, 'checkout', '-q', '-b', 'super/old', 'dev');
    for (const b of ['super/k', 'super/l', 'super/m']) g(repo, 'merge', '-q', '--no-ff', '-m', `Merge branch '${b}'`, b);
    g(repo, 'checkout', '-q', '-b', 'super/new', 'dev');
    g(repo, 'merge', '-q', '--squash', 'super/l');
    g(repo, 'commit', '-q', '-m', 'squash l (#9)');
    const squash = sha('HEAD');
    g(repo, 'cherry-pick', '-x', m1);
    void k1;
    const prsIn = [{ number: 9, state: 'closed', merged: true, head: l1, headRef: 'super/l', mergeOid: squash, url: '' }];
    const dropped = await droppedFrom(repo, sha('super/new'), sha('super/old'), undefined, prsIn);
    expect(dropped.map((x) => x.name)).toEqual(['super/k']);
    // No remote needed.
    g(repo, 'remote', 'remove', 'origin');
    const again = await droppedFrom(repo, sha('super/new'), sha('super/old'));
    expect(again.map((x) => x.name)).toContain('super/k');
  });

  it('markFit marks only a commit written directly on the cut', { timeout: 30_000 }, async () => {
    const b = branch('super/b', ['b.txt']);
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev');
    g(repo, 'merge', '-q', '--no-ff', '-m', "Merge branch 'super/b'", 'super/b');
    const d = commit('bump.txt', 'x\n', 'bump');
    await expect(markFit(repo, [b], 'nope', { from: 'super/cut' })).rejects.toThrow(/directly on the cut/);
    expect(await markFit(repo, [d], 'version bump', { from: 'super/cut' })).toEqual([d]);
    const r = await run('super/cut');
    expect(r.fit.map((c) => c.sha)).toEqual([d]);
  });
});
