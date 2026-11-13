import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendOwnerTurn, newOwnerTurnId, type OwnerTurnLine } from '../../src/lib/owner-words.js';
import {
  ensureMeFile, newEventId, newRuleId, personalStoreRef, projectStoreRef, writeStore, type RuleRecord,
} from '../../src/lib/rules-store.js';
import { learnedThisSleep, ownerWordsBlock, renderOwnerWords } from '../../src/lib/sleep-learns.js';

let tmp: string;
let home: string;
let project: string;
let ctx: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dc-owner-words-packet-')));
  home = join(tmp, 'home');
  project = join(tmp, 'orchard');
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'core'), { recursive: true });
  mkdirSync(home, { recursive: true });
  ensureMeFile(home, 'gardener@example.com');
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function turn(own: string, at: string, over: Partial<OwnerTurnLine> = {}): OwnerTurnLine {
  const t: OwnerTurnLine = { at, turn: newOwnerTurnId(), vault: project, surface: 'chat', via: 'composer', keys: ['k1'], session: 'sess-1', own, ...over };
  appendOwnerTurn(t, { home });
  return t;
}

function rec(headline: string, turnId: string, at: string, over: Partial<RuleRecord> = {}): RuleRecord {
  return {
    id: newRuleId(), scope: 'me', created: { at, by: 'sleep', person: '' },
    events: [{ eid: newEventId(), at, op: 'create', by: 'sleep', conversation: 'sleep', status: 'active', headline, text: headline, quotes: [{ text: headline, turn: turnId, via: 'composer', occasion: 'sess-1' }] }],
    ...over,
  };
}

describe('sleep packet: his words since the last sleep (C5)', () => {
  it('only this vault\'s turns since the last sleep, inside a fresh-nonce fence, indented', () => {
    turn('eski bir şey', '2026-11-01T09:00:00.000Z');
    const t2 = turn('raporda önce sayılar gelsin', '2026-11-03T09:00:00.000Z');
    turn('başka proje', '2026-11-03T10:00:00.000Z', { vault: join(tmp, 'meadow') });
    const b = ownerWordsBlock(ctx, '2026-11-02T00:00:00.000Z', { home });
    expect(b.turns.map((t) => t.turn)).toEqual([t2.turn]);
    const text = renderOwnerWords(b).join('\n');
    expect(text).toContain(`<owner-words-${b.nonce}>`);
    expect(text).toContain(`</owner-words-${b.nonce}>`);
    expect(text).toContain('    raporda önce sayılar gelsin');
    expect(text).toContain(`turn ${t2.turn}`);
    expect(text).toContain('occasion sess-1');
    expect(ownerWordsBlock(ctx, null, { home }).nonce).not.toBe(b.nonce);
  });

  it('a turn that asked to remember a rule and no record cites is listed first as stated, not yet stored', () => {
    turn('testleri çalıştır', '2026-11-03T08:00:00.000Z');
    const stated = turn('bunu hatırla: raporlar kısa olsun', '2026-11-03T09:00:00.000Z');
    const stored = turn('bunu unutma: Opus kullan', '2026-11-03T10:00:00.000Z');
    writeStore(personalStoreRef(home), { version: 1, rules: [rec('Opus for helpers', stored.turn, '2026-11-03T10:01:00.000Z')] });
    const b = ownerWordsBlock(ctx, null, { home });
    expect(b.turns[0]!.turn).toBe(stated.turn);
    expect(b.turns[0]!.stated).toBe(true);
    expect(b.turns.find((t) => t.turn === stored.turn)!.stated).toBe(false);
    const text = renderOwnerWords(b).join('\n');
    expect(text).toMatch(/Stated, not yet stored \(1\)/);
    expect(text).toMatch(/· active · Opus for helpers/);
  });

  it('a very long turn shows its head and tail with its length; an empty ledger says learn nothing', () => {
    expect(renderOwnerWords(ownerWordsBlock(ctx, null, { home })).join('\n')).toMatch(/holds no turn of his.*learn nothing/);
    turn(`${'a'.repeat(3000)}SON`, '2026-11-03T09:00:00.000Z');
    const b = ownerWordsBlock(ctx, null, { home });
    expect(b.turns[0]!.length).toBe(3003);
    expect(b.turns[0]!.text).toMatch(/chars not shown/);
    expect(b.turns[0]!.text.endsWith('SON')).toBe(true);
  });
});

describe('sleep done: learned this sleep (C5, C9)', () => {
  it('lists learned, proposed and repeated rules since the epoch with ids, and the ones waiting for his word', () => {
    const epoch = '2026-11-03T00:00:00.000Z';
    const before = rec('Old rule', 't0', '2026-11-01T09:00:00.000Z');
    const learned = rec('Numbers first in a report', 't1', '2026-11-03T09:00:00.000Z');
    const proposed = rec('Short reports', 't2', '2026-11-03T09:05:00.000Z');
    proposed.events[0]!.status = 'proposed';
    const repeated = rec('Plain Turkish', 't3', '2026-11-01T09:00:00.000Z');
    repeated.events.push({ eid: newEventId(), at: '2026-11-03T11:00:00.000Z', op: 'same', by: 'sleep', conversation: 'sleep', quotes: [{ text: 'sade türkçe', turn: 't4', via: 'telegram', occasion: 'sess-2' }] });
    writeStore(personalStoreRef(home), { version: 1, rules: [before, learned, proposed] });
    writeStore(projectStoreRef(ctx, home), { version: 1, rules: [repeated] });
    const out = learnedThisSleep(ctx, epoch, { home, now: new Date('2026-11-03T12:00:00Z') }).join('\n');
    expect(out).toContain(`${learned.id} · Numbers first in a report`);
    expect(out).toMatch(new RegExp(`proposed \\(waits for his word\\):\\n\\s+- ${proposed.id}`));
    expect(out).toContain(`${repeated.id} · Plain Turkish · said again on 1 other occasion(s)`);
    expect(out).toContain(`Waiting for his word: ${proposed.id}`);
    expect(out).not.toContain(before.id);
  });

  it('nothing in the stores: one line', () => {
    expect(learnedThisSleep(ctx, null, { home })).toEqual(['Learned this sleep: nothing.']);
  });

  it('an unreadable store is named, never read as empty', () => {
    writeFileSync(join(ctx, 'core', 'RULES.json'), '{ broken');
    expect(learnedThisSleep(ctx, null, { home }).join('\n')).toMatch(/project rules store is unreadable/);
  });
});
