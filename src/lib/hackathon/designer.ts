/**
 * The hackathon design (plan C2): what a run is, validated field by field, and the stats-backed
 * proposal `hackathon design` prints. No model call here: the chat agent fills personas and
 * adjusts; every proposed line carries a reason citing a stats row and its run count.
 */
import { readToolsOf } from '../agents/read-tools.js';
import { TEAM_ID_RE } from './run-store.js';
import type { Stats, StatsRow } from './stats.js';

export type HackathonKind = 'screen' | 'experiment' | 'plan';
export const KINDS: readonly HackathonKind[] = ['screen', 'experiment', 'plan'];
export type TeamTool = 'claude' | 'codex';
export type InnerLayout = 'trio' | 'solo';

export interface TeamDesign {
  id: string;
  name: string;
  persona: string;
  tool: TeamTool;
  model: string;
  inner: InnerLayout;
}

export interface LimitDesign {
  /** ISO end time: no new round past it. */
  endsAt: string;
  /** Weekly account share the run may use, in percent points (owner pick: 15). */
  weeklyShareCeiling: number;
  /** The 5-hour window percent at which teams pause (default 80). */
  sessionGuard: number;
}

export interface PeekDesign { neighbours: 2; questions: 1; borrow: 1; gate: number }

export interface Design {
  kind: HackathonKind;
  problem: string;
  /** The repo every team clones (absolute). */
  target: string;
  teams: TeamDesign[];
  rounds: number;
  roundMinutes: number;
  peek: PeekDesign;
  /** The team that never peeks (4+ teams), always a Claude team. */
  controlTeam: string | null;
  experiment: { variable: string; team: string } | null;
  limit: LimitDesign;
  /** Literal `mcp__server__tool` read tools teams may call (Claude teams). */
  mcpTools: string[];
  /** The one base commit every clone starts at; set by `POST …/start`. */
  baseSha?: string;
}

export const DEFAULT_PEEK: PeekDesign = { neighbours: 2, questions: 1, borrow: 1, gate: 0.6 };
export const DEFAULT_WEEKLY_SHARE = 15;
export const DEFAULT_SESSION_GUARD = 80;
export const MIN_TEAMS = 2;
export const MAX_TEAMS = 6;
export const MAX_ROUNDS = 6;
export const MIN_ROUND_MINUTES = 10;
export const MAX_ROUND_MINUTES = 240;
export const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export interface DesignEnv {
  /** Codex is installed and every server it lists can be switched off. */
  codexUsable: boolean;
  /** Why it is not, for the note. */
  codexWhy?: string;
}

export interface Validated { design: Design; notes: string[] }

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' ? Math.round(v) : typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * Every field checked; what cannot run is changed with a note, what is malformed throws.
 * Codex missing or its servers not switchable → claude; the control team forced to a Claude team;
 * an `mcpTools` entry that is not one literal read tool (a mutating name) dropped.
 */
