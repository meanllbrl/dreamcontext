/**
 * The blind jury (plan Decision 11, criterion 10): every pair in both orders, presentations
 * fenced as data, no tools. No judge of a team's vendor when another vendor is installed; with
 * Claude only, a different Claude model judges and the result says "aynı firma". Originality
 * weighs 15%. The jury recommends; the owner picks.
 */
import type { Design, TeamTool } from './designer.js';
import { closedCallArgv, firstJson, type ModelCall } from './similarity.js';
import { fenceAsData } from './team-files.js';

export const ORIGINALITY_WEIGHT = 0.15;
export const CRITERIA = ['sorunu çözüyor', 'kanıt', 'uygulanabilirlik', 'özgünlük'] as const;

export interface Judge { tool: TeamTool; model: string }

/** The judge for a pair of teams. */
export function pickJudge(teamTools: readonly TeamTool[], teamModels: readonly string[], installed: { codex: boolean }): { judge: Judge; sameVendor: boolean } {
  const vendors = new Set(teamTools);
  if (!vendors.has('codex') && installed.codex) return { judge: { tool: 'codex', model: '' }, sameVendor: false };
  if (!vendors.has('claude')) return { judge: { tool: 'claude', model: 'opus' }, sameVendor: false };
  // Both vendors play, or only Claude is installed: a Claude model no team of the pair used.
  const used = new Set(teamModels.map((m) => m.toLowerCase()));
  const model = ['sonnet', 'opus', 'haiku'].find((m) => !used.has(m)) ?? 'sonnet';
  return { judge: { tool: 'claude', model }, sameVendor: true };
}

export function juryPrompt(first: string, second: string, problem: string): string {
  return [
    `Hackathon problem: ${problem.replace(/[<>]/g, '')}`,
    'Two anonymous teams presented. Judge which better answers the problem. Score each 0-10 on: solves the problem, evidence, feasibility, originality.',
    'Answer with one JSON object only: {"winner": "A"|"B", "A": {"solves":n,"evidence":n,"feasible":n,"original":n}, "B": {...}, "why": "one sentence"}.',
    fenceAsData('sunum A', first),
    fenceAsData('sunum B', second),
  ].join('\n\n');
}

export interface PairVerdict { a: string; b: string; order: 'ab' | 'ba'; winner: string | null; scores: Record<string, { solves: number; evidence: number; feasible: number; original: number }>; judge: Judge; why: string }

const n10 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 0);

/** One weighted score: the three main criteria share 85%, originality 15%. */
export function weighted(s: { solves: number; evidence: number; feasible: number; original: number }): number {
  return ((s.solves + s.evidence + s.feasible) / 3) * (1 - ORIGINALITY_WEIGHT) + s.original * ORIGINALITY_WEIGHT;
}

export interface JuryResult {
  verdicts: PairVerdict[];
  /** Mean weighted score per team. */
  scores: Record<string, number>;
  originality: Record<string, number>;
  ranking: string[];
  sameVendor: boolean;
  judges: Judge[];
}

/** Every pair in both orders. `texts` = each team's presentation text (validated manifest + thesis). */
export async function runJury(design: Pick<Design, 'teams' | 'problem'>, texts: Record<string, string>, call: ModelCall, installed: { codex: boolean }): Promise<JuryResult> {
  const ids = design.teams.map((t) => t.id).filter((id) => texts[id]);
  const verdicts: PairVerdict[] = [];
  let sameVendor = false;
  const judges: Judge[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!; const b = ids[j]!;
      const ta = design.teams.find((t) => t.id === a)!; const tb = design.teams.find((t) => t.id === b)!;
      const { judge, sameVendor: sv } = pickJudge([ta.tool, tb.tool], [ta.model, tb.model], installed);
      sameVendor ||= sv;
      judges.push(judge);
      for (const order of ['ab', 'ba'] as const) {
        const [x, y] = order === 'ab' ? [a, b] : [b, a];
        let parsed: Record<string, unknown> | null = null;
        try { parsed = firstJson(await call(judge.model, juryPrompt(texts[x]!, texts[y]!, design.problem), judge.tool)); } catch { /* counted as no verdict */ }
        const sc = (k: 'A' | 'B') => {
          const o = (parsed?.[k] ?? {}) as Record<string, unknown>;
          return { solves: n10(o.solves), evidence: n10(o.evidence), feasible: n10(o.feasible), original: n10(o.original) };
        };
        const w = parsed?.winner === 'A' ? x : parsed?.winner === 'B' ? y : null;
        verdicts.push({ a, b, order, winner: w, scores: parsed ? { [x]: sc('A'), [y]: sc('B') } : {}, judge, why: String(parsed?.why ?? '').slice(0, 200) });
      }
    }
  }
  const sums: Record<string, { w: number; o: number; n: number; wins: number }> = {};
  for (const id of ids) sums[id] = { w: 0, o: 0, n: 0, wins: 0 };
  for (const v of verdicts) {
    for (const [id, s] of Object.entries(v.scores)) { sums[id]!.w += weighted(s); sums[id]!.o += s.original; sums[id]!.n += 1; }
    if (v.winner) sums[v.winner]!.wins += 1;
  }
  const scores = Object.fromEntries(ids.map((id) => [id, sums[id]!.n ? sums[id]!.w / sums[id]!.n : 0]));
  const originality = Object.fromEntries(ids.map((id) => [id, sums[id]!.n ? sums[id]!.o / sums[id]!.n : 0]));
  const ranking = [...ids].sort((p, q) => sums[q]!.wins - sums[p]!.wins || scores[q]! - scores[p]!);
  return { verdicts, scores, originality, ranking, sameVendor, judges };
}

/** For the test that every judge call is closed. */
export const juryArgv = closedCallArgv;
