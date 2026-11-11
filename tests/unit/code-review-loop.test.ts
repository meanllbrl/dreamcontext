/**
 * A Develop run's code review loop on the plan's engine (task develop-inceleme-dongusu-…):
 * class stops without a round cap, the class-wide fix note, harm-backed Majors, the packet
 * from the CLI, and the plan loop untouched by it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  reviewDecide, reviewOpen, reviewPacket, reviewRecord, reviewStatus, type ReviewDeps,
} from '../../src/cli/commands/review-loop.js';
import { CODE_REVIEW_RULES } from '../../src/lib/code-review-rules.js';
import { computePlanState, parseReview, planGateGaps, type Ledger } from '../../src/lib/plan-ledger.js';
import { reviewLoopDir } from '../../src/lib/plan-store.js';
import { DEVELOP_RECIPE } from '../../src/lib/develop-recipe.js';
import { CLAUDE_ONLY, toolText } from '../../src/lib/tool-text.js';
import { modeBriefing } from '../../src/server/chat-modes.js';

const T = 'demo-task';
const START = 'aaaaaaa1';
const tree = (n: number): string => `bbbbbb${String(n).padStart(2, '0')}`;

let repo: string;
let deps: ReviewDeps;

beforeEach(() => {
  const raw = join(tmpdir(), `code-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  repo = realpathSync(raw);
  let tick = Date.parse('2026-11-08T10:00:00Z');
  // Every path these tests name is a path the trees changed; the real git check has its own test.
  const changed = ['src/lib/export.ts', 'src/a b.ts', 'a.ts', 'b.ts', 'log.ts', 'c.ts'];
  deps = { repo, now: () => new Date((tick += 1000)), brain: () => { throw new Error('no brain in this test'); }, diffNames: () => changed };
  writeFileSync(join(repo, 'criteria.md'), '- [ ] AC1 the export keeps every row\n', 'utf-8');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const dir = (loop = 'end'): string => reviewLoopDir(repo, T, loop);

interface F { id?: string; level?: 'Critical' | 'Major'; cls: string; origin?: string; harm?: string | null }

function review(findings: F[], closed: Array<[string, string]> = []): string {
  const lines = [findings.length > 0 ? 'FAIL' : 'PASS', ''];
  findings.forEach((f, i) => {
    const harm = f.harm === null ? '' : ` | harm: ${f.harm ?? `a user exporting a sheet loses the rows of ${f.cls}`}`;
    lines.push(`${i + 1}. [${f.level ?? 'Major'}] id: ${f.id ?? 'new'} | class: ${f.cls} | origin: ${f.origin ?? 'new'}${harm}`);
    lines.push('   src/lib/export.ts:10 `rows.slice(1)`');
  });
  for (const [id, why] of closed) lines.push(`closed: ${id} | ${why}`);
  lines.push('', 'Non-blocking', '- none');
  return lines.join('\n') + '\n';
}

async function record(lens: string, text: string): Promise<string> {
  const f = join(repo, `in-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(f, text, 'utf-8');
  return reviewRecord(deps, T, 'end', lens, { file: f });
}

function note(lines: string[]): void {
  writeFileSync(join(dir(), 'changes.md'), [...lines, `fix at ${Math.random()}`].join('\n') + '\n', 'utf-8');
}

async function open(lenses = 'reviewer'): Promise<void> {
  await reviewOpen(deps, T, 'end', { lenses, start: START, criteriaFile: join(repo, 'criteria.md') });
}

const ledger = (): Ledger => JSON.parse(readFileSync(join(dir(), 'ledger.json'), 'utf-8')) as Ledger;

describe('open and the round-1 packet', () => {
  it('the packet carries the exact diff ranges, the criteria and the rules', async () => {
    await open();
    const p = await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(1), paths: ['src/lib/export.ts', 'src/a b.ts'] });
    expect(p.opened).toBe(true);
    expect(p.text).toContain(`git diff ${START} ${tree(1)} -- 'src/lib/export.ts'`);
    expect(p.text).toContain(`git diff ${START} ${tree(1)} -- 'src/a b.ts'`);
    expect(p.text).toContain('AC1 the export keeps every row');
    expect(p.text).toContain(CODE_REVIEW_RULES);
    expect(existsSync(p.path)).toBe(true);
    expect(ledger().mode).toBe('code');
  });

  it('refuses an open without readable criteria, and a second open', async () => {
    await expect(reviewOpen(deps, T, 'end', { lenses: 'reviewer', start: START })).rejects.toThrow(/--criteria-file/);
    await open();
    await expect(open()).rejects.toThrow(/already exists/);
    await expect(reviewOpen(deps, T, 'x', { lenses: 'critic', start: START, criteriaFile: join(repo, 'criteria.md') })).rejects.toThrow(/--lenses/);
  });

  it('small work opens a loop with no task: --goal is the one criterion, the key any name', async () => {
    await expect(reviewOpen(deps, 'gorev-kurali', 'end', { lenses: 'reviewer', start: START })).rejects.toThrow(/Small work needs no task: pass --goal/);
    await expect(reviewOpen(deps, 'gorev-kurali', 'end', { lenses: 'reviewer', start: START, goal: '  ' })).rejects.toThrow(/--goal/);
    await expect(reviewOpen(deps, 'gorev-kurali', 'end', { lenses: 'reviewer', start: START, goal: 'x', criteriaFile: join(repo, 'criteria.md') })).rejects.toThrow(/one way/);
    await reviewOpen(deps, 'gorev-kurali', 'end', { lenses: 'reviewer', start: START, goal: 'The title typo is fixed' });
    const p = await reviewPacket(deps, 'gorev-kurali', 'end', 'reviewer', { tree: tree(1), paths: ['a.ts'] });
    expect(p.text).toContain('- [ ] The title typo is fixed');
  });

  it('a team member reads its own scope', async () => {
    await open('review-security,reviewer');
    await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(1), paths: ['a.ts', 'b.ts'] });
    const sec = await reviewPacket(deps, T, 'end', 'review-security', { paths: ['b.ts'] });
    expect(sec.text).toContain(`-- 'b.ts'`);
    expect(sec.text).not.toContain(`-- 'a.ts'`);
  });

  it('a path the trees did not change is refused, so no reviewer reads an empty diff', async () => {
    await open('review-edge-cases,review-security');
    // zsh hands an unquoted $ALL over as ONE argument: refused, with the reason.
    await expect(reviewPacket(deps, T, 'end', 'review-edge-cases', { tree: tree(1), paths: ['a.ts b.ts c.ts'] })).rejects.toThrow(/its own argument/);
    await expect(reviewPacket(deps, T, 'end', 'review-edge-cases', { tree: tree(1), paths: ['a.ts', 'typo.ts'] })).rejects.toThrow(/"typo.ts" is not changed/);
    expect(existsSync(join(dir(), 'r1-review-edge-cases.packet.md'))).toBe(false);
    const p = await reviewPacket(deps, T, 'end', 'review-edge-cases', { tree: tree(1), paths: ['a.ts', 'b.ts'] });
    expect(p.leftOut).toEqual(['src/lib/export.ts', 'src/a b.ts', 'log.ts', 'c.ts']);
    // A team member's own scope is held to the same trees.
    await expect(reviewPacket(deps, T, 'end', 'review-security', { paths: ['nope.ts'] })).rejects.toThrow(/review-security's scope/);
  });

  it('checks the paths against the real git trees', async () => {
    const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();
    git('init', '-q');
    writeFileSync(join(repo, 'one.ts'), 'a\n');
    git('add', 'one.ts');
    const start = git('write-tree');
    writeFileSync(join(repo, 'two.ts'), 'b\n');
    git('add', 'two.ts');
    const now = git('write-tree');
    const real: ReviewDeps = { ...deps, diffNames: undefined };
    await reviewOpen(real, T, 'end', { lenses: 'reviewer', start, criteriaFile: join(repo, 'criteria.md') });
    await expect(reviewPacket(real, T, 'end', 'reviewer', { tree: now, paths: ['one.ts'] })).rejects.toThrow(/"one.ts" is not changed/);
    await expect(reviewPacket(real, T, 'end', 'reviewer', { tree: 'deadbeef', paths: ['two.ts'] })).rejects.toThrow(/git cannot diff/);
    const p = await reviewPacket(real, T, 'end', 'reviewer', { tree: now, paths: ['two.ts'] });
    expect(p.leftOut).toEqual([]);
  });
});

describe('the harm rule', () => {
  const ctx = { round: 1, lens: 'reviewer', ownOpen: new Map(), otherOpen: new Set<string>(), accepted: new Set<string>(), cut: new Set<string>(), mode: 'code' as const, knownClasses: new Set<string>() };

  it('a Major with no concrete harm is a Minor and opens no round', () => {
    const r = parseReview(review([{ cls: 'naming', harm: null }, { cls: 'naming', harm: 'none' }]), ctx);
    expect(r.verdict).toBe('PASS');
    expect(r.findings).toEqual([]);
    expect(r.downgraded.map((d) => d.cls)).toEqual(['naming', 'naming']);
  });

  it('a Critical with no harm is refused, a Major with one is open', () => {
    expect(parseReview(review([{ cls: 'auth', level: 'Critical', harm: null }]), ctx).verdict).toBe('UNPARSED');
    const ok = parseReview(review([{ cls: 'row loss' }]), ctx);
    expect(ok.verdict).toBe('FAIL');
    expect(ok.findings[0]).toMatchObject({ id: 'r1-reviewer-1', cls: 'row loss', kind: 'new' });
  });

  it('a written harm counts wherever it stands and however short it is', () => {
    const line = (tail: string): string => `FAIL\n\n1. [Major] id: new | class: drafts | origin: new | ${tail}\n   a.ts:1\n`;
    for (const tail of ['siblings: a.ts, b.ts | harm: every user loses unsaved drafts on reload', 'harm: auth bypass', 'harm: data loss', '`harm`: every user loses unsaved drafts']) {
      const r = parseReview(line(tail), ctx);
      expect(r.verdict, tail).toBe('FAIL');
      expect(r.findings, tail).toHaveLength(1);
    }
    expect(parseReview(line('harm: n/a'), ctx).verdict).toBe('PASS');
  });

  it('an open finding re-stated without its harm cannot slip out of the open set', () => {
    const own = { ...ctx, round: 2, ownOpen: new Map([['r1-reviewer-1', 'Critical']]) };
    const r = parseReview(review([{ id: 'r1-reviewer-1', cls: 'row loss', harm: null }]), own as typeof ctx);
    expect(r.verdict).toBe('UNPARSED');
    expect(r.errors.join(' ')).toMatch(/re-state it with its harm, or close it/);
  });

  it('same-class must name a known class; an unknown origin is refused', () => {
    expect(parseReview(review([{ cls: 'row loss', origin: 'same-class' }]), ctx).verdict).toBe('UNPARSED');
    expect(parseReview(review([{ cls: 'row loss', origin: 'same-class' }]), { ...ctx, knownClasses: new Set(['row loss']) }).verdict).toBe('FAIL');
    expect(parseReview(review([{ cls: 'row loss', origin: 'guess' }]), ctx).verdict).toBe('UNPARSED');
  });

  it('record says which findings were kept as Minor', async () => {
    await open();
    await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(1), paths: ['a.ts'] });
    const out = await record('reviewer', review([{ cls: 'row loss' }, { cls: 'style', harm: null }]));
    expect(out).toMatch(/Recorded as Minor, no concrete harm .*r1-reviewer-2 \(style\)/);
    expect(computePlanState(ledger()).open.map((f) => f.cls)).toEqual(['row loss']);
  });
});

describe('fix by class, re-review from the CLI', () => {
  it('round 2 waits for a fix note that sweeps every open class, then reads only the fix', async () => {
    await open('reviewer,review-security');
    await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(1), paths: ['a.ts', 'b.ts'] });
    await reviewPacket(deps, T, 'end', 'review-security', {});
    await record('reviewer', review([]));
    const secReview = review([{ cls: 'token leak', harm: 'a signed-in user\'s token reaches the log file' }]);
    await record('review-security', secReview);

    await expect(reviewPacket(deps, T, 'end', 'review-security', { tree: tree(2), paths: ['b.ts'] })).rejects.toThrow(/fix note/);
    note(['did things']);
    await expect(reviewPacket(deps, T, 'end', 'review-security', { tree: tree(2), paths: ['b.ts'] })).rejects.toThrow(/sweep: token leak \|/);
    note(['sweep: token leak | b.ts log(), c.ts debug() | one redact() in log.ts']);
    await expect(reviewPacket(deps, T, 'end', 'review-security', { tree: tree(1), paths: ['b.ts'] })).rejects.toThrow(/nothing was fixed/);
    await expect(reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(2), paths: ['b.ts'] })).rejects.toThrow(/for review-security/);

    const p = await reviewPacket(deps, T, 'end', 'review-security', { tree: tree(2), paths: ['b.ts', 'log.ts'] });
    expect(p.round).toBe(2);
    expect(Object.keys(ledger().rounds[1].lenses)).toEqual(['review-security']);
    expect(p.text).toContain(`git diff ${tree(1)} ${tree(2)} -- 'log.ts'`);
    expect(p.text).toContain(secReview.trim());
    expect(p.text).toContain('### r1-reviewer.md');
    expect(p.text).toContain('sweep: token leak | b.ts log(), c.ts debug() | one redact() in log.ts');
    expect(p.text).toContain('Your own open ids: r1-review-security-1');
  });

  it('a class in its 2nd counted round asks for a redesign, in its 3rd stops for the owner; no round cap', async () => {
    await open();
    const cls = 'row loss';
    await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(1), paths: ['a.ts'] });
    await record('reviewer', review([{ cls }]));
    note([`sweep: ${cls} | a.ts | one place`]);
    await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(2), paths: ['a.ts'] });
    await record('reviewer', review([{ id: 'r1-reviewer-1', cls }]));
    expect(reviewStatus(deps, T, 'end').state.next.kind).toBe('redesign');
    note([`sweep: ${cls} | a.ts | one place`]);
    await expect(reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(3), paths: ['a.ts'] })).rejects.toThrow(/redesign: row loss \|/);
    note([`sweep: ${cls} | a.ts, b.ts | rows()`, `redesign: ${cls} | one rows() reader every export goes through`]);
    await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(3), paths: ['a.ts'] });
    await record('reviewer', review([{ id: 'r1-reviewer-1', cls, origin: 'same-class' }]));
    const st = reviewStatus(deps, T, 'end');
    expect(st.state.next.kind).toBe('stop');
    expect(st.json.card).toMatch(/İnceleme durdu → demo-task/);
    expect(st.json.card).toMatch(/Daralt \(önerilen\)/);
    expect(st.json.card).toContain('dreamcontext builder review decide demo-task <narrow|split|continue>');
    note([`sweep: ${cls} | a.ts | x`]);
    await expect(reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(4), paths: ['a.ts'] })).rejects.toThrow(/a stop stands/);
    await reviewDecide(deps, T, 'end', 'continue', { note: 'Devam' });
    await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(4), paths: ['a.ts'] });
    await record('reviewer', review([{ id: 'r1-reviewer-1', cls }]));
    expect(reviewStatus(deps, T, 'end').state.next.kind).toBe('stop'); // the class comes back: it stops again
  });

  it('rounds are never capped: ten rounds of fresh classes run on', async () => {
    await open();
    await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(1), paths: ['a.ts'] });
    await record('reviewer', review([{ cls: 'c1' }]));
    for (let n = 2; n <= 10; n += 1) {
      note([`sweep: c${n - 1} | a.ts | x`]);
      await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(n), paths: ['a.ts'] });
      await record('reviewer', review([{ cls: `c${n}` }], [[`r${n - 1}-reviewer-1`, 'fixed']]));
    }
    const st = reviewStatus(deps, T, 'end').state;
    expect(st.round).toBe(10);
    expect(st.stops).toEqual([]);
    expect(st.next.kind).toBe('revise');
  });

  it('a PARTIAL is kept and handed to the fresh copy; PASS everywhere is done', async () => {
    await open();
    await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(1), paths: ['a.ts'] });
    const partial = 'PARTIAL\n\n1. [Major] id: new | class: row loss | origin: new | harm: a user loses the last row of every export\nNot reviewed: b.ts\n';
    expect(await record('reviewer', partial)).toMatch(/UNPARSED/);
    const again = await reviewPacket(deps, T, 'end', 'reviewer', {});
    expect(again.opened).toBe(false);
    expect(again.text).toContain('Your earlier PARTIAL review in this round');
    expect(again.text).toContain('Not reviewed: b.ts');
    await record('reviewer', review([]));
    expect(reviewStatus(deps, T, 'end').state.done).toBe(true);
    await expect(reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(2), paths: ['a.ts'] })).rejects.toThrow(/is done/);
  });

  it('an owner addition is the plan\'s, not a code review\'s', async () => {
    await open();
    await expect(reviewDecide(deps, T, 'end', 'add', { note: 'more' })).rejects.toThrow(/belongs to the plan/);
  });
});

describe('safety and the plan loop', () => {
  it('a symlinked loop folder is refused', async () => {
    const elsewhere = join(repo, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(join(repo, 'tmp', 'develop', T, 'review'), { recursive: true });
    symlinkSync(elsewhere, dir());
    await expect(open()).rejects.toThrow(/symlink/);
  });

  it('the plan gate never reads a code loop as a plan', async () => {
    await open();
    await reviewPacket(deps, T, 'end', 'reviewer', { tree: tree(1), paths: ['a.ts'] });
    await record('reviewer', review([{ cls: 'row loss', level: 'Critical', harm: 'every export drops its first row for every user' }]));
    expect(planGateGaps([{ ok: true, ledger: ledger(), dir: dir() }], T)).toEqual([]);
  });

  it('Codex and Antigravity get the same Develop loop, with no Claude-only phrase', () => {
    for (const tool of ['codex', 'antigravity'] as const) {
      const brief = toolText(modeBriefing('develop', { worktreeAllowed: false }), tool);
      expect(brief, tool).not.toMatch(CLAUDE_ONLY);
      expect(brief, tool).toContain('dreamcontext builder review');
      const recipe = toolText(DEVELOP_RECIPE, tool);
      expect(recipe, tool).toContain('dreamcontext builder review packet "$S"');
    }
  });

  it('CODE_REVIEW_RULES is mirrored verbatim in the reviewer agent', () => {
    const agent = readFileSync(join(__dirname, '..', '..', 'agents', 'reviewer.md'), 'utf-8');
    expect(agent).toContain(CODE_REVIEW_RULES);
  });
});
