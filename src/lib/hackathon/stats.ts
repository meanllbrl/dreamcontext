/**
 * What past hackathons taught, DERIVED from every `result.json` and nothing else (plan C2,
 * pattern a-record-kept-by-habit-goes-stale). A win is the owner's pick; every row carries its n.
 */
import { readdirSync } from 'node:fs';
import type { HackathonKind, InnerLayout, TeamTool } from './designer.js';
import { RUN_ID_RE, hackathonDir, readJson, resultPath } from './run-store.js';

export interface TeamResult {
  id: string;
  tool: TeamTool;
  model: string;
  inner: InnerLayout;
  persona: string;
  control: boolean;
  juryScore: number | null;
  criteria?: Record<string, number>;
  originality?: number | null;
  similarity?: number | null;
  borrowed: boolean;
  firstOutputMinute: number | null;
  /** Weekly share points used by this team (estimate: run share / teams). */
  usageShare: number | null;
  /** Hours the team ran. */
  hours: number | null;
  readIsolated: boolean;
}

export interface ResultRecord {
  version: 1;
  run: string;
  kind: HackathonKind;
  designHash: string;
  design: unknown;
  teams: TeamResult[];
  /** The owner's pick, or null when stopped without one. */
  pick: string | null;
  juryRanking: string[];
  /** The jury's first place equals the owner's pick. */
  juryOwnerAgree: boolean | null;
  /** Mean jury score of peekers minus the control team's. */
  controlDelta: number | null;
  sameVendorJury?: boolean;
  pr: 'merged' | 'closed' | 'none';
  writtenAt: string;
  stoppedReason?: string;
}

export interface StatsRow { key: string; label: string; n: number; wins: number; winShare: number }

export interface Stats {
  runs: number;
  byInner: StatsRow[];
  byTool: StatsRow[];
  byPersona: StatsRow[];
  byTeamCount: StatsRow[];
  peekVsControl: { delta: number; n: number } | null;
  /** Weekly share points per team-hour, by tool. */
  usagePerTeamHour: { tool: TeamTool; perHour: number; n: number }[];
}

export function readResults(contextRoot: string): ResultRecord[] {
  let names: string[];
  try { names = readdirSync(hackathonDir(contextRoot)); } catch { return []; }
  return names.filter((n) => RUN_ID_RE.test(n))
    .map((n) => readJson<ResultRecord>(resultPath(contextRoot, n)))
    .filter((r): r is ResultRecord => !!r && r.version === 1 && Array.isArray(r.teams));
}

/** The first word of a persona, lowercased: "Cesur, riskli fikirler" → "cesur". */
export function personaStyle(persona: string, name = ''): string {
  return ((persona || name).toLowerCase().match(/[a-zçğıöşü0-9]+/)?.[0]) ?? 'yok';
}

function rows(entries: { key: string; label: string; won: boolean }[]): StatsRow[] {
  const by = new Map<string, StatsRow>();
  for (const e of entries) {
    const r = by.get(e.key) ?? { key: e.key, label: e.label, n: 0, wins: 0, winShare: 0 };
    r.n += 1;
    if (e.won) r.wins += 1;
    by.set(e.key, r);
  }
  return [...by.values()].map((r) => ({ ...r, winShare: r.n ? r.wins / r.n : 0 })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

export function computeStats(results: readonly ResultRecord[], kind?: HackathonKind): Stats {
  const rs = results.filter((r) => !kind || r.kind === kind);
  const picked = rs.filter((r) => r.pick);
  const team = (r: ResultRecord) => r.teams.map((t) => ({ t, won: t.id === r.pick }));
  const all = picked.flatMap(team);
  const deltas = rs.map((r) => r.controlDelta).filter((d): d is number => typeof d === 'number');
  const usage = new Map<TeamTool, { sum: number; n: number }>();
  for (const r of rs) for (const t of r.teams) {
    if (t.usageShare == null || !t.hours) continue;
    const u = usage.get(t.tool) ?? { sum: 0, n: 0 };
    u.sum += t.usageShare / t.hours;
    u.n += 1;
    usage.set(t.tool, u);
  }
  return {
    runs: rs.length,
    byInner: rows(all.map(({ t, won }) => ({ key: `inner:${t.inner}`, label: t.inner, won }))),
    byTool: rows(all.map(({ t, won }) => ({ key: `tool:${t.tool}`, label: t.tool, won }))),
    byPersona: rows(all.map(({ t, won }) => { const s = personaStyle(t.persona); return { key: `persona:${s}`, label: s, won }; })),
    // One entry per run: did the run with this team count end in a pick (its n is runs, not teams).
    byTeamCount: rows(picked.map((r) => ({ key: `teams:${r.teams.length}`, label: String(r.teams.length), won: true })))
      .map((row) => ({ ...row, winShare: row.n / Math.max(1, picked.length) })),
    peekVsControl: deltas.length ? { delta: deltas.reduce((a, b) => a + b, 0) / deltas.length, n: deltas.length } : null,
    usagePerTeamHour: [...usage.entries()].map(([tool, u]) => ({ tool, perHour: u.sum / u.n, n: u.n })),
  };
}

export function formatStats(s: Stats): string {
  const lines = [`Hackathon istatistikleri: ${s.runs} koşu`];
  const block = (title: string, rs: StatsRow[]) => {
    lines.push(`${title}:`);
    if (!rs.length) lines.push('  (veri yok)');
    for (const r of rs) lines.push(`  ${r.label.padEnd(10)} ${Math.round(r.winShare * 100)}% kazanç  n=${r.n}${r.n < 3 ? '  az veri' : ''}`);
  };
  block('İç düzen', s.byInner);
  block('Araç', s.byTool);
  block('Persona', s.byPersona);
  block('Ekip sayısı', s.byTeamCount);
  lines.push(s.peekVsControl ? `Göz atma - kontrol farkı: ${s.peekVsControl.delta.toFixed(1)} (n=${s.peekVsControl.n})` : 'Göz atma - kontrol farkı: veri yok');
  for (const u of s.usagePerTeamHour) lines.push(`Ekip-saat başına haftalık pay (${u.tool}): ${u.perHour.toFixed(2)} puan (n=${u.n})`);
  return lines.join('\n');
}
