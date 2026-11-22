/**
 * Every feature decides how existing installs follow it (plan oto-migration D6, C6): the PR body
 * carries a Migration: line, and the release refuses a PR merged since the last tag without one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs release script, no type declarations
import { checkMigrationDecision, parseDecision, GATE_START, MIN_REASON_CHARS } from '../../scripts/check-migration-decision.mjs';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-migration-decision.mjs');
const REPO = 'acme/widget';
const feature = { headRef: 'super/new-thing', headRepo: REPO, repo: REPO };
const M = 'src/migrations/0.50.0.ts';
const M2 = 'src/migrations/0.50.0-split.ts';

describe('checkMigrationDecision (PR mode core)', () => {
  it('passes a none line with a reason', () => {
    const r = checkMigrationDecision({ ...feature, body: 'Text\n\nMigration: none - readers accept both shapes', changedFiles: ['src/a.ts'] });
    expect(r.ok).toBe(true);
  });
  it('passes one file line and two file lines', () => {
    expect(checkMigrationDecision({ ...feature, body: `Migration: ${M}`, changedFiles: [M, 'src/a.ts'], addedFiles: [M] }).ok).toBe(true);
    expect(checkMigrationDecision({ ...feature, body: `Migration: ${M}\r\nMigration: ${M2}`, changedFiles: [M, M2], addedFiles: [M, M2] }).ok).toBe(true);
  });
  it('fails a missing line', () => {
    expect(checkMigrationDecision({ ...feature, body: 'Just a feature', changedFiles: ['src/a.ts'] })).toEqual({ ok: false, reason: 'no Migration: line' });
    expect(checkMigrationDecision({ ...feature, body: null }).ok).toBe(false);
  });
  it('fails none when the diff adds a migration file', () => {
    const r = checkMigrationDecision({ ...feature, body: 'Migration: none - nothing to move here', changedFiles: [M], addedFiles: [M] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(M);
  });
  it('fails a named file not in the diff', () => {
    const r = checkMigrationDecision({ ...feature, body: `Migration: ${M}`, changedFiles: ['src/a.ts'] });
    expect(r).toEqual({ ok: false, reason: `named but not in the diff: ${M}` });
  });
  it('fails an added migration file left unnamed', () => {
    const r = checkMigrationDecision({ ...feature, body: `Migration: ${M}`, changedFiles: [M, M2], addedFiles: [M, M2] });
    expect(r).toEqual({ ok: false, reason: `added but not named: ${M2}` });
  });
  it('fails a short reason, an empty one, both kinds at once and an unreadable line', () => {
    expect(checkMigrationDecision({ ...feature, body: 'Migration: none - short' }).ok).toBe(false);
    expect('short'.length).toBeLessThan(MIN_REASON_CHARS);
    expect(checkMigrationDecision({ ...feature, body: 'Migration: none - ' }).ok).toBe(false);
    expect(checkMigrationDecision({ ...feature, body: `Migration: ${M}\nMigration: none - readers accept both`, changedFiles: [M] }).ok).toBe(false);
    expect(checkMigrationDecision({ ...feature, body: 'Migration: maybe later' }).reason).toMatch(/unreadable/);
  });
  it('ignores the template guidance inside HTML comments', () => {
    const template = readFileSync(join(ROOT, '.github', 'pull_request_template.md'), 'utf-8');
    expect(parseDecision(template).bad).toEqual([]);
    expect(checkMigrationDecision({ ...feature, body: template }).ok).toBe(false); // empty reason left in
    const filled = template.replace(/^Migration: none - $/m, 'Migration: none - copy change only, no stored data');
    expect(checkMigrationDecision({ ...feature, body: filled }).ok).toBe(true);
  });
  it('ignores Migration: lines quoted in fenced code', () => {
    const body = 'Docs change.\n\n```\nMigration: src/migrations/<X.Y.Z>.ts\nMigration: none - <why>\n```\n\n~~~md\nMigration: maybe\n~~~\n\nMigration: none - copy change only, nothing stored';
    expect(parseDecision(body)).toEqual({ files: [], nones: ['copy change only, nothing stored'], bad: [] });
    expect(checkMigrationDecision({ ...feature, body }).ok).toBe(true);
    // An unclosed fence hides what follows: the safe direction (no line found).
    expect(checkMigrationDecision({ ...feature, body: '```\nMigration: none - copy change only, nothing stored' }).ok).toBe(false);
  });
  it('exempts same-repo release heads and not a fork\'s', () => {
    for (const headRef of ['beta', 'dev', 'main', 'release/0.41.24-beta']) {
      expect(checkMigrationDecision({ body: '', headRef, headRepo: REPO, repo: REPO }).ok).toBe(true);
    }
    expect(checkMigrationDecision({ body: '', headRef: 'main', headRepo: 'someone/widget', repo: REPO }).ok).toBe(false);
    expect(checkMigrationDecision({ body: '', headRef: 'releases', headRepo: REPO, repo: REPO }).ok).toBe(false);
  });
});

describe('the workflow', () => {
  it('reads the PR body from env only, never inside a run line', () => {
    const yml = readFileSync(join(ROOT, '.github', 'workflows', 'migration-decision.yml'), 'utf-8');
    expect(yml).toContain('PR_BODY: ${{ github.event.pull_request.body }}');
    for (const line of yml.split('\n').filter((l) => l.includes('github.event.pull_request'))) {
      expect(line).toMatch(/^\s+([A-Z_]+|group): .*\$\{\{ github\.event\.pull_request\.[\w.]+ \}\}/);
    }
    expect(yml).toMatch(/types: \[opened, edited, synchronize, reopened\]/);
    expect(yml).toMatch(/permissions:\n\s+contents: read/);
  });
  it('is a hard stop in the release workflow and in prepublishOnly', () => {
    const rel = readFileSync(join(ROOT, '.github', 'workflows', 'desktop-release.yml'), 'utf-8');
    expect(rel).toContain('node scripts/check-migration-decision.mjs --release');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts.prepublishOnly).toMatch(/^node scripts\/check-migration-decision\.mjs --release && /);
  });
});

// ── Release mode, on a real git fixture with a fake gh ────────────────────────────────────────

type Pr = { number: number; title: string; body: string; headRefName: string; mergedAt: string; base: 'dev' | 'main'; files?: [string, string][] };

const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs');
const fx = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, 'utf-8'));
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_FIXTURE + '.calls', a.join(' ') + '\\n');
if (fx.offline) { process.stderr.write('error connecting to api.github.com\\n'); process.exit(1); }
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write(fx.repo + '\\n'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') {
  const base = a[a.indexOf('--base') + 1];
  const li = a.indexOf('--limit');
  const limit = li >= 0 ? Number(a[li + 1]) : 30;
  const out = fx.prs.filter((p) => p.base === base).slice(0, limit).map((p) => ({
    number: p.number, title: p.title, body: p.body, headRefName: p.headRefName, mergedAt: p.mergedAt,
    headRepository: { name: fx.repo.split('/')[1] }, headRepositoryOwner: { login: fx.repo.split('/')[0] },
  }));
  process.stdout.write(JSON.stringify(out)); process.exit(0);
}
if (a[0] === 'api') {
  const n = Number(/pulls\\/(\\d+)\\/files/.exec(a[1])[1]);
  const pr = fx.prs.find((p) => p.number === n);
  process.stdout.write((pr.files || []).map(([s, f]) => s + '\\t' + f).join('\\n') + '\\n'); process.exit(0);
}
process.stderr.write('fake gh: unknown call ' + a.join(' ')); process.exit(3);
`;

// A shebang fake gh and symlinked git: POSIX only.
describe.skipIf(process.platform === 'win32')('release mode', () => {
  let dir: string;
  let bin: string;
  let binNoGh: string;
  const git = (repo: string, args: string[], date = '2026-11-01T10:00:00Z') => execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
  const makeRepo = (name: string, tags: { tag: string; date: string }[]) => {
    const repo = join(dir, name);
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    for (const [i, t] of tags.entries()) {
      git(repo, ['commit', '-q', '--allow-empty', '-m', `c${i}`], t.date);
      if (t.tag) git(repo, ['tag', t.tag], t.date);
    }
    if (!tags.length) git(repo, ['commit', '-q', '--allow-empty', '-m', 'c0']);
    return repo;
  };
  const runIn = (repo: string, prs: Pr[], opts: { offline?: boolean; noGh?: boolean; args?: string[] } = {}) => {
    const fixture = join(repo, '..', `${repo.split('/').pop()}.fixture.json`);
    writeFileSync(fixture, JSON.stringify({ repo: REPO, prs, offline: !!opts.offline }));
    writeFileSync(`${fixture}.calls`, '');
    const res = spawnSync(process.execPath, [SCRIPT, '--release', ...(opts.args ?? [])], {
      cwd: repo, encoding: 'utf-8',
      env: { ...process.env, PATH: opts.noGh ? binNoGh : bin, FAKE_GH_FIXTURE: fixture },
    });
    return { ...res, calls: readFileSync(`${fixture}.calls`, 'utf-8') };
  };
  const pr = (number: number, mergedAt: string, body: string, extra: Partial<Pr> = {}): Pr => ({
    number, title: `PR ${number}`, body, headRefName: `super/f${number}`, mergedAt, base: 'dev', files: [['modified', 'src/a.ts']], ...extra,
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mig-decision-'));
    const gitPath = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf-8' }).trim();
    bin = join(dir, 'bin');
    binNoGh = join(dir, 'bin-nogh');
    mkdirSync(bin);
    mkdirSync(binNoGh);
    symlinkSync(gitPath, join(bin, 'git'));
    symlinkSync(gitPath, join(binNoGh, 'git'));
    writeFileSync(join(bin, 'gh'), FAKE_GH);
    chmodSync(join(bin, 'gh'), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('skips a PR merged before GATE_START and fails one merged after without a line, with the fix line', () => {
    const repo = makeRepo('gate', [{ tag: 'v0.1.0', date: '2026-11-01T10:00:00Z' }, { tag: '', date: '2026-11-25T10:00:00Z' }]);
    expect(Date.parse('2026-11-21T10:00:00Z')).toBeLessThan(Date.parse(GATE_START));
    const res = runIn(repo, [
      pr(10, '2026-11-21T10:00:00Z', 'old, no line'),
      pr(11, '2026-11-23T10:00:00Z', 'new, no line', { base: 'main' }),
      pr(12, '2026-11-23T11:00:00Z', 'Migration: none - copy change only, nothing stored'),
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('#11 PR 11: no Migration: line. Fix: gh pr edit 11 --body-file <file> with a Migration: line, then run this again.');
    expect(res.stderr).not.toContain('#10');
    expect(res.stderr).not.toContain('#12');
    expect(res.calls).not.toMatch(/pulls\/10\/files/);
  });

  it('passes when every PR has a line, and exempts a release PR without reading its files', () => {
    const repo = makeRepo('pass', [{ tag: 'v0.1.0', date: '2026-11-22T12:00:00Z' }, { tag: '', date: '2026-11-25T10:00:00Z' }]);
    const res = runIn(repo, [
      pr(20, '2026-11-23T10:00:00Z', `Migration: ${M}`, { files: [['added', M]] }),
      pr(21, '2026-11-23T11:00:00Z', '', { headRefName: 'release/0.1.1-beta', base: 'main' }),
      pr(19, '2026-11-22T11:00:00Z', 'merged before the tag, skipped'),
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('1 PR(s) merged since v0.1.0');
    expect(res.calls).not.toMatch(/pulls\/21\/files/);
  });

  it('fails a PR whose added migration file is not named (files read through gh api --paginate)', () => {
    const repo = makeRepo('files', [{ tag: 'v0.1.0', date: '2026-11-22T12:00:00Z' }, { tag: '', date: '2026-11-25T10:00:00Z' }]);
    const res = runIn(repo, [pr(30, '2026-11-23T10:00:00Z', 'Migration: none - nothing to move at all', { files: [['added', M]] })]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`#30 PR 30: Migration: none, but the diff adds ${M}`);
    expect(res.calls).toMatch(/api repos\/acme\/widget\/pulls\/30\/files --paginate/);
  });

  it('with HEAD on a tag, takes the previous one', () => {
    const repo = makeRepo('headtag', [{ tag: 'v0.1.0', date: '2026-11-22T12:00:00Z' }, { tag: 'v0.2.0', date: '2026-11-25T10:00:00Z' }]);
    const res = runIn(repo, [pr(40, '2026-11-23T10:00:00Z', 'Migration: none - copy change only, nothing stored')]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('since v0.1.0');
  });

  it('reads more than 30 PRs', () => {
    const repo = makeRepo('many', [{ tag: 'v0.1.0', date: '2026-11-22T12:00:00Z' }, { tag: '', date: '2026-11-30T10:00:00Z' }]);
    const prs = Array.from({ length: 35 }, (_, i) => pr(100 + i, '2026-11-23T10:00:00Z', 'Migration: none - copy change only, nothing stored'));
    prs[34].body = 'forgot it';
    const res = runIn(repo, prs);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('#134 PR 134: no Migration: line');
    expect(res.stderr.match(/^\s+#/gm)).toHaveLength(1);
  });

  it('exits 2, never a pass, with no gh, gh offline, no previous tag or a bad --since', () => {
    const repo = makeRepo('errs', [{ tag: 'v0.1.0', date: '2026-11-22T12:00:00Z' }, { tag: '', date: '2026-11-25T10:00:00Z' }]);
    const prs = [pr(50, '2026-11-23T10:00:00Z', 'no line')];
    const noGh = runIn(repo, prs, { noGh: true });
    expect(noGh.status).toBe(2);
    expect(noGh.stderr).toContain('gh is not installed');
    const offline = runIn(repo, prs, { offline: true });
    expect(offline.status).toBe(2);
    expect(offline.stderr).toContain('This is not a pass');
    const untagged = makeRepo('notag', []);
    expect(runIn(untagged, prs).status).toBe(2);
    const onlyHead = makeRepo('onlyhead', [{ tag: 'v0.1.0', date: '2026-11-25T10:00:00Z' }]);
    expect(runIn(onlyHead, prs).status).toBe(2);
    expect(runIn(repo, prs, { args: ['--since', 'main'] }).status).toBe(2);
    expect(runIn(repo, prs, { args: ['--since', 'v9.9.9'] }).status).toBe(2);
    expect(runIn(repo, prs, { args: ['--since', 'v0.1.0'] }).status).toBe(1);
  });
});
