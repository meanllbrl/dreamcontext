/**
 * Criterion 11 (super-cocuk-tasarruf D6): `superEffect` from synthetic ledgers. Sides by session,
 * strata (mode x model family), the Super's overhead spread in proportion, "az veri" under 10,
 * "Fark yok" under 10%, the pre-Super fallback clamped to the ledger's first row, a mode-less plain
 * session in the model-only stratum, successors through the handoff log, no division by zero, the
 * cache split, and the card's Turkish and English words. Fictional "Acme" sessions only.
 */
import { describe, it, expect } from 'vitest';
import type { LedgerFile, LedgerRow } from '../../src/lib/usage-ledger.js';
import { superEffect, modelFamily, type SuperEffectInput } from '../../src/lib/usage-super-effect.js';
import { stratumDiff, stratumLabel, superFoot, superWhy } from '../../dashboard/src/components/stats/superEffectWords';
import type { SuperEffect } from '../../dashboard/src/components/stats/statsTypes';

const H = 3_600_000;
const DAY = 24 * H;
const START = Date.parse('2026-11-01T00:00:00.000Z');
const END = START + 14 * DAY;
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];

/** One main file: `tokens` read+written in one row at `at`, `output` of them written. */
function file(session: string, o: {
  at?: number; tokens?: number; output?: number; model?: number; kind?: 'owner' | 'super' | 'auto'; mode?: string;
  sends?: number; handoffOpening?: boolean; agent?: string; cacheRead?: number;
} = {}): LedgerFile {
  const at = o.at ?? START + DAY;
  const output = o.output ?? 1_000;
  const total = o.tokens ?? 100_000;
  const cacheRead = o.cacheRead ?? 0;
  const row: LedgerRow = [Math.floor(at / H) * H, o.model ?? 0, 0, total - output - cacheRead, cacheRead, 0, output, -1, 0, 0, 0, 0];
  return {
    s: 1, m: 1, tool: 'claude', session, cwd: '/acme', first: at, last: at, reqs: 1, ctx0: 0, ctx1: 0,
    rows: [row], spans: [], hits: [], snapshots: 0, recalls: 0,
    prompts: o.agent ? [] : [[at, o.kind ?? 'owner', 0]],
    sends: Array.from({ length: o.sends ?? 0 }, (_, i) => [at + i, 'c'] as [number, string]),
    keys: '',
    ...(o.agent ? { agent: o.agent } : {}),
    ...(o.mode !== undefined ? { mode: o.mode } : {}),
    ...(o.handoffOpening !== undefined ? { handoffOpening: o.handoffOpening } : {}),
  };
}

function input(files: Record<string, LedgerFile>, over: Partial<SuperEffectInput> = {}): SuperEffectInput {
  return {
    files, models: MODELS, named: new Set(), namedMode: new Map(), handoffs: [],
    rangeStart: START, rangeEnd: END, cost: (_m, t) => (t.input + t.cacheRead + t.cacheWrite + t.output) / 1e6, ...over,
  };
}

/** n sessions of a side, each `tokens` with 1k output. */
function many(prefix: string, n: number, o: Parameters<typeof file>[1]): Record<string, LedgerFile> {
  const out: Record<string, LedgerFile> = {};
  for (let i = 0; i < n; i++) out[`/p/${prefix}-${i}.jsonl`] = file(`${prefix}-${i}`, o);
  return out;
}

