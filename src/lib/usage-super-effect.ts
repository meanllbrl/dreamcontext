/**
 * "Does the Super Agent raise or lower token use?" (super-cocuk-tasarruf D6): the same kind of
 * work, with and without the Super, compared per stratum (chat mode x main model family).
 *
 * Sides are decided per SESSION, never per job:
 *  - Super side: every session the Super record names (children and former children), a session
 *    the Super's brief opened (first turn `super`), and their sub-agent files. The Super's OWN
 *    sessions (files with `super send` calls) are its overhead, spread over the strata in
 *    proportion to each one's Super tokens.
 *  - Plain side: `owner` sessions not on the Super side that make no sends, with their sub-agents.
 *  - Machine runs (`auto`: builders, sleep, automations) count on neither side.
 *  - A successor (a handoff log line's `toSession`) takes its `fromSession`'s side, transitively.
 *    A session that opens on a continue prompt but no line names counts nowhere: `missing`.
 *
 * Measure: tokens read per 1k output tokens (work-normalised). A stratum with under 10 sessions on
 * either side is "az veri" and enters no total; one with under 10 plain sessions in range first
 * falls back to the 30 days before the first Super session ("önceki dönem"). Pure: the caller
 * passes the ledger, the record facts and a price function.
 */
import type { LedgerFile } from './usage-ledger.js';

export const MIN_SESSIONS = 10;

/** The side a verdict of `unknown` is short on. */
export type SuperShortSide = 'plain' | 'super' | 'ownOnly';
export const SAME_UNDER_PCT = 10;
const DAY = 86_400_000;

export type SuperVerdict = 'reduces' | 'increases' | 'same' | 'unknown' | 'noSuper';

export interface SuperStratum {
  /** Chat mode (`basic`, `develop`, `plan`, ...); null = unknown (a pruned plain session). */
  mode: string | null;
  /** Main model family: `opus`, `sonnet`, `haiku`, `fable`, `gpt` or `other`. */
  model: string;
  superSessions: number;
  plainSessions: number;
  /** Tokens per 1k output, overhead included on the Super side; null = no output. */
  superRatio: number | null;
  plainRatio: number | null;
  /** Median tokens per session (the table's cells). */
  superMedian: number | null;
  plainMedian: number | null;
  /** (super / plain - 1) x 100; null = too few sessions on a side ("az veri"). */
  diffPct: number | null;
  window: 'range' | 'before';
  windowFrom: number;
  windowTo: number;
}

export interface SuperEffect {
  verdict: SuperVerdict;
  diffPct: number | null;
  measure: 'tokensPerOutput';
  strata: SuperStratum[];
  /** The Super's own sessions in range; `attributed` = spread over strata with Super tokens. */
  overhead: { tokens: number; attributed: boolean };
  totals: { super: number; plain: number };
  /** Cache reads as a share of all input, per side (0..1); null = no input. */
  cacheShare: { super: number | null; plain: number | null };
  /** Dollars per session, Super minus plain, weighted over the counted strata; null = none. */
  costDiff: number | null;
  /** The counted stratum with the largest share of the difference (the "most in" line). */
  top: { mode: string | null; model: string } | null;
  /** Why a verdict can be unknown: `short` names the side under {@link MIN_SESSIONS} jobs
   *  (`ownOnly` = only the Super's own sessions ran, no child to compare); the two counts are
   *  the largest job count of that side in a short stratum. */
  missing: { strata: number; unlinkedSuccessors: number; plainShort: number; superShort: number; short: SuperShortSide | null };
}

export interface SuperEffectInput {
  files: Record<string, LedgerFile>;
  models: string[];
  /** Session ids the Super records name (children and former children). */
  named: Set<string>;
  /** A named child's mode from the Super record. */
  namedMode: Map<string, string>;
  /** Handoff log lines: a successor takes its predecessor's side and mode. */
  handoffs: Array<{ fromSession: string; toSession?: string }>;
  rangeStart: number;
  rangeEnd: number;
  /** Cost of a row's tokens for a model, in dollars (0 when unpriced). */
  cost: (model: string, t: { input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; output: number }) => number;
}

