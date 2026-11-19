import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../context/VaultContext';

/**
 * The Hackathon screens' reads (plan C5). Every shape here is what `src/server/routes/hackathon.ts`
 * sends; strings arrive redacted and cut. Live views poll every 5 s while they are on screen.
 */
export type RunState = 'draft' | 'awaiting-owner' | 'running' | 'presenting' | 'judging' | 'picked' | 'stopped';
export type TeamTool = 'claude' | 'codex';
export type MemberRole = 'kaptan' | 'yapici' | 'elestirmen';

export interface RunListRow { id: string; state: RunState; problem: string; teams: number; createdAt: string; kind: string }

export interface Strip {
  endsAt: string;
  reading: string;
  used: number | null;
  ceiling: number;
  reason: string | null;
  moments: { at: string; text: string }[];
}

export interface RunTeam { id: string; name: string; persona: string; tool: TeamTool; model: string; inner: 'trio' | 'solo' }

export interface RunView {
  id: string; state: RunState; phase: string | null; round: number | null; problem: string; kind: string;
  rounds: number; roundMinutes: number; controlTeam: string | null; teams: RunTeam[];
  paused: string | null; stopReason: string | null; strip: Strip;
  /** `gone`: the run needs a conductor and none is alive (the page offers Sürdür). */
  conductor?: 'alive' | 'starting' | 'gone' | null;
}

export interface DesignView {
  run: string; state: RunState; designHash: string; problem: string; kind: string;
  teams: { id: string; name: string; persona?: string; tool: TeamTool; model: string; inner: 'trio' | 'solo'; readIsolated: boolean; wholeDisk: boolean; control: boolean }[];
  mcpTools: string[]; mcpServers: string[]; rounds: number; roundMinutes: number; endsAt: string;
  limit: { weeklyShareCeiling: number; sessionGuard: number };
  target: string;
  experiment: { variable: string; team: string } | null;
}

export interface Screen { role: MemberRole; kind: 'edit' | 'read' | 'bash' | 'browser' | 'note'; path?: string; lines?: string[]; command?: string; resultLine?: string; screenshot?: string }
export interface Frame { team: string; members: { role: MemberRole; state: 'working' | 'asking' | 'idle' }[]; screen: Screen | null; updatedAt: string | null; edited: string[]; reads: number; ended: boolean }
export interface FramesView { run: string; state: RunState; round: number | null; frames: Frame[]; strip: Strip }

export interface ThesisCard { thesis: string; claims: [string, string, string]; status: string; stuck?: string }
export interface RoundRecord {
  round: number; at: string; cards: Record<string, ThesisCard | null>; seen: Record<string, string[]>;
  questions: { from: string; to: string; text: string }[]; pairs: { a: string; b: string; score: number }[]; gate: number;
}

export interface FilesView {
  team: string; edited: string[]; reads: number;
  decisions: { at: string; role: MemberRole; kind: 'plan' | 'objection' | 'decision'; text: string; borrowed?: true }[];
  dropped: string[];
  preview: { path: string; lines: string[]; truncated: boolean } | { path: string; reason: string } | null;
}

export interface PresentationCard { kind: 'thesis' | 'screen' | 'video' | 'pdf' | 'image' | 'data'; title: string; media?: string; reason?: string; thesis?: ThesisCard }
export interface PresentationView {
  team: string; cards: PresentationCard[]; thesis: ThesisCard | null;
  borrowed: { from: 'left' | 'right'; round: number; idea: string }[];
  flags: string[]; screens: { width: number; media: string }[]; reason?: string; decisions: number;
}

export interface CriteriaScores { solves: number; evidence: number; feasible: number; original: number }
export interface Judge { tool: TeamTool; model: string }
export interface JuryView {
  scores: Record<string, number>; originality: Record<string, number>; ranking: string[]; sameVendor: boolean;
  verdicts: { a: string; b: string; order: 'ab' | 'ba'; winner: string | null; why: string; scores?: Record<string, CriteriaScores>; judge?: Judge }[];
  judges?: Judge[];
}
export interface ResultView { run: string; state: RunState; jury: JuryView | null; result: { pick: string | null; pr: string; stoppedReason?: string } | null }

export interface PrCheck {
  branch: string; secretHits: { path: string; line: number; kind: 'pattern' | 'known' | 'key-file' }[];
  elsewhere: { path: string; hunks: string }[]; confirmHash: string; diffstat: string; codexWinner: boolean;
}

const enc = encodeURIComponent;
const LIVE_MS = 5_000;

export function useRuns() {
  const api = useApi();
  return useQuery({ queryKey: ['hackathon', 'runs'], queryFn: () => api.get<{ runs: RunListRow[] }>('/hackathon'), refetchInterval: LIVE_MS });
}