export function validateDesign(raw: unknown, env: DesignEnv, now: Date = new Date()): Validated {
  if (!raw || typeof raw !== 'object') throw new Error('design must be a JSON object');
  const o = raw as Record<string, unknown>;
  const notes: string[] = [];
  const kind = o.kind as HackathonKind;
  if (!KINDS.includes(kind)) throw new Error(`design.kind must be one of ${KINDS.join(', ')}`);
  const problem = str(o.problem, 500);
  if (!problem) throw new Error('design.problem is empty');
  const target = str(o.target, 1000);
  if (!target.startsWith('/')) throw new Error('design.target must be an absolute repo path');
  if (!Array.isArray(o.teams)) throw new Error('design.teams must be a list');
  if (o.teams.length < MIN_TEAMS || o.teams.length > MAX_TEAMS) throw new Error(`a hackathon has ${MIN_TEAMS} to ${MAX_TEAMS} teams`);
  const seen = new Set<string>();
  const teams: TeamDesign[] = o.teams.map((t, i) => {
    const r = (t ?? {}) as Record<string, unknown>;
    const id = str(r.id, 24);
    if (!TEAM_ID_RE.test(id)) throw new Error(`team ${i + 1}: id must match ${TEAM_ID_RE}`);
    if (seen.has(id)) throw new Error(`team id ${id} twice`);
    seen.add(id);
    let tool: TeamTool = r.tool === 'codex' ? 'codex' : 'claude';
    if (r.tool !== 'claude' && r.tool !== 'codex') notes.push(`${id}: araç ${JSON.stringify(r.tool)} desteklenmiyor, Claude kullanılır`);
    let model = str(r.model, 60) || (tool === 'claude' ? 'opus' : '');
    if (tool === 'codex' && !env.codexUsable) {
      notes.push(`${id}: Codex kullanılamıyor (${env.codexWhy ?? 'kurulu değil'}), Claude kullanılır`);
      tool = 'claude';
      model = 'opus';
    }
    if (tool === 'claude' && !/^[a-z0-9.\-[\]]{1,60}$/i.test(model)) throw new Error(`${id}: model ${JSON.stringify(model)} is not a model name`);
    const inner: InnerLayout = r.inner === 'solo' ? 'solo' : 'trio';
    return { id, name: str(r.name, 40) || id, persona: str(r.persona, 600), tool, model, inner };
  });
  const rounds = int(o.rounds, 1, MAX_ROUNDS, 3);
  const roundMinutes = int(o.roundMinutes, MIN_ROUND_MINUTES, MAX_ROUND_MINUTES, 60);
  const pk = (o.peek ?? {}) as Record<string, unknown>;
  const gate = typeof pk.gate === 'number' && pk.gate > 0 && pk.gate < 1 ? pk.gate : DEFAULT_PEEK.gate;
  const peek: PeekDesign = { ...DEFAULT_PEEK, gate };
  let controlTeam = typeof o.controlTeam === 'string' && seen.has(o.controlTeam) ? o.controlTeam : null;
  if (teams.length < 4 && controlTeam) {
    notes.push('kontrol ekibi 4+ ekipte olur; kaldırıldı');
    controlTeam = null;
  }
  if (controlTeam) {
    const ct = teams.find((t) => t.id === controlTeam)!;
    if (ct.tool !== 'claude') {
      const alt = teams.find((t) => t.tool === 'claude');
      notes.push(alt ? `kontrol ekibi Claude olmalı (Codex okumayı kısıtlayamaz): ${alt.id} kontrol oldu` : 'Claude ekibi yok: kontrol ekibi kaldırıldı');
      controlTeam = alt?.id ?? null;
    }
  }
  let experiment: Design['experiment'] = null;
  if (o.experiment && typeof o.experiment === 'object') {
    const e = o.experiment as Record<string, unknown>;
    if (typeof e.team === 'string' && seen.has(e.team) && typeof e.variable === 'string') {
      experiment = { variable: str(e.variable, 40), team: e.team };
    }
  }
  const lim = (o.limit ?? {}) as Record<string, unknown>;
  const endsAtRaw = str(lim.endsAt, 40);
  const endsAt = endsAtRaw && !Number.isNaN(Date.parse(endsAtRaw))
    ? new Date(endsAtRaw).toISOString()
    : new Date(now.getTime() + (rounds * roundMinutes + 30) * 60_000).toISOString();
  const limit: LimitDesign = {
    endsAt,
    weeklyShareCeiling: int(lim.weeklyShareCeiling, 1, 100, DEFAULT_WEEKLY_SHARE),
    sessionGuard: int(lim.sessionGuard, 10, 100, DEFAULT_SESSION_GUARD),
  };
  const rawTools = Array.isArray(o.mcpTools) ? o.mcpTools : [];
  const mcpTools = readToolsOf(rawTools);
  for (const t of rawTools) if (typeof t === 'string' && !mcpTools.includes(t.trim())) notes.push(`MCP aracı ${t} açılmadı (tek, yalnız okuyan bir araç adı değil)`);
  const design: Design = { kind, problem, target, teams, rounds, roundMinutes, peek, controlTeam, experiment, limit, mcpTools };
  if (typeof o.baseSha === 'string' && /^[0-9a-f]{40}$/.test(o.baseSha)) design.baseSha = o.baseSha;
  return { design, notes };
}

/** The Codex teams of a design: they can read the whole disk (no read denies). */
export function wholeDiskTeams(d: Design): string[] {
  return d.teams.filter((t) => t.tool === 'codex').map((t) => t.id);
}

// ─── The proposal ───────────────────────────────────────────────────────────

export interface Reason { field: string; text: string; row?: string; n?: number }
export interface Proposal { design: Design; reasons: Reason[] }

const FEW = 3;

function cite(row: StatsRow | undefined, what: string, fallback: string): Omit<Reason, 'field'> {
  if (!row) return { text: `${fallback} (geçmiş koşu yok, az veri)`, n: 0 };
  return {
    text: `${what}: ${row.label} ${Math.round(row.winShare * 100)}% kazandı (n=${row.n})${row.n < FEW ? ', az veri' : ''}`,
    row: row.key,
    n: row.n,
  };
}