describe('superEffect', () => {
  it('Super children below plain work by 20%: Azaltıyor, weighted over the counted strata', () => {
    const e = superEffect(input({
      ...many('sup', 12, { kind: 'super', mode: 'develop', tokens: 80_000 }),
      ...many('own', 12, { kind: 'owner', mode: 'develop', tokens: 100_000 }),
    }));
    expect(e.verdict).toBe('reduces');
    expect(e.diffPct).toBeCloseTo(-20, 5);
    expect(e.strata).toHaveLength(1);
    expect(e.strata[0]).toMatchObject({ mode: 'develop', model: 'opus', superSessions: 12, plainSessions: 12, window: 'range' });
    expect(e.strata[0].superMedian).toBe(80_000);
    expect(e.strata[0].plainMedian).toBe(100_000);
    expect(e.costDiff).toBeCloseTo(-0.02, 6);
  });

  it('the Super\'s own sessions are overhead, spread in proportion to each stratum\'s Super tokens', () => {
    const base = {
      ...many('sup', 10, { kind: 'super', mode: 'develop', tokens: 95_000 }),
      ...many('own', 10, { kind: 'owner', mode: 'develop', tokens: 100_000 }),
    };
    const without = superEffect(input(base));
    expect(without.verdict).toBe('same');
    // 10 x 95k = 950k Super tokens (-5%: no difference); a 250k Super session lifts it to 1.2M: +20%.
    const e = superEffect(input({ ...base, '/p/super.jsonl': file('super-main', { kind: 'owner', sends: 3, tokens: 250_000 }) }));
    expect(e.overhead).toEqual({ tokens: 250_000, attributed: true });
    expect(e.diffPct).toBeCloseTo(20, 5);
    expect(e.verdict).toBe('increases');
    expect(e.top).toEqual({ mode: 'develop', model: 'opus' });
  });

  it('under 10 on a side is "az veri" and enters no total; none counted = Henüz söylenemiyor with the plain count', () => {
    const e = superEffect(input({
      ...many('sup', 12, { kind: 'super', mode: 'plan', tokens: 80_000 }),
      ...many('own', 4, { kind: 'owner', mode: 'plan', tokens: 100_000 }),
    }));
    expect(e.strata[0].diffPct).toBeNull();
    expect(e.verdict).toBe('unknown');
    expect(e.missing).toMatchObject({ strata: 1, plainShort: 4, short: 'plain' });
  });

  it('fewer than 10 Super jobs with 10+ plain ones: unknown, and it names the Super side', () => {
    const e = superEffect(input({
      ...many('sup', 3, { kind: 'super', mode: 'develop', tokens: 80_000 }),
      ...many('own', 14, { kind: 'owner', mode: 'develop', tokens: 100_000 }),
    }));
    expect(e.verdict).toBe('unknown');
    expect(e.missing).toMatchObject({ strata: 1, superShort: 3, short: 'super' });
  });

  it("only the Super's own sessions in range: unknown, no stratum, short = ownOnly", () => {
    const e = superEffect(input({
      '/p/super.jsonl': file('super-main', { kind: 'owner', sends: 3, tokens: 250_000 }),
      ...many('own', 14, { kind: 'owner', mode: 'develop', tokens: 100_000 }),
    }));
    expect(e.strata).toEqual([]);
    expect(e.verdict).toBe('unknown');
    expect(e.missing.short).toBe('ownOnly');
  });

  it('no Super session in range: Super bu aralıkta çalışmadı; no division by zero anywhere', () => {
    const e = superEffect(input(many('own', 3, { kind: 'owner', tokens: 100_000, output: 0 })));
    expect(e.verdict).toBe('noSuper');
    expect(e.strata).toEqual([]);
    expect(e.diffPct).toBeNull();
    expect(e.cacheShare.super).toBeNull();
    const empty = superEffect(input({}));
    expect(empty.verdict).toBe('noSuper');
  });

  it('few plain sessions in range: the 30 days before the first Super session, clamped to the ledger\'s first row', () => {
    const firstSuper = START + 2 * DAY;
    const ledgerFirst = START - 10 * DAY;
    const e = superEffect(input({
      ...many('sup', 10, { kind: 'super', mode: 'develop', tokens: 80_000, at: firstSuper }),
      ...many('old', 10, { kind: 'owner', mode: 'develop', tokens: 100_000, at: START - 5 * DAY }),
      '/p/first.jsonl': file('first', { kind: 'owner', mode: 'basic', at: ledgerFirst, tokens: 1_000 }),
    }, { rangeStart: START, rangeEnd: END }));
    const s = e.strata.find((x) => x.mode === 'develop')!;
    expect(s.window).toBe('before');
    expect(s.windowFrom).toBe(ledgerFirst);
    expect(s.windowTo).toBe(firstSuper);
    expect(s.plainSessions).toBe(10);
    expect(s.diffPct).toBeCloseTo(-20, 5);
  });

  it('a mode-less plain session lands in the model-only stratum, beside the Super sessions of unknown mode', () => {
    const e = superEffect(input({
      ...many('sup', 10, { kind: 'super', tokens: 80_000 }),
      ...many('own', 10, { kind: 'owner', mode: '', tokens: 100_000 }),
    }));
    expect(e.strata).toHaveLength(1);
    expect(e.strata[0].mode).toBeNull();
    expect(e.strata[0].plainSessions).toBe(10);
  });

  it('a named child and its successor two hops on are on the Super side; an owner chat\'s successor on the plain side', () => {
    const files = {
      ...many('own', 10, { kind: 'owner', mode: 'develop', tokens: 100_000 }),
      ...many('sup', 9, { kind: 'super', mode: 'develop', tokens: 80_000 }),
      '/p/child-a.jsonl': file('child-a', { kind: 'owner', tokens: 80_000 }),
      '/p/child-b.jsonl': file('child-b', { kind: 'owner', handoffOpening: true, tokens: 80_000 }),
      '/p/child-c.jsonl': file('child-c', { kind: 'owner', handoffOpening: true, tokens: 80_000 }),
      '/p/mine-next.jsonl': file('mine-next', { kind: 'owner', handoffOpening: true, mode: 'develop', tokens: 100_000 }),
    };
    const e = superEffect(input(files, {
      named: new Set(['child-a']), namedMode: new Map([['child-a', 'develop']]),
      handoffs: [{ fromSession: 'child-a', toSession: 'child-b' }, { fromSession: 'child-b', toSession: 'child-c' }, { fromSession: 'own-0', toSession: 'mine-next' }],
    }));
    const s = e.strata.find((x) => x.mode === 'develop')!;
    expect(s.superSessions).toBe(12);
    expect(s.plainSessions).toBe(11);
    expect(e.missing.unlinkedSuccessors).toBe(0);
  });

  it('a continue-prompt session no log line names counts on neither side, in missing', () => {
    const e = superEffect(input({
      ...many('sup', 10, { kind: 'super', mode: 'develop' }),
      ...many('own', 10, { kind: 'owner', mode: 'develop' }),
      '/p/orphan.jsonl': file('orphan', { kind: 'owner', handoffOpening: true, mode: 'develop' }),
    }));
    expect(e.missing.unlinkedSuccessors).toBe(1);
    expect(e.strata[0].plainSessions).toBe(10);
  });

  it('machine runs count nowhere; a sub-agent file counts with its session; every session in one stratum', () => {
    const files = {
      ...many('sup', 10, { kind: 'super', mode: 'develop', tokens: 50_000 }),
      ...many('own', 10, { kind: 'owner', mode: 'develop', tokens: 100_000 }),
      ...many('bot', 5, { kind: 'auto', mode: 'develop', tokens: 9_000_000 }),
      '/p/sup-0/subagents/agent-x.jsonl': file('sup-0', { agent: 'reviewer', tokens: 50_000, output: 0, model: 1 }),
    };
    const e = superEffect(input(files));
    const total = e.strata.reduce((n, s) => n + s.superSessions + s.plainSessions, 0);
    expect(total).toBe(20);
    expect(e.totals.super).toBe(10 * 50_000 + 50_000);
    expect(e.totals.plain).toBe(10 * 100_000);
    // The sub-agent's Sonnet tokens do not move its session's family: still Opus.
    expect(e.strata[0].model).toBe('opus');
  });

  it('the cache split is per side', () => {
    const e = superEffect(input({
      ...many('sup', 10, { kind: 'super', mode: 'develop', tokens: 100_000, cacheRead: 90_000 }),
      ...many('own', 10, { kind: 'owner', mode: 'develop', tokens: 100_000, cacheRead: 45_000 }),
    }));
    expect(e.cacheShare.super).toBeCloseTo(90_000 / 99_000, 6);
    expect(e.cacheShare.plain).toBeCloseTo(45_000 / 99_000, 6);
  });

  it('model families', () => {
    expect(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'gpt-5', 'x'].map(modelFamily))
      .toEqual(['opus', 'sonnet', 'haiku', 'fable', 'gpt', 'other']);
  });
});