export function useRun(id: string | null) {
  const api = useApi();
  return useQuery({ queryKey: ['hackathon', 'run', id], queryFn: () => api.get<RunView>(`/hackathon/${enc(id!)}`), enabled: !!id, refetchInterval: LIVE_MS });
}

export function useDesign(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['hackathon', 'design', id], queryFn: () => api.get<DesignView>(`/hackathon/${enc(id)}/design`),
    // An old card in chat history stops polling once its run has left the start.
    refetchInterval: (q) => (q.state.data && q.state.data.state !== 'awaiting-owner' && q.state.data.state !== 'draft' ? false : LIVE_MS),
  });
}

export function useFrames(id: string, live: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['hackathon', 'frames', id], queryFn: () => api.get<FramesView>(`/hackathon/${enc(id)}/frames`), refetchInterval: live ? LIVE_MS : false });
}

export function useRounds(id: string, live: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['hackathon', 'rounds', id], queryFn: () => api.get<{ rounds: RoundRecord[] }>(`/hackathon/${enc(id)}/rounds`), refetchInterval: live ? LIVE_MS * 3 : false });
}

export function useFiles(id: string, team: string, preview: string | null) {
  const api = useApi();
  const q = preview ? `?preview=${enc(preview)}` : '';
  return useQuery({ queryKey: ['hackathon', 'files', id, team, preview], queryFn: () => api.get<FilesView>(`/hackathon/${enc(id)}/teams/${enc(team)}/files${q}`), refetchInterval: LIVE_MS });
}

export function usePresentation(id: string, team: string) {
  const api = useApi();
  return useQuery({ queryKey: ['hackathon', 'presentation', id, team], queryFn: () => api.get<PresentationView>(`/hackathon/${enc(id)}/teams/${enc(team)}/presentation`) });
}

export function useResult(id: string, live: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['hackathon', 'result', id], queryFn: () => api.get<ResultView>(`/hackathon/${enc(id)}/result`), refetchInterval: live ? LIVE_MS : false });
}

export function usePrCheck(id: string, enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['hackathon', 'pr-check', id], queryFn: () => api.get<{ pick: string; check: PrCheck | null; reason: string | null }>(`/hackathon/${enc(id)}/pr-check`), enabled });
}

/** A media URL the page may draw (the route checks the bytes by magic and sends no-script CSP). */
export function mediaUrl(vault: string | null, run: string, team: string, m: string): string {
  const v = vault ? `&vault=${enc(vault)}` : '';
  return `/api/hackathon/${enc(run)}/teams/${enc(team)}/media?m=${enc(m)}${v}`;
}

/** `{name}` placeholders in a translated line. */
export function fill(line: string, vars: Record<string, string | number>): string {
  return line.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** "16:30" from an ISO time, in the owner's clock. */
export function clock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "16:30" today, "19 Nov 16:30" on another day: an end time is never read as today's by mistake. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? clock(iso) : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock(iso)}`;
}

/** A 0..1 share as a percent in the owner's language: "%42" in Turkish, "42%" elsewhere. */
export function pct(share: number, locale: string): string {
  const n = Math.round(share * 100);
  return locale.startsWith('tr') ? `%${n}` : `${n}%`;
}

/** Minutes left until `iso` (never negative). */
export function minutesLeft(iso: string, now = Date.now()): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : Math.max(0, Math.round((t - now) / 60_000));
}

/** A team's one-letter badge: its name's first letter (the mockups' K, C, S). */
export function badge(name: string): string {
  return (name.trim()[0] ?? '?').toLocaleUpperCase('tr');
}

// ─── Design B helpers: team identity, Turkish suffixes, scores ─────────────

/** Team identity colours (`--hk-team-1..6`): never the accent, green, orange or red. Stable by design order. */
export const TEAM_HUES = 5;
export function teamHue(teams: readonly { id: string }[], id: string): number {
  const i = teams.findIndex((x) => x.id === id);
  return (i < 0 ? 0 : i % TEAM_HUES) + 1;
}

const BACK = new Set(['a', 'ı', 'o', 'u', 'â']);
const FRONT_ROUND = new Set(['ö', 'ü']);
const VOWELS = 'aeıioöuüâîû';
function lastVowel(word: string): string | null {
  const w = word.toLocaleLowerCase('tr');
  for (let i = w.length - 1; i >= 0; i--) if (VOWELS.includes(w[i]!)) return w[i]!;
  return null;
}
/** A proper name in the Turkish accusative: "Kanıtçı'yı", "Sade'yi", "Kontrol'ü". */
const PALATAL_L = /(?:^|\s)(kontrol|protokol|rol|gol|alkol|sembol|futbol|petrol|idol|hal|ideal|normal|lokal|global|final|sinyal|moral|total)$/;

