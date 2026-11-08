import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  planDecide, planLink, planMergeClass, planOpen, planPacket, planRecord, planStatus, PlanRefusal,
} from '../../src/cli/commands/plan.js';
import { computePlanState, parseReview, renderStopCard, type Ledger, type ParseContext } from '../../src/lib/plan-ledger.js';
import { PLAN_REVIEW_RULES } from '../../src/lib/plan-review-rules.js';
import { ledgerPath, planDir, planFilePath, readPlanLedgers, reviewPath } from '../../src/lib/plan-store.js';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';
import { makePlanVault, makeReadyTask, reviewText, writePlan, type PlanVault, type ReviewFinding } from '../helpers/plan-vault.js';

/**
 * The planning loop's ledger (task planlama-dongusu-sinif-bazli-…, criteria 1-9): rounds that
 * keep counting, the round lifecycle, the finding rules, the four stops, the stop card, the
 * packet and the safety rules. Every test drives the real `plan` verbs on a scratch vault.
 */

const execFileAsync = promisify(execFile);
const VITE_NODE = process.platform === 'win32' ? process.execPath : resolve('node_modules/.bin/vite-node');
const VITE_NODE_ARGS = process.platform === 'win32' ? [resolve('node_modules/vite-node/dist/cli.mjs')] : [];
const CHILD = resolve('tests/helpers/plan-child.ts');

let v: PlanVault;
afterEach(() => v?.cleanup());

const P = 'p';
const E = 'edge-cases';
type Reviews = { critic?: ReviewFinding[]; [E]?: ReviewFinding[] };

async function open(plan = P): Promise<string> {
  const slug = await makeReadyTask(v, `Task ${plan}`);
  await planOpen(v.deps, plan, { task: slug, goal: 'Ship the thing', lenses: `critic,${E}` });
  return slug;
}

/** One complete round: write plan.md, open it, each lens re-states what it lists and closes the rest. */
async function round(reviews: Reviews = {}, changes: string[] = [], plan = P) {
  const before = planStatus(v.deps, plan).state;
  const n = before.round + (before.roundComplete || before.round === 0 ? 1 : 0);
  writePlan(v, plan, n, changes);
  await planPacket(v.deps, plan, 'critic');
  await planPacket(v.deps, plan, E);
  for (const lens of ['critic', E] as const) {
    const listed = reviews[lens] ?? [];
    const keep = new Set(listed.map((f) => f.id).filter(Boolean));
    const close = before.open.filter((f) => f.lens === lens && !keep.has(f.id)).map((f) => [f.id, 'fixed'] as [string, string]);
    writeFileSync(reviewPath(v.root, plan, n, lens), reviewText(listed, close));
    const out = await planRecord(v.deps, plan, lens, {});
    expect(out, `${lens} r${n}`).not.toMatch(/UNPARSED/);
  }
  return planStatus(v.deps, plan).state;
}

const refused = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (err) { if (err instanceof PlanRefusal || (err as Error).name === 'PlanStoreError' || err instanceof Error) return (err as Error).message; }
  throw new Error('expected a refusal');
};

const ledgerOf = (plan = P): Ledger => JSON.parse(readFileSync(ledgerPath(v.root, plan), 'utf-8'));