export function modelFamily(model: string): string {
  const m = model.toLowerCase();
  for (const f of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(f)) return f;
  if (m.includes('gpt') || m.startsWith('o3') || m.startsWith('o4')) return 'gpt';
  return 'other';
}

/** `none` (no mode heading) is a basic chat. */
const normMode = (m: string | undefined | null): string | null => (m === undefined || m === null || m === '' ? null : m === 'none' ? 'basic' : m);

interface Acc { tokens: number; output: number; input: number; cacheRead: number; cost: number; byModel: Map<number, number> }
const emptyAcc = (): Acc => ({ tokens: 0, output: 0, input: 0, cacheRead: 0, cost: 0, byModel: new Map() });

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function superEffect(input: SuperEffectInput): SuperEffect {
  const { files, models, rangeStart, rangeEnd } = input;
  const mains = new Map<string, LedgerFile>();
  for (const f of Object.values(files)) if (f.tool === 'claude' && !f.agent) mains.set(f.session, f);

  // ── Sides ──
  type Side = 'super' | 'own' | 'plain' | 'none' | 'missing';
  const side = new Map<string, Side>();
  const mode = new Map<string, string | null>();
  const prefixes = [...input.named].filter((n) => n.length >= 8);
  const named = (s: string) => input.named.has(s) || prefixes.some((n) => s.startsWith(n));
  const successorOf = new Map<string, string>();
  for (const h of input.handoffs) if (h.toSession && h.fromSession && h.toSession !== h.fromSession) successorOf.set(h.toSession, h.fromSession);
  for (const [s, f] of mains) {
    const first = f.prompts[0]?.[1];
    if (f.sends.length > 0) side.set(s, 'own');
    else if (named(s) || first === 'super') { side.set(s, 'super'); mode.set(s, normMode(input.namedMode.get(s)) ?? normMode(f.mode)); }
    else if (first === 'auto' || f.origin) side.set(s, 'none');
    else if (successorOf.has(s)) side.set(s, 'none'); // decided below, from its predecessor
    else if (f.handoffOpening) side.set(s, 'missing');
    else if (first === 'owner') { side.set(s, 'plain'); mode.set(s, normMode(f.mode)); }
    else side.set(s, 'none');
  }
  // Successors, transitively (a child's third conversation follows its first); cycles stop.
  for (const s of successorOf.keys()) {
    const seen = new Set<string>([s]);
    let root = successorOf.get(s) as string;
    while (successorOf.has(root) && !seen.has(root)) { seen.add(root); root = successorOf.get(root) as string; }
    const rootSide = side.get(root);
    const mine = mains.get(s);
    if (!mine) continue;
    if (mine.sends.length > 0) continue; // a Super's own successor stays overhead
    if (rootSide === 'super' || rootSide === 'plain') {
      side.set(s, rootSide);
      mode.set(s, mode.get(root) ?? normMode(mine.mode));
    } else if (rootSide === 'own') side.set(s, 'own');
    else side.set(s, mine.handoffOpening ? 'missing' : 'none');
  }

  // ── Per-session totals in a window ──
  const sessionAcc = (from: number, to: number): Map<string, Acc> => {
    const out = new Map<string, Acc>();
    for (const f of Object.values(files)) {
      if (f.tool !== 'claude') continue;
      const s = f.session;
      if (!mains.has(s)) continue;
      for (const row of f.rows) {
        const [hour, modelIdx, , inp, cacheRead, cacheWrite, output, , , , cacheWrite1h] = row;
        if (hour < from || hour >= to) continue;
        const a = out.get(s) ?? emptyAcc();
        out.set(s, a);
        const tokens = inp + cacheRead + cacheWrite + output;
        a.tokens += tokens; a.output += output; a.input += inp + cacheRead + cacheWrite; a.cacheRead += cacheRead;
        a.cost += input.cost(models[modelIdx] ?? '', { input: inp, cacheRead, cacheWrite, cacheWrite1h, output });
        // The MAIN file's model decides the family (a sub-agent's model is its own choice).
        if (!f.agent) a.byModel.set(modelIdx, (a.byModel.get(modelIdx) ?? 0) + tokens);
      }
    }
    return out;
  };
  const familyOf = (a: Acc): string => {
    let best = -1; let top = -1;
    for (const [m, t] of a.byModel) if (t > top) { top = t; best = m; }
    return best < 0 ? 'other' : modelFamily(models[best] ?? '');
  };
  const keyOf = (m: string | null, fam: string) => `${m ?? '?'}|${fam}`;

  const inRange = sessionAcc(rangeStart, rangeEnd);
  interface Cell { sessions: Acc[] }
  const superCells = new Map<string, Cell>();
  const plainCells = new Map<string, Cell>();
  let overheadTokens = 0;
  const sides = { super: emptyAcc(), plain: emptyAcc() };
  let unlinked = 0;
  let anySuper = false;
  for (const [s, a] of inRange) {
    const sd = side.get(s);
    if (sd === 'own') { overheadTokens += a.tokens; anySuper = true; continue; }
    if (sd === 'missing') { unlinked += 1; continue; }
    if (sd !== 'super' && sd !== 'plain') continue;
    const cells = sd === 'super' ? superCells : plainCells;
    const k = keyOf(mode.get(s) ?? null, familyOf(a));
    const c = cells.get(k) ?? { sessions: [] };
    cells.set(k, c);
    c.sessions.push(a);
    const t = sides[sd];
    t.tokens += a.tokens; t.input += a.input; t.cacheRead += a.cacheRead;
    if (sd === 'super') anySuper = true;
  }
  // A model-only stratum (mode unknown) has as its Super side the Super sessions whose mode is
  // unknown: keys already line up, since both sides key `?|family`.

  // ── Control window: under 10 plain sessions in range -> the 30 days before the first Super session.
  let firstSuper = Infinity;
  let ledgerFirst = Infinity;
  for (const [s, f] of mains) {
    if (f.first && f.first < ledgerFirst) ledgerFirst = f.first;
    const sd = side.get(s);
    if ((sd === 'super' || sd === 'own') && f.first && f.first < firstSuper) firstSuper = f.first;
  }
  let before: Map<string, Cell> | null = null;
  let beforeFrom = 0; let beforeTo = 0;
  const beforeCells = (): Map<string, Cell> => {
    if (before) return before;
    before = new Map();
    if (!Number.isFinite(firstSuper)) return before;
    beforeTo = firstSuper;
    beforeFrom = Math.max(firstSuper - 30 * DAY, Number.isFinite(ledgerFirst) ? ledgerFirst : firstSuper - 30 * DAY);
    for (const [s, a] of sessionAcc(beforeFrom, beforeTo)) {
      if (side.get(s) !== 'plain') continue;
      const k = keyOf(mode.get(s) ?? null, familyOf(a));
      const c = before.get(k) ?? { sessions: [] };
      before.set(k, c);
      c.sessions.push(a);
    }
    return before;
  };

  const sum = (xs: Acc[], f: (a: Acc) => number) => xs.reduce((n, a) => n + f(a), 0);
  const superTokensAll = sum([...superCells.values()].flatMap((c) => c.sessions), (a) => a.tokens);
  const attributed = superTokensAll > 0 && overheadTokens > 0;

  const strata: SuperStratum[] = [];
  const keys = new Set([...superCells.keys(), ...plainCells.keys()]);
  let plainShort = 0;
  let superShort = 0;
  let plainFail = false;
  let superFail = false;
  for (const k of keys) {
    const [m, fam] = k.split('|');
    const sup = superCells.get(k)?.sessions ?? [];
    let plain = plainCells.get(k)?.sessions ?? [];
    let window: SuperStratum['window'] = 'range';
    let windowFrom = rangeStart; let windowTo = rangeEnd;
    if (plain.length < MIN_SESSIONS && sup.length > 0) {
      const b = beforeCells().get(k)?.sessions ?? [];
      if (b.length >= MIN_SESSIONS) { plain = b; window = 'before'; windowFrom = beforeFrom; windowTo = beforeTo; }
    }
    if (sup.length === 0) continue; // a stratum the Super never worked in says nothing about it
    const supTokens = sum(sup, (a) => a.tokens);
    const share = attributed ? overheadTokens * (supTokens / superTokensAll) : 0;
    const supOut = sum(sup, (a) => a.output);
    const plainOut = sum(plain, (a) => a.output);
    const superRatio = supOut > 0 ? (supTokens + share) / (supOut / 1000) : null;
    const plainRatio = plainOut > 0 ? sum(plain, (a) => a.tokens) / (plainOut / 1000) : null;
    const enough = sup.length >= MIN_SESSIONS && plain.length >= MIN_SESSIONS;
    if (plain.length < MIN_SESSIONS) { plainFail = true; plainShort = Math.max(plainShort, plain.length); }
    if (sup.length < MIN_SESSIONS) { superFail = true; superShort = Math.max(superShort, sup.length); }
    const diffPct = enough && superRatio !== null && plainRatio !== null && plainRatio > 0 ? (superRatio / plainRatio - 1) * 100 : null;
    strata.push({
      mode: m === '?' ? null : m, model: fam,
      superSessions: sup.length, plainSessions: plain.length,
      superRatio, plainRatio,
      superMedian: median(sup.map((a) => a.tokens + (attributed ? share / sup.length : 0))),
      plainMedian: median(plain.map((a) => a.tokens)),
      diffPct, window, windowFrom, windowTo,
    });
  }
  strata.sort((a, b) => b.superSessions - a.superSessions || a.model.localeCompare(b.model));

  // ── Verdict, weighted by each counted stratum's Super tokens ──
  const counted = strata.filter((s) => s.diffPct !== null);
  let diff: number | null = null;
  let costDiff: number | null = null;
  let top: SuperEffect['top'] = null;
  if (counted.length) {
    let w = 0; let acc = 0; let cw = 0; let cacc = 0; let best = -1;
    for (const s of counted) {
      const k = keyOf(s.mode, s.model);
      const sup = superCells.get(k)?.sessions ?? [];
      const plain = s.window === 'before' ? (beforeCells().get(k)?.sessions ?? []) : (plainCells.get(k)?.sessions ?? []);
      const weight = sum(sup, (a) => a.tokens);
      w += weight; acc += weight * (s.diffPct as number);
      if (Math.abs(weight * (s.diffPct as number)) > best) { best = Math.abs(weight * (s.diffPct as number)); top = { mode: s.mode, model: s.model }; }
      const supCost = sum(sup, (a) => a.cost) / sup.length;
      const plainCost = sum(plain, (a) => a.cost) / plain.length;
      cw += sup.length; cacc += sup.length * (supCost - plainCost);
    }
    diff = w > 0 ? acc / w : null;
    costDiff = cw > 0 ? cacc / cw : null;
  }
  let verdict: SuperVerdict;
  if (!anySuper) verdict = 'noSuper';
  else if (diff === null) verdict = 'unknown';
  else if (Math.abs(diff) < SAME_UNDER_PCT) verdict = 'same';
  else verdict = diff < 0 ? 'reduces' : 'increases';

  // The side to name when nothing could be counted: only the Super's own sessions (no child
  // stratum at all), else the Super side when it is short (the first days), else the plain side.
  const short: SuperShortSide | null = verdict !== 'unknown' ? null
    : strata.length === 0 ? 'ownOnly' : superFail ? 'super' : plainFail ? 'plain' : null;
  const share = (a: Acc): number | null => (a.input > 0 ? a.cacheRead / a.input : null);
  return {
    verdict, diffPct: diff, measure: 'tokensPerOutput', strata,
    overhead: { tokens: overheadTokens, attributed },
    totals: { super: sides.super.tokens, plain: sides.plain.tokens },
    cacheShare: { super: share(sides.super), plain: share(sides.plain) },
    costDiff, top,
    missing: { strata: strata.length - counted.length, unlinkedSuccessors: unlinked, plainShort, superShort, short },
  };
}
