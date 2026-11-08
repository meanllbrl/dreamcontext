import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planDecide, planOpen, planPacket, planRecord, planStatus, PlanRefusal } from '../../src/cli/commands/plan.js';
import { reviewPath } from '../../src/lib/plan-store.js';
import type { PlanStop } from '../../src/lib/plan-ledger.js';
import { makePlanVault, reviewText, writePlan, type PlanVault } from '../helpers/plan-vault.js';

/**
 * The owner's validation for the planning loop (2026-11-08): replay the Telegram plan's audited
 * round history through the new ledger and show where the new rules stop it. Historically the
 * plan ran 30 rounds and its picture superclass ran r15 to r29; the fixture header states the
 * replay's conventions.
 */

interface Fixture { lenses: string[]; picture: string; rounds: Array<{ n: number; critic: string[]; security: string[] }> }
const FIXTURE: Fixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/plan-replay/history.json'), 'utf-8'));
const PLAN = 'telegram-replay';

type Decision = 'continue' | 'narrow' | null;
interface ReplayLog {
  stops: Map<number, PlanStop[]>;
  decisions: Array<{ before: number; kind: string }>;
  refusedAt: number | null;
  refusal: string;
  lastRound: number;
}

const cls = (raw: string): { cls: string; level: 'Critical' | 'Major' } =>
  raw.startsWith('!') ? { cls: raw.slice(1).toLowerCase(), level: 'Critical' } : { cls: raw.toLowerCase(), level: 'Major' };

async function replay(v: PlanVault, decide: (round: number) => Decision, addAt: number[]): Promise<ReplayLog> {
  const task = await v.backend.create({ name: 'Telegram replay task' });
  await planOpen(v.deps, PLAN, { task: task.slug, goal: 'Replay the audited history', lenses: 'critic,security' });
  const log: ReplayLog = { stops: new Map(), decisions: [], refusedAt: null, refusal: '', lastRound: 0 };
  for (const r of FIXTURE.rounds) {
    let st = planStatus(v.deps, PLAN).state;
    if (st.done) {
      if (!addAt.includes(r.n)) break;
      await planDecide(v.deps, PLAN, 'add', { note: `owner addition before round ${r.n}` });
      log.decisions.push({ before: r.n, kind: 'add' });
      st = planStatus(v.deps, PLAN).state;
    }
    if (st.next.kind === 'stop') {
      const d = decide(r.n - 1);
      if (d) {
        await planDecide(v.deps, PLAN, d, { note: `owner: ${d}` });
        log.decisions.push({ before: r.n, kind: d });
        st = planStatus(v.deps, PLAN).state;
      }
    }
    const redesign = st.stops.filter((s) => s.kind === 'redesign').map((s) => `redesign: ${s.cls} | one layer for the whole class (round ${r.n})`);
    writePlan(v, PLAN, r.n, redesign);
    try {
      await planPacket(v.deps, PLAN, 'critic');
    } catch (err) {
      if (!(err instanceof PlanRefusal)) throw err;
      log.refusedAt = r.n;
      log.refusal = err.message;
      return log;
    }
    await planPacket(v.deps, PLAN, 'security');
    for (const lens of FIXTURE.lenses) {
      const own = st.open.filter((f) => f.lens === lens).map((f) => [f.id, 'dropped by the audit rows'] as [string, string]);
      const rows = (lens === 'critic' ? r.critic : r.security).map(cls);
      const file = reviewPath(v.root, PLAN, r.n, lens);
      writeFileSync(file, reviewText(rows.map((x) => ({ cls: x.cls, level: x.level })), own));
      const out = await planRecord(v.deps, PLAN, lens, {});
      expect(out, `round ${r.n} ${lens}`).not.toMatch(/UNPARSED/);
    }
    const after = planStatus(v.deps, PLAN).state;
    expect(after.round).toBe(r.n);
    log.stops.set(r.n, after.stops);
    log.lastRound = r.n;
  }
  return log;
}

const has = (stops: PlanStop[] | undefined, kind: PlanStop['kind'], c?: string): boolean =>
  (stops ?? []).some((s) => s.kind === kind && (c === undefined || s.cls === c));

let v: PlanVault;
afterEach(() => v?.cleanup());

describe('Telegram replay under the new rules', () => {
  it('(a) no owner events: redesign at r2, stop class at r3, round 4 refused', async () => {
    v = makePlanVault();
    const log = await replay(v, () => null, []);
    expect(has(log.stops.get(2), 'redesign', 'a')).toBe(true);
    expect(has(log.stops.get(2), 'class')).toBe(false);
    expect(has(log.stops.get(3), 'class', 'a')).toBe(true);
    expect(log.refusedAt).toBe(4);
    expect(log.refusal).toMatch(/Plan durdu → telegram-replay/);
  });

  it('(b) Devam at every class stop, additions at r10 and r15: no budget stop, the picture class stops at r17', async () => {
    v = makePlanVault();
    const log = await replay(v, () => 'continue', [10, 15]);
    expect(log.refusedAt).toBeNull();
    expect(log.lastRound).toBe(30);
    expect([...log.stops.values()].some((s) => has(s, 'budget'))).toBe(false);
    expect(log.decisions.filter((d) => d.kind === 'add').map((d) => d.before)).toEqual([10, 15]);
    // Round numbers keep counting across the additions (the ledger's round = the history's).
    const ledger = JSON.parse(readFileSync(join(v.root, 'tmp/plans', PLAN, 'ledger.json'), 'utf-8'));
    expect(ledger.rounds.map((r: { n: number }) => r.n).slice(9, 10)).toEqual([10]);
    expect(ledger.rounds.map((r: { n: number }) => r.n).slice(14, 15)).toEqual([15]);
    expect(has(log.stops.get(16), 'redesign', FIXTURE.picture)).toBe(true);
    expect(has(log.stops.get(17), 'class', FIXTURE.picture)).toBe(true);
    // Historically the picture superclass ran to r29: the first class stop on it is 12 rounds earlier.
    const firstPictureStop = [...log.stops].find(([, s]) => has(s, 'class', FIXTURE.picture))?.[0];
    expect(firstPictureStop).toBe(17);
    expect([...log.stops.values()].some((s) => has(s, 'churn'))).toBe(false);
  });

  it('(c) Daralt at every class stop before r8 and no decision at r8: round 9 is refused on the budget', async () => {
    v = makePlanVault();
    const log = await replay(v, (round) => (round < 8 ? 'narrow' : null), []);
    expect(has(log.stops.get(8), 'budget')).toBe(true);
    expect(log.refusedAt).toBe(9);
    expect(log.decisions.every((d) => d.kind === 'narrow')).toBe(true);
  });
});