describe('round lifecycle', () => {
  it('opening a round sets both fixed lenses PENDING; packet, record, packet is one round; one SOLID lens is not done', async () => {
    v = makePlanVault();
    await open();
    writePlan(v, P, 1);
    const first = await planPacket(v.deps, P, 'critic');
    expect(first).toMatchObject({ round: 1, opened: true });
    expect(Object.fromEntries(Object.entries(ledgerOf().rounds[0].lenses).map(([l, r]) => [l, r.verdict]))).toEqual({ critic: 'PENDING', [E]: 'PENDING' });
    writeFileSync(reviewPath(v.root, P, 1, 'critic'), reviewText([]));
    await planRecord(v.deps, P, 'critic', {});
    const second = await planPacket(v.deps, P, E);
    expect(second).toMatchObject({ round: 1, opened: false });
    const s = planStatus(v.deps, P).state;
    expect(s.round).toBe(1);
    expect(s.done).toBe(false);
    expect(s.next).toMatchObject({ kind: 'review', lenses: [E] });
    expect(ledgerOf().rounds).toHaveLength(1);
  });

  it('an UNPARSED or ABANDONED lens is re-dispatched into the same round and nothing counts until it lands', async () => {
    v = makePlanVault();
    await open();
    writePlan(v, P, 1);
    await planPacket(v.deps, P, 'critic');
    await planPacket(v.deps, P, E);
    writeFileSync(reviewPath(v.root, P, 1, 'critic'), 'Looks fine to me, some thoughts.\n');
    expect(await planRecord(v.deps, P, 'critic', {})).toMatch(/UNPARSED/);
    expect(await refused(planRecord(v.deps, P, 'critic', {}))).toMatch(/not PENDING/);
    expect(await planRecord(v.deps, P, E, { abandon: true, note: 'ran out of turns' })).toMatch(/ABANDONED/);
    let s = planStatus(v.deps, P).state;
    expect(s).toMatchObject({ round: 1, roundComplete: false, classCounts: {} });
    expect(s.next).toMatchObject({ kind: 'review', redispatch: ['critic', E] });
    expect(await planPacket(v.deps, P, 'critic')).toMatchObject({ round: 1, opened: false });
    expect(await planPacket(v.deps, P, E)).toMatchObject({ round: 1, opened: false });
    writeFileSync(reviewPath(v.root, P, 1, 'critic'), reviewText([{ cls: 'alpha' }]));
    await planRecord(v.deps, P, 'critic', {});
    writeFileSync(reviewPath(v.root, P, 1, E), reviewText([]));
    await planRecord(v.deps, P, E, {});
    s = planStatus(v.deps, P).state;
    expect(s).toMatchObject({ round: 1, roundComplete: true, classCounts: { alpha: 1 } });
  });

  it('rounds keep counting across add (on a done plan), continue, narrow, split and a fresh process', async () => {
    v = makePlanVault();
    await open();
    await round({ critic: [{ cls: 'c1' }] });
    let s = await round();
    expect(s).toMatchObject({ round: 2, done: true });
    await planDecide(v.deps, P, 'add', { note: 'owner adds a screen' });
    expect(planStatus(v.deps, P).state.done).toBe(false);
    s = await round({ critic: [{ cls: 'c3' }] });
    expect(s.round).toBe(3);
    await planDecide(v.deps, P, 'continue', { note: 'devam' });
    s = await round({ critic: [{ cls: 'c4' }] });
    expect(s.round).toBe(4);
    await planDecide(v.deps, P, 'narrow', { note: 'daralt' });
    s = await round({ critic: [{ cls: 'c5' }] });
    expect(s.round).toBe(5);
    const follow = await v.backend.create({ name: 'Follow up' });
    await planDecide(v.deps, P, 'split', { note: 'böl', task: follow.slug, classes: ['c5'] });
    const moved = s.open[0].id;
    writePlan(v, P, 6, ['split: c5 | the c5 part']);
    await planPacket(v.deps, P, 'critic');
    await planPacket(v.deps, P, E);
    writeFileSync(reviewPath(v.root, P, 6, 'critic'), reviewText([], [[moved, 'cut']]));
    await planRecord(v.deps, P, 'critic', {});
    writeFileSync(reviewPath(v.root, P, 6, E), reviewText([]));
    await planRecord(v.deps, P, E, {});
    // A fresh process: nothing but the files on disk.
    const fresh = { root: v.root, now: () => new Date(), backend: () => new LocalTaskBackend(join(v.root, 'state')) };
    const after = planStatus(fresh, P).state;
    expect(after.round).toBe(6);
    expect(after.done).toBe(true);
    expect(ledgerOf().rounds.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('finding rules', () => {
  const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
    round: 2, lens: 'critic', ownOpen: new Map(), otherOpen: new Set(), accepted: new Set(), cut: new Set(), ...over,
  });

  it('parses the format; SOLID with a blocking block, an unreadable line or a missing own id is UNPARSED', () => {
    const ok = parseReview(reviewText([{ cls: 'Build Gate ', level: 'Critical' }]), ctx());
    expect(ok).toMatchObject({ verdict: 'NEEDS_WORK', errors: [] });
    expect(ok.findings[0]).toMatchObject({ id: 'r2-critic-1', level: 'Critical', cls: 'build gate', kind: 'contract' });
    expect(parseReview('SOLID\n1. [Major] id: new | class: x | kind: contract | y\n', ctx()).verdict).toBe('UNPARSED');
    expect(parseReview('NEEDS_WORK\n1. [Major] class: x | kind: contract | y\n', ctx()).verdict).toBe('UNPARSED');
    const missing = parseReview('SOLID\n', ctx({ ownOpen: new Map([['r1-critic-1', 'Major']]) }));
    expect(missing.verdict).toBe('UNPARSED');
    expect(missing.errors.join(' ')).toMatch(/r1-critic-1/);
    expect(parseReview('SOLID\nclosed: r1-critic-1 | fixed in the contract\n', ctx({ ownOpen: new Map([['r1-critic-1', 'Major']]) })).verdict).toBe('SOLID');
  });

  it('accepted and cut ids are ignored when listed, an accepted id re-listed higher is new, another lens\'s id is advisory', () => {
    const r = parseReview([
      'NEEDS_WORK',
      '1. [Major] id: r1-critic-2 | class: a | kind: contract | x',
      '2. [Critical] id: r1-critic-3 | class: b | kind: security | x',
      '3. [Major] id: r1-critic-4 | class: c | kind: contract | x',
      '4. [Major] id: r1-edge-cases-1 | class: d | kind: contract | x',
      '5. [Major] id: r1-critic-1 | class: e | kind: contract | x',
      'closed: r1-edge-cases-1 | not mine',
    ].join('\n'), ctx({
      ownOpen: new Map([['r1-critic-1', 'Major']]),
      otherOpen: new Set(['r1-edge-cases-1']),
      accepted: new Set(['r1-critic-2', 'r1-critic-3']),
      cut: new Set(['r1-critic-4']),
    }));
    expect(r.verdict).toBe('NEEDS_WORK');
    expect(r.findings.map((f) => f.id)).toEqual(['r2-critic-2', 'r1-critic-1']);
    expect(r.closed).toEqual([]);
  });

  it('in a round: a closed line closes, another lens\'s closed line or re-statement changes nothing, a re-stated finding counts its class', async () => {
    v = makePlanVault();
    await open();
    let s = await round({ critic: [{ cls: 'alpha' }], [E]: [{ cls: 'beta' }] });
    const [a, b] = [s.open.find((f) => f.lens === 'critic')!.id, s.open.find((f) => f.lens === E)!.id];
    writePlan(v, P, 2);
    await planPacket(v.deps, P, 'critic');
    await planPacket(v.deps, P, E);
    writeFileSync(reviewPath(v.root, P, 2, 'critic'), reviewText([{ id: a, cls: 'alpha' }, { cls: 'gamma' }]));
    await planRecord(v.deps, P, 'critic', {});
    // The edge lens closes its own id, "closes" the critic's and re-states it: advisory only.
    writeFileSync(reviewPath(v.root, P, 2, E), reviewText([{ id: a, cls: 'alpha' }], [[b, 'fixed'], [a, 'fixed too']]));
    await planRecord(v.deps, P, E, {});
    s = planStatus(v.deps, P).state;
    expect(s.open.map((f) => f.id)).toEqual([a, 'r2-critic-2']);
    expect(s.classCounts).toMatchObject({ alpha: 2, beta: 1, gamma: 1 });
    // Owner accepts the Major: it leaves the open set; re-listed at Critical it is a new finding.
    await planDecide(v.deps, P, 'accept', { finding: a, note: 'ok as is' });
    expect(planStatus(v.deps, P).state.open.map((f) => f.id)).toEqual(['r2-critic-2']);
    writePlan(v, P, 3, ['redesign: alpha | one layer']);
    await planPacket(v.deps, P, 'critic');
    await planPacket(v.deps, P, E);
    writeFileSync(reviewPath(v.root, P, 3, 'critic'), reviewText([{ id: a, cls: 'alpha', level: 'Critical' }], [['r2-critic-2', 'fixed']]));
    await planRecord(v.deps, P, 'critic', {});
    writeFileSync(reviewPath(v.root, P, 3, E), reviewText([]));
    await planRecord(v.deps, P, E, {});
    s = planStatus(v.deps, P).state;
    expect(s.open.map((f) => [f.id, f.level])).toEqual([['r3-critic-1', 'Critical']]);
    expect(await refused(planDecide(v.deps, P, 'accept', { finding: 'r3-critic-1', note: 'no' }))).toMatch(/Critical cannot be accepted/);
  });
});

describe('stops', () => {
  it('a class in 2 rounds asks a redesign line; in 3 it stops, also after continue, and again at its next counted round', async () => {
    v = makePlanVault();
    await open();
    let s = await round({ critic: [{ cls: 'alpha' }] });
    const a = s.open[0].id;
    s = await round({ critic: [{ id: a, cls: 'alpha' }] });
    expect(s.stops).toEqual([{ kind: 'redesign', cls: 'alpha' }]);
    expect(s.next.kind).toBe('redesign');
    writePlan(v, P, 3);
    expect(await refused(planPacket(v.deps, P, 'critic'))).toMatch(/redesign: alpha \|/);
    s = await round({ critic: [{ id: a, cls: 'alpha' }] }, ['redesign: alpha | one gate for every door']);
    expect(ledgerOf().events.some((e) => e.kind === 'redesign' && e.cls === 'alpha')).toBe(true);
    expect(s.stops).toEqual([{ kind: 'class', cls: 'alpha' }]);
    writePlan(v, P, 4);
    expect(await refused(planPacket(v.deps, P, 'critic'))).toMatch(/Plan durdu → p/);
    await planDecide(v.deps, P, 'continue', { note: 'devam' });
    s = await round({ critic: [{ id: a, cls: 'alpha' }] });
    expect(s.stops).toContainEqual({ kind: 'class', cls: 'alpha' });
  });

  it('a complete round ≥ 8 not done stops on the budget; continue removes it; narrow clearing it moves the next to round 10', async () => {
    v = makePlanVault();
    await open();
    for (let n = 1; n <= 8; n += 1) await round({ critic: [{ cls: `c${n}` }] });
    let s = planStatus(v.deps, P).state;
    expect(s.stops).toEqual([{ kind: 'budget' }]);
    writePlan(v, P, 9);
    expect(await refused(planPacket(v.deps, P, 'critic'))).toMatch(/8\. tur bitti/);
    await planDecide(v.deps, P, 'narrow', { note: 'daralt' });
    s = await round({ critic: [{ cls: 'c9' }] });
    expect(s.stops).toEqual([]);
    s = await round({ critic: [{ cls: 'c10' }] });
    expect(s.stops).toEqual([{ kind: 'budget' }]);
    expect(s.budget).toMatchObject({ extra: 2, limit: 10 });
    await planDecide(v.deps, P, 'continue', { note: 'devam' });
    s = await round({ critic: [{ cls: 'c11' }] });
    expect(s.stops).toEqual([]);
    expect(s.budget).toMatchObject({ unlimited: true, limit: null });
  });

  it('narrow that clears only a class stop leaves the budget where it was', async () => {
    v = makePlanVault();
    await open();
    let s = await round({ critic: [{ cls: 'alpha' }] });
    const a = s.open[0].id;
    await round({ critic: [{ id: a, cls: 'alpha' }] });
    s = await round({ critic: [{ id: a, cls: 'alpha' }] }, ['redesign: alpha | x']);
    expect(s.stops).toEqual([{ kind: 'class', cls: 'alpha' }]);
    await planDecide(v.deps, P, 'narrow', { note: 'cut alpha' });
    for (let n = 4; n <= 8; n += 1) s = await round({ critic: [{ cls: `c${n}` }] });
    expect(s.budget.extra).toBe(0);
    expect(s.stops).toEqual([{ kind: 'budget' }]);
  });

  it('churn only when unlimited: 3 non-falling rounds each with a new class; not when the count falls', async () => {
    v = makePlanVault();
    await open();
    await planDecide(v.deps, P, 'continue', { note: 'devam' });
    await round({ critic: [{ cls: 'a1' }] });
    await round({ critic: [{ cls: 'a2' }] });
    let s = await round({ critic: [{ cls: 'a3' }, { cls: 'a3b' }] });
    expect(s.stops).toEqual([]);
    s = await round({ critic: [{ cls: 'a4' }, { cls: 'a4b' }] });
    expect(s.stops).toEqual([{ kind: 'churn' }]);

    v.cleanup();
    v = makePlanVault();
    await open();
    await planDecide(v.deps, P, 'continue', { note: 'devam' });
    await round({ critic: [{ cls: 'b1' }, { cls: 'b1b' }, { cls: 'b1c' }] });
    await round({ critic: [{ cls: 'b2' }, { cls: 'b2b' }] });
    s = await round({ critic: [{ cls: 'b3' }] });
    s = await round({ critic: [{ cls: 'b4' }] });
    expect(s.stops.some((x) => x.kind === 'churn')).toBe(false);

    // Without `continue`, the same history never churns (it meets the budget instead).
    v.cleanup();
    v = makePlanVault();
    await open();
    for (const n of [1, 2, 3, 4]) s = await round({ critic: Array.from({ length: n }, (_, i) => ({ cls: `d${n}-${i}` })) });
    expect(s.stops.some((x) => x.kind === 'churn')).toBe(false);
  });

  it('the stop card is filled from the ledger: title, why, SOLID part, one line per open class, rounds, options with the recommendation first, the Critical kept', async () => {
    v = makePlanVault();
    await open();
    let s = await round({ critic: [{ cls: 'alpha', level: 'Critical' }] });
    const a = s.open[0].id;
    await round({ critic: [{ id: a, cls: 'alpha', level: 'Critical' }] });
    s = await round({ critic: [{ id: a, cls: 'alpha', level: 'Critical' }] }, ['redesign: alpha | x']);
    const card = renderStopCard(ledgerOf(), s);
    expect(card.split('\n')[0]).toBe('Plan durdu → p');
    expect(card).toMatch(/Neden: "alpha" sınıfı 3\. turunda/);
    expect(card).toMatch(/Sağlam olan: edge-cases merceği SOLID/);
    expect(card).toMatch(/- alpha: 1 bulgu \(r1-critic-1 Critical\), 3\. tur/);
    expect(card).toMatch(/Tur: 3 \/ 8 rounds used/);
    const opts = card.split('\n').filter((l) => /^\d\. /.test(l));
    expect(opts.map((l) => l.split(':')[0])).toEqual(['1. Daralt (önerilen)', '2. Böl', '3. Devam']);
    expect(card).toMatch(/Kritik bulgu açık kalır \(r1-critic-1\)/);
    expect(planStatus(v.deps, P).json.card).toBe(card);
  });
});

describe('packet', () => {
  it('holds the snapshot path, the plan\'s sections, every lens\'s previous raw review verbatim, ids, classes and the rules', async () => {
    v = makePlanVault();
    await open();
    writePlan(v, P, 1);
    await planPacket(v.deps, P, 'critic');
    await planPacket(v.deps, P, E);
    expect((await planPacket(v.deps, P, 'pragmatist')).opened).toBe(false);
    const criticR1 = reviewText([{ cls: 'alpha' }, { cls: 'beta' }]);
    writeFileSync(reviewPath(v.root, P, 1, 'critic'), criticR1);
    writeFileSync(reviewPath(v.root, P, 1, E), reviewText([]));
    writeFileSync(reviewPath(v.root, P, 1, 'pragmatist'), 'PROPOSALS\n- cut: the export | v1 ships without it | one lane\n');
    for (const l of ['critic', E, 'pragmatist']) await planRecord(v.deps, P, l, {});
    await planDecide(v.deps, P, 'accept', { finding: 'r1-critic-2', note: 'fine' });
    writePlan(v, P, 2, ['Rewrote the gate section']);
    const pk = await planPacket(v.deps, P, E);
    const text = readFileSync(pk.path, 'utf-8');
    expect(text).toContain(join(planDir(v.root, P), 'plan.r2.md'));
    for (const s of ['## Decisions\n- Budget 8 rounds.', '## Out of scope\n- Nothing else.', '## Environment\n- Base fixture.', '## Changes in this revision\n- Rewrote the gate section']) expect(text).toContain(s);
    expect(text).toContain(criticR1.trim());
    expect(text).toContain('### r1-edge-cases.md');
    expect(text).toContain('- cut: the export | v1 ships without it | one lane');
    expect(text).toContain('- r1-critic-1 [Major] class: alpha (critic)');
    expect(text).toMatch(/Owner-accepted ids[^\n]*\n- r1-critic-2/);
    expect(text).toContain('- alpha (1 counted round)');
    expect(text).toContain(PLAN_REVIEW_RULES);
    expect(pk.text).toBe(text);
  });

  it('the pragmatist joins round 1 and the round after an addition, never opens a round; packet refuses a done plan and an unchanged plan', async () => {
    v = makePlanVault();
    await open();
    writePlan(v, P, 1);
    expect(await refused(planPacket(v.deps, P, 'pragmatist'))).toMatch(/never opens a round/);
    await planPacket(v.deps, P, 'critic');
    await planPacket(v.deps, P, 'pragmatist');
    await planPacket(v.deps, P, E);
    for (const l of ['critic', E]) { writeFileSync(reviewPath(v.root, P, 1, l), reviewText(l === 'critic' ? [{ cls: 'a' }] : [])); await planRecord(v.deps, P, l, {}); }
    expect(await refused(planPacket(v.deps, P, 'critic'))).toMatch(/unchanged since round 1/);
    writePlan(v, P, 2);
    await planPacket(v.deps, P, 'critic');
    expect(await refused(planPacket(v.deps, P, 'pragmatist'))).toMatch(/round 1 and the round after an owner addition/);
    await planPacket(v.deps, P, E);
    for (const l of ['critic', E]) { writeFileSync(reviewPath(v.root, P, 2, l), reviewText([], l === 'critic' ? [['r1-critic-1', 'fixed']] : [])); await planRecord(v.deps, P, l, {}); }
    expect(await refused(planPacket(v.deps, P, 'critic'))).toMatch(/is done.*plan link/s);
    await planDecide(v.deps, P, 'add', { note: 'owner adds' });
    writePlan(v, P, 3);
    await planPacket(v.deps, P, 'critic');
    expect((await planPacket(v.deps, P, 'pragmatist')).round).toBe(3);
  });
});

describe('safety', () => {
  it('a symlinked plan folder, plan, ledger or review is refused', async () => {
    v = makePlanVault();
    await open();
    writePlan(v, P, 1);
    // plan.md as a link
    const outside = join(v.project, 'outside.md');
    writeFileSync(outside, readFileSync(planFilePath(v.root, P), 'utf-8'));
    renameSync(planFilePath(v.root, P), join(v.project, 'moved.md'));
    symlinkSync(outside, planFilePath(v.root, P));
    expect(await refused(planPacket(v.deps, P, 'critic'))).toMatch(/symlink/);
    // a review as a link
    renameSync(planFilePath(v.root, P), join(v.project, 'link-gone.md'));
    writePlan(v, P, 1);
    await planPacket(v.deps, P, 'critic');
    const review = join(v.project, 'review.md');
    writeFileSync(review, reviewText([]));
    symlinkSync(review, join(v.project, 'review-link.md'));
    expect(await refused(planRecord(v.deps, P, 'critic', { file: join(v.project, 'review-link.md') }))).toMatch(/symlink/);
    // the ledger as a link
    const realLedger = join(v.project, 'ledger.json');
    renameSync(ledgerPath(v.root, P), realLedger);
    symlinkSync(realLedger, ledgerPath(v.root, P));
    expect(await refused(planPacket(v.deps, P, 'critic'))).toMatch(/cannot be read.*symlink/s);
    // a plan folder as a link
    const elsewhere = join(v.project, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'ledger.json'), readFileSync(realLedger, 'utf-8').replace('"plan": "p"', '"plan": "q"'));
    symlinkSync(elsewhere, planDir(v.root, 'q'));
    expect(await refused(Promise.resolve().then(() => planStatus(v.deps, 'q')))).toMatch(/symlink/);
    expect(readPlanLedgers(v.root).some((r) => !r.ok && /symlink/.test(r.problem))).toBe(true);
  });

  it('an unknown version or a truncated ledger refuses every verb', async () => {
    v = makePlanVault();
    await open();
    const lp = ledgerPath(v.root, P);
    for (const bad of [JSON.stringify({ ...ledgerOf(), v: 2 }), readFileSync(lp, 'utf-8').slice(0, 40)]) {
      writeFileSync(lp, bad);
      writePlan(v, P, 1);
      for (const call of [
        () => planPacket(v.deps, P, 'critic'),
        () => planRecord(v.deps, P, 'critic', {}),
        () => Promise.resolve().then(() => planStatus(v.deps, P)),
        () => planDecide(v.deps, P, 'continue', { note: 'x' }),
        () => planMergeClass(v.deps, P, 'a', 'b'),
        () => planLink(v.deps, P),
      ]) {
        expect(await refused(call())).toMatch(/cannot be read/);
      }
      expect(readFileSync(lp, 'utf-8')).toBe(bad); // nothing re-creates it
    }
  });

  it('two concurrent packets (separate processes) join one round; two concurrent records both land', async () => {
    v = makePlanVault();
    await open();
    writePlan(v, P, 1);
    const run = (verb: string, lens: string) => execFileAsync(VITE_NODE, [...VITE_NODE_ARGS, CHILD, v.root, P, verb, lens]).then((r) => JSON.parse(r.stdout.trim().split('\n').pop()!));
    const packets = await Promise.all([run('packet', 'critic'), run('packet', E)]);
    expect(packets.every((p) => p.ok && p.round === 1)).toBe(true);
    expect(packets.filter((p) => p.opened)).toHaveLength(1);
    expect(ledgerOf().rounds).toHaveLength(1);
    writeFileSync(reviewPath(v.root, P, 1, 'critic'), reviewText([{ cls: 'alpha' }]));
    writeFileSync(reviewPath(v.root, P, 1, E), reviewText([{ cls: 'beta' }]));
    const records = await Promise.all([run('record', 'critic'), run('record', E)]);
    expect(records.every((r) => r.ok)).toBe(true);
    const s = planStatus(v.deps, P).state;
    expect(s.roundComplete).toBe(true);
    expect(s.open.map((f) => f.id).sort()).toEqual(['r1-critic-1', 'r1-edge-cases-1']);
    expect(existsSync(join(planDir(v.root, P), '..', `${P}.lock`))).toBe(false);
  }, 60_000);
});

describe('pure state', () => {
  it('computePlanState of a fresh ledger asks for the first review', () => {
    const l: Ledger = { v: 1, plan: 'x', goal: 'g', task: 't', lenses: ['critic', E], budget: { base: 8, extra: 0, unlimited: false }, createdAt: '', events: [], rounds: [] };
    expect(computePlanState(l).next).toEqual({ kind: 'review', lenses: ['critic', E], redispatch: [] });
  });
});

describe('end-review fixes (2026-11-08)', () => {
  const ctx = (): ParseContext => ({ round: 1, lens: 'critic', ownOpen: new Map(), otherOpen: new Set(), accepted: new Set(), cut: new Set() });

  it('a repeated finding number, a bulleted or "1)" blocking line is UNPARSED, never a silently lost Critical', () => {
    const dup = parseReview('NEEDS_WORK\n1. [Major] id: new | class: naming | kind: contract | x\n1. [Critical] id: new | class: auth | kind: security | y\n', ctx());
    expect(dup.verdict).toBe('UNPARSED');
    expect(dup.errors.join(' ')).toMatch(/number 1 is used twice/);
    expect(parseReview('SOLID\n- [Critical] id: new | class: auth | kind: security | y\n', ctx()).verdict).toBe('UNPARSED');
    expect(parseReview('NEEDS_WORK\n1. [Major] id: new | class: a | kind: contract | x\n2) [Critical] id: new | class: b | kind: security | y\n', ctx()).verdict).toBe('UNPARSED');
    // Build notes may still mention a severity in prose after the heading.
    expect(parseReview('SOLID\n\nBuild notes\n- was [Major] last round, now local\n', ctx()).verdict).toBe('SOLID');
  });

  it('one id held twice keeps the Critical in the open set', () => {
    const l: Ledger = {
      v: 1, plan: 'x', goal: 'g', task: 't', lenses: ['critic', E], budget: { base: 8, extra: 0, unlimited: false }, createdAt: '', seq: 3, events: [],
      rounds: [{ n: 1, openedAt: '', snapshotSha: 's', openSeq: 1, lenses: {
        critic: { verdict: 'NEEDS_WORK', dispatchedAt: '', seq: 2, findings: [{ id: 'r1-critic-1', level: 'Major', cls: 'a', kind: 'contract' }, { id: 'r1-critic-1', level: 'Critical', cls: 'b', kind: 'security' }] },
        [E]: { verdict: 'SOLID', dispatchedAt: '', seq: 3, findings: [] },
      } }],
    };
    expect(computePlanState(l).open.map((f) => [f.id, f.level])).toEqual([['r1-critic-1', 'Critical']]);
  });

  it('an owner addition made while a round runs reopens the plan once that round completes', async () => {
    v = makePlanVault();
    await open();
    writePlan(v, P, 1);
    await planPacket(v.deps, P, 'critic');
    await planPacket(v.deps, P, E);
    await planDecide(v.deps, P, 'add', { note: 'owner adds mid-round' });
    for (const l of ['critic', E]) { writeFileSync(reviewPath(v.root, P, 1, l), reviewText([])); await planRecord(v.deps, P, l, {}); }
    const s = planStatus(v.deps, P).state;
    expect(s.done).toBe(false);
    expect(s.next.kind).toBe('revise');
    writePlan(v, P, 2);
    expect((await planPacket(v.deps, P, 'critic')).round).toBe(2);
  });

  it('merge-class back into its source is refused, so counts never split again', async () => {
    v = makePlanVault();
    await open();
    await round({ critic: [{ cls: 'a' }] });
    let s = await round({ critic: [{ cls: 'b' }] });
    await planMergeClass(v.deps, P, 'a', 'b');
    s = planStatus(v.deps, P).state;
    expect(s.classCounts).toMatchObject({ b: 2 });
    expect(await refused(planMergeClass(v.deps, P, 'b', 'a'))).toMatch(/already resolves to "b"|merging back/);
    expect(planStatus(v.deps, P).state.classCounts).toMatchObject({ b: 2 });
  });

  it('a pragmatist review that did not land is re-dispatched into the same round', async () => {
    v = makePlanVault();
    await open();
    writePlan(v, P, 1);
    await planPacket(v.deps, P, 'critic');
    await planPacket(v.deps, P, 'pragmatist');
    writeFileSync(reviewPath(v.root, P, 1, 'pragmatist'), 'some musings\n');
    expect(await planRecord(v.deps, P, 'pragmatist', {})).toMatch(/UNPARSED/);
    expect((await planPacket(v.deps, P, 'pragmatist')).round).toBe(1);
    expect(await refused(planRecord(v.deps, P, '../state/x', {}))).toMatch(/--lens must be one of/);
  });
});