export function accusative(name: string): string {
  const n = name.trim();
  if (PALATAL_L.test(n.toLocaleLowerCase('tr'))) return `${n}'${/[ou]l$/i.test(n) ? 'ü' : 'i'}`;
  const v = lastVowel(n);
  if (!v) return `${n}'ı`;
  const h = BACK.has(v) ? (v === 'o' || v === 'u' ? 'u' : 'ı') : FRONT_ROUND.has(v) ? 'ü' : 'i';
  const endsVowel = VOWELS.includes(n.toLocaleLowerCase('tr').slice(-1));
  return `${n}'${endsVowel ? 'y' : ''}${h}`;
}

/** "2'sini", "1'ini", "3'ünü": a count's "of them" suffix, as Turkish reads the digits aloud. */
export function countOf(n: number): string {
  const units: Record<number, string> = { 0: 'ını', 1: 'ini', 2: 'sini', 3: 'ünü', 4: 'ünü', 5: 'ini', 6: 'sını', 7: 'sini', 8: 'ini', 9: 'unu' };
  const tens: Record<number, string> = { 1: 'unu', 2: 'sini', 3: 'unu', 4: 'ını', 5: 'sini', 6: 'ını', 7: 'ini', 8: 'ini', 9: 'ını' };
  if (n === 0) return "0'ını";
  const suffix = n % 10 ? units[n % 10]! : (n % 100) ? tens[(n % 100) / 10]! : (n % 1000) ? 'ünü' : 'ini';
  return `${n}'${suffix}`;
}

/** A score in the owner's language: "6,8" in Turkish, "6.8" elsewhere; whole numbers without decimals. */
export function num(n: number, locale: string): string {
  const r = Math.round(n * 10) / 10;
  return r.toLocaleString(locale.startsWith('tr') ? 'tr-TR' : 'en-US', { maximumFractionDigits: 1 });
}

/** A team's four criteria: the mean of every verdict's scores for it (null when no judge scored it). */
export function criteria(jury: JuryView | null | undefined, team: string): CriteriaScores | null {
  const rows = (jury?.verdicts ?? []).map((v) => v.scores?.[team]).filter((x): x is CriteriaScores => !!x);
  if (!rows.length) return null;
  const mean = (k: keyof CriteriaScores) => rows.reduce((a, r) => a + (Number.isFinite(r[k]) ? r[k] : 0), 0) / rows.length;
  return { solves: mean('solves'), evidence: mean('evidence'), feasible: mean('feasible'), original: mean('original') };
}

/** Pairwise matches a team won, out of those it played (both orders count). */
export function wins(jury: JuryView, team: string): { won: number; of: number } {
  const mine = jury.verdicts.filter((v) => v.a === team || v.b === team);
  return { won: mine.filter((v) => v.winner === team).length, of: mine.length };
}

/** The jury's one-sentence reason for a team: a verdict it won, else any it played. */
export function juryWhy(jury: JuryView | null | undefined, team: string): { why: string; judge: Judge | null } | null {
  const mine = (jury?.verdicts ?? []).filter((v) => (v.a === team || v.b === team) && v.why);
  const v = mine.find((x) => x.winner === team) ?? mine[0];
  return v ? { why: v.why, judge: v.judge ?? null } : null;
}

const MODEL_NAMES: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };
/** "Claude Haiku", "Codex", "Claude": a tool and model as a person reads them. */
export function modelLabel(tool: TeamTool, model: string): string {
  const base = tool === 'codex' ? 'Codex' : 'Claude';
  const m = (model ?? '').trim();
  if (!m) return base;
  const key = Object.keys(MODEL_NAMES).find((k) => m.toLowerCase().includes(k));
  return key ? `${base} ${MODEL_NAMES[key]}` : `${base} ${m}`;
}

/** A conductor moment, as a sentence: first letter up, a few internal phrasings said plainly. */
export function momentText(text: string, t: (k: string) => string): string {
  let s = text.trim();
  if (/^sahip başlattı$/i.test(s)) return t('hk.moment.started');
  const close = /^yakınlık: \d+ çift ölçüldü(, (\d+) çift çok yakın)?/i.exec(s);
  if (close) return close[1] ? t('hk.moment.similarClose') : t('hk.moment.similar');
  s = s.replace(/ \(aynı firma\)/, '');
  return s ? s[0]!.toLocaleUpperCase('tr') + s.slice(1) : s;
}

/**
 * The language a hackathon screen speaks: its own content's (the problem the owner wrote, the
 * teams' Turkish theses), not the dashboard's. Turkish letters in the text → Turkish; otherwise
 * the dashboard's locale. One language per screen: Turkish content never sits under English labels.
 */
export function textLocale(texts: readonly (string | null | undefined)[], fallback: string): 'en' | 'tr' {
  if (texts.some((x) => !!x && /[çğıöşüÇĞİÖŞÜâî]/.test(x))) return 'tr';
  return fallback.startsWith('tr') ? 'tr' : 'en';
}
