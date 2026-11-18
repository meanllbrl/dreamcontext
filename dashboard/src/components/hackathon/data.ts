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
}

export interface DesignView {
  run: string; state: RunState; designHash: string; problem: string; kind: string;
  teams: { id: string; name: string; tool: TeamTool; model: string; inner: 'trio' | 'solo'; readIsolated: boolean; wholeDisk: boolean; control: boolean }[];
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

export interface JuryView {
  scores: Record<string, number>; originality: Record<string, number>; ranking: string[]; sameVendor: boolean;
  verdicts: { a: string; b: string; order: 'ab' | 'ba'; winner: string | null; why: string }[];
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
  return useQuery({ queryKey: ['hackathon', 'design', id], queryFn: () => api.get<DesignView>(`/hackathon/${enc(id)}/design`), refetchInterval: LIVE_MS });
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

/** Minutes left until `iso` (never negative). */
export function minutesLeft(iso: string, now = Date.now()): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : Math.max(0, Math.round((t - now) / 60_000));
}

/** A team's one-letter badge: its name's first letter (the mockups' K, C, S). */
export function badge(name: string): string {
  return (name.trim()[0] ?? '?').toLocaleUpperCase('tr');
}