describe('the card\'s words', () => {
  const tr: Record<string, string> = {
    'stats.super.reduces.why': "Aynı tür işte iş başına {p} daha az token, Super'in kendi payı dahil.",
    'stats.super.increases.why': 'Aynı tür işte iş başına {p} daha fazla token. En çok {top} işinde.',
    'stats.super.unknown.why': "Super'siz yalnız {n} iş var, en az 10 gerekiyor.",
    'stats.super.unknown.superWhy': "Super'li yalnız {n} iş var, en az 10 gerekiyor.",
    'stats.super.unknown.ownOnly': "Yalnız Super'in kendi oturumları var.",
    'stats.super.mode.develop': 'Geliştirme', 'stats.super.model.opus': 'Opus', 'stats.super.mode.unknown': 'İş türü bilinmiyor',
    'stats.super.fewData': 'az veri', 'stats.super.rowSame': '~aynı',
    'stats.super.cache': "Token, iş başına ortanca. Önbellekten okunan ayrı: Super'li işte {a}, Super'siz işte {b}.",
    'stats.super.method': 'M', 'stats.super.machine': 'X', 'stats.super.costLess': 'API fiyatıyla: iş başına {c} daha az.',
    'stats.super.unlinked': '{n} devam oturumu iki tarafta da sayılmadı.',
  };
  const en: Record<string, string> = { 'stats.super.reduces.why': '{p} fewer tokens per job on the same kind of work.', 'stats.super.fewData': 'too few' };
  const t = (d: Record<string, string>) => (k: string) => d[k] ?? k;
  const effect = (o: Partial<SuperEffect>): SuperEffect => ({
    verdict: 'reduces', diffPct: -18.4, measure: 'tokensPerOutput', strata: [], overhead: { tokens: 0, attributed: false },
    totals: { super: 0, plain: 0 }, cacheShare: { super: 0.97, plain: 0.96 }, costDiff: -2.1, top: { mode: 'develop', model: 'opus' },
    missing: { strata: 0, unlinkedSuccessors: 0, plainShort: 0, superShort: 0, short: null }, ...o,
  });

  it('Turkish: the verdict line, the row label, the diff column and the foot', () => {
    expect(superWhy(effect({}), t(tr))).toBe("Aynı tür işte iş başına ~18% daha az token, Super'in kendi payı dahil.");
    expect(superWhy(effect({ verdict: 'increases', diffPct: 12 }), t(tr))).toBe('Aynı tür işte iş başına ~12% daha fazla token. En çok Geliştirme · Opus işinde.');
    expect(superWhy(effect({ verdict: 'unknown', missing: { strata: 1, unlinkedSuccessors: 0, plainShort: 4, superShort: 0, short: 'plain' } }), t(tr))).toBe("Super'siz yalnız 4 iş var, en az 10 gerekiyor.");
    expect(superWhy(effect({ verdict: 'unknown', missing: { strata: 1, unlinkedSuccessors: 0, plainShort: 0, superShort: 3, short: 'super' } }), t(tr))).toBe("Super'li yalnız 3 iş var, en az 10 gerekiyor.");
    expect(superWhy(effect({ verdict: 'unknown', missing: { strata: 0, unlinkedSuccessors: 0, plainShort: 0, superShort: 0, short: 'ownOnly' } }), t(tr))).toBe("Yalnız Super'in kendi oturumları var.");
    expect(stratumLabel({ mode: null, model: 'opus' }, t(tr))).toBe('İş türü bilinmiyor · Opus');
    const row = { mode: 'develop', model: 'opus', superSessions: 12, plainSessions: 12, superRatio: 1, plainRatio: 1, superMedian: 1, plainMedian: 1, window: 'range' as const, windowFrom: 0, windowTo: 0 };
    expect(stratumDiff({ ...row, diffPct: -18 }, t(tr))).toEqual({ text: '-18%', tone: 'good' });
    expect(stratumDiff({ ...row, diffPct: 4 }, t(tr))).toEqual({ text: '~aynı', tone: null });
    expect(stratumDiff({ ...row, diffPct: null }, t(tr))).toEqual({ text: 'az veri', tone: null });
    const foot = superFoot(effect({ missing: { strata: 0, unlinkedSuccessors: 2, plainShort: 0, superShort: 0, short: null } }), t(tr));
    expect(foot[0]).toBe("Token, iş başına ortanca. Önbellekten okunan ayrı: Super'li işte 97%, Super'siz işte 96%.");
    expect(foot).toContain('API fiyatıyla: iş başına ~$2.10 daha az.');
    expect(foot).toContain('2 devam oturumu iki tarafta da sayılmadı.');
  });

  it('English reads its own dictionary', () => {
    expect(superWhy(effect({}), t(en))).toBe('~18% fewer tokens per job on the same kind of work.');
    expect(stratumDiff({ mode: 'plan', model: 'opus', superSessions: 1, plainSessions: 1, superRatio: null, plainRatio: null, superMedian: null, plainMedian: null, diffPct: null, window: 'range', windowFrom: 0, windowTo: 0 }, t(en)).text).toBe('too few');
  });
});