const best = (rows: readonly StatsRow[]): StatsRow | undefined =>
  [...rows].sort((a, b) => b.winShare - a.winShare || b.n - a.n)[0];

/**
 * Defaults from the stats (no model call). Personas are placeholders the chat agent fills; the
 * one experiment variable is the design field with the smallest n.
 */
export function proposeDesign(input: { problem: string; kind: HackathonKind; target: string; stats: Stats; env: DesignEnv; now?: Date }): Proposal {
  const { stats, env } = input;
  const now = input.now ?? new Date();
  const reasons: Reason[] = [];
  const countRow = best(stats.byTeamCount);
  const teamCount = countRow ? Math.min(MAX_TEAMS, Math.max(MIN_TEAMS, parseInt(countRow.label, 10) || 3)) : 3;
  reasons.push({ field: 'teams', ...cite(countRow, 'ekip sayısı', `${teamCount} ekip, varsayılan`) });
  const innerRow = best(stats.byInner);
  const inner: InnerLayout = innerRow?.label === 'solo' ? 'solo' : 'trio';
  reasons.push({ field: 'inner', ...cite(innerRow, 'iç düzen', 'Kaptan + Yapıcı + Eleştirmen, varsayılan') });
  const toolRow = best(stats.byTool);
  reasons.push({ field: 'tool', ...cite(toolRow, 'araç', env.codexUsable ? 'Claude ve Codex karışık' : 'yalnız Claude (Codex yok)') });
  const personas = ['Kanıtçı', 'Cesur', 'Sade', 'Titiz', 'Hızlı', 'Kullanıcıcı'];
  const teams: TeamDesign[] = Array.from({ length: teamCount }, (_, i) => {
    const codex = env.codexUsable && i === 0 && toolRow?.label !== 'claude';
    return {
      id: `ekip-${i + 1}`,
      name: personas[i] ?? `Ekip ${i + 1}`,
      persona: '',
      tool: codex ? 'codex' : 'claude',
      model: codex ? '' : 'opus',
      inner,
    };
  });
  const controlTeam = teamCount >= 4 ? teams.filter((t) => t.tool === 'claude').pop()?.id ?? null : null;
  if (controlTeam) {
    const r = stats.peekVsControl;
    reasons.push({ field: 'controlTeam', text: r ? `göz atanlar kontrole göre ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)} puan (n=${r.n})${r.n < FEW ? ', az veri' : ''}` : 'kontrol ekibi göz atmaz; fark ölçülür (az veri)', n: r?.n ?? 0 });
  }
  const rounds = input.kind === 'plan' ? 2 : 3;
  const roundMinutes = input.kind === 'plan' ? 30 : 60;
  reasons.push({ field: 'rounds', text: `${rounds} tur × ${roundMinutes} dk (${input.kind} için varsayılan)` });
  const smallest = [
    { variable: 'inner', n: innerRow?.n ?? 0 },
    { variable: 'tool', n: toolRow?.n ?? 0 },
    { variable: 'teamCount', n: countRow?.n ?? 0 },
  ].sort((a, b) => a.n - b.n)[0]!;
  const expTeam = teams.find((t) => t.id !== controlTeam) ?? teams[0]!;
  if (smallest.variable === 'inner') expTeam.inner = inner === 'trio' ? 'solo' : 'trio';
  reasons.push({ field: 'experiment', text: `bu koşu tek değişkeni dener: ${smallest.variable} (en az veri, n=${smallest.n}) ${expTeam.id} ekibinde`, n: smallest.n });
  const endsAt = new Date(now.getTime() + (rounds * roundMinutes + 30) * 60_000).toISOString();
  reasons.push({ field: 'limit', text: `en çok haftalık payın %${DEFAULT_WEEKLY_SHARE}'i; 5 saatlik pencere %${DEFAULT_SESSION_GUARD}'de bekler` });
  const design: Design = {
    kind: input.kind,
    problem: input.problem.trim().slice(0, 500),
    target: input.target,
    teams,
    rounds,
    roundMinutes,
    peek: { ...DEFAULT_PEEK },
    controlTeam,
    experiment: { variable: smallest.variable, team: expTeam.id },
    limit: { endsAt, weeklyShareCeiling: DEFAULT_WEEKLY_SHARE, sessionGuard: DEFAULT_SESSION_GUARD },
    mcpTools: [],
  };
  return { design, reasons };
}
