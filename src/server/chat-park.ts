import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { recordNotification } from '../lib/notification-log.js';
import {
  SOFT_AVAIL_MEM_GB, SOFT_DISK_GB, SOFT_SWAP_SHARE,
  machineRoom, readCapacityFactsFresh, type CapacityFacts, type MachineLimit, type MachineRoom,
} from '../lib/super/capacity.js';

/**
 * Idle chats are parked when the machine is under load (task idle-chats-are-parked-…, design
 * §P P-D1..D6) — and the PARK PRIMITIVE the orchestration task's `super end` and its 10-min
 * backstop reuse (plan r5 D13).
 *
 * A PARKABLE is one live Claude process the app runs for a tab: a Chat tab (agent-chat.ts) or
 * a Claude terminal tab (agent-terminal.ts). It registers here for its lifetime and tells the
 * sweep what only it knows (turn state, background tasks, the last focus frame, who holds its
 * socket). Parking it sends a `park` frame DOWN THAT TAB'S OWN SOCKET (never a window verb, so
 * no agent can park another tab by naming it); the window re-checks what only it knows (the
 * tab focused or typed in, an unsent draft, a turn running), refuses or closes the process the
 * way the owner's close does, and turns the tab dormant: Resume reopens the same conversation.
 * A chat with no socket (window closed, phone gone) is drained directly.
 *
 * THE SWEEP: one 60 s timer, armed only while a parkable lives. It reads the machine
 * ({@link machineRoom}); no memory/swap/disk pressure parks nothing. Soft pressure parks chats
 * idle >= 10 min, hard pressure (swap >= 90 % or disk < 8 GB) idle >= 3 min, longest idle
 * first, as many as the shortfall needs ({@link PARK_FREES_GB} each), then one notice.
 */

export type ParkKind = 'chat' | 'terminal';

/** What a caller asks beyond a plain park. `end` (`super end`): the window CLOSES the tab
 *  instead of keeping it dormant, so it is gone from the roster and no relaunch restores it;
 *  the transcript stays on disk. `force` (only when the owner asked): a turn, a question or
 *  background work does not keep the tab; the Assistant, the Super Agent and the phone still do. */
export interface ParkOptions { end?: boolean; force?: boolean }

/** Why a parkable is never parked, whatever the load. */
export type ParkExempt = 'assistant' | 'super' | 'phone';

/** What a park attempt did. Only `parked` and `drained` freed a process. */
export type ParkOutcome =
  | 'parked' | 'drained' | 'already'
  | 'busy' | 'asking' | 'background' | 'focused' | 'exempt' | 'refused' | 'no_answer';

export interface Parkable {
  /** The tab's pinned conversation id (the roster id Resume uses). */
  id: string;
  kind: ParkKind;
  projectRoot: string;
  /** The process leading the tab's group (for the terminal's shell-descendant check). */
  pid?: number;
  exempt: () => ParkExempt | null;
  /** A turn is running (or the process is still starting). */
  busy: () => boolean;
  /** A question or permission card waits for the owner. */
  asking: () => boolean;
  /** Background shells and agents the CLI reports running (chat only; a terminal reports 0
   *  and is checked through its process tree and transcripts instead). */
  backgroundTasks: () => number;
  /** The last sign of the owner or the agent (a turn edge, terminal IO, the spawn). */
  idleSince: () => number;
  /** The last `focus` frame from the window (0 = never). */
  focusedAt: () => number;
  /** The tab's transcript, for the last guard: a transcript or sub-agent transcript written
   *  inside the idle window means something is still working. Null = unknown. */
  transcriptPath?: () => string | null;
  /** Terminal only: when its last turn started (the hook's `working`). A TUI's background
   *  sub-agent runs inside the process with no roster and no shell, and can sit in one long
   *  model or tool call writing nothing, so ANY sub-agent transcript written since then keeps
   *  the tab until a later turn. */
  lastTurnStartedAt?: () => number;
  /** Send the park frame (or drain when there is no socket). Idempotent. */
  park: (reason: string, opts?: ParkOptions) => Promise<ParkOutcome>;
}

/** Every parkable minimum the window and the policy agree on. */
export const PARK_SWEEP_MS = 60_000;
export const SOFT_IDLE_MS = 10 * 60_000;
export const HARD_IDLE_MS = 3 * 60_000;
/** A tab focused or typed in this recently is the owner's. The window sends `focus` at most
 *  once per {@link FOCUS_FRAME_THROTTLE_MS}, so the gap is always inside this. */
export const FOCUS_GRACE_MS = 2 * 60_000;
export const FOCUS_FRAME_THROTTLE_MS = 30_000;
/** What one parked Claude frees, measured on the owner's Mac (2026-10-20: 27 `claude` at
 *  130-320 MB footprint, median ~230 MB incl. compressed), MCP children not counted. */
export const PARK_FREES_GB = 0.23;
/** How long the window has to answer a park frame. */
export const PARK_ANSWER_MS = 15_000;

/** A positive-integer env override, read per call. ONLY a scratch verify run sets these
 *  (scripts/verify/chat-park.mjs), so it can prove the minutes-long behaviour in seconds. */
function envMs(name: string): number | null {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : null;
}
export function parkSweepMs(): number { return envMs('DREAMCONTEXT_PARK_SWEEP_MS') ?? PARK_SWEEP_MS; }
/** The focus grace the server applies and hands the window in every park frame. */
export function parkFocusGraceMs(): number { return envMs('DREAMCONTEXT_PARK_FOCUS_MS') ?? FOCUS_GRACE_MS; }
function parkIdleOverrideMs(): number | null { return envMs('DREAMCONTEXT_PARK_IDLE_MS'); }
/** Verify only: pretend the machine is under this pressure (the real reading is used otherwise). */
function forcedPressure(): 'soft' | 'hard' | null {
  const v = process.env.DREAMCONTEXT_PARK_PRESSURE;
  return v === 'soft' || v === 'hard' ? v : null;
}

// ── Policy (pure) ──────────────────────────────────────────────────────────────────

export interface ParkPressure {
  level: 'none' | 'soft' | 'hard';
  /** How far over the soft line the machine is, in GB (the largest of swap, memory, disk). */
  deficitGb: number;
  limits: MachineLimit[];
}

const PRESSURE_LIMITS: readonly MachineLimit[] = ['swap', 'availMem', 'disk'];

/** Parking answers memory, swap and disk only: a session count or light mode never parks. */
export function parkPressure(facts: CapacityFacts, room: MachineRoom = machineRoom(facts)): ParkPressure {
  const reasons = room.reasons.filter((r) => PRESSURE_LIMITS.includes(r.limit));
  if (!reasons.length) return { level: 'none', deficitGb: 0, limits: [] };
  let deficitGb = 0;
  for (const r of reasons) {
    if (r.limit === 'swap' && typeof facts.swapUsedGb === 'number' && typeof facts.swapTotalGb === 'number') {
      deficitGb = Math.max(deficitGb, facts.swapUsedGb - SOFT_SWAP_SHARE * facts.swapTotalGb);
    }
    if (r.limit === 'availMem') deficitGb = Math.max(deficitGb, SOFT_AVAIL_MEM_GB - facts.availMemGb);
    if (r.limit === 'disk' && typeof facts.diskFreeGb === 'number') deficitGb = Math.max(deficitGb, SOFT_DISK_GB - facts.diskFreeGb);
  }
  return {
    level: reasons.some((r) => r.hard) ? 'hard' : 'soft',
    deficitGb: Math.max(0, deficitGb),
    limits: reasons.map((r) => r.limit),
  };
}

/** One parkable as the policy sees it at one instant. */
export interface ParkCandidate {
  id: string;
  exempt: ParkExempt | null;
  busy: boolean;
  asking: boolean;
  backgroundTasks: number;
  idleSince: number;
  focusedAt: number;
}

/** The minimum idle time a pressure level parks at. */
export function minIdleFor(level: ParkPressure['level']): number {
  return level === 'hard' ? HARD_IDLE_MS : SOFT_IDLE_MS;
}

/** Why the policy keeps one candidate, or null when it may be parked now. */
export function keepReason(c: ParkCandidate, minIdleMs: number, now: number, focusGraceMs = FOCUS_GRACE_MS): ParkOutcome | null {
  if (c.exempt) return 'exempt';
  if (c.busy) return 'busy';
  if (c.asking) return 'asking';
  if (c.backgroundTasks > 0) return 'background';
  if (c.focusedAt > 0 && now - c.focusedAt < focusGraceMs) return 'focused';
  if (now - c.idleSince < minIdleMs) return 'busy';
  return null;
}

/**
 * Which chats to park under this pressure, longest idle first, as many as the shortfall needs
 * (at least one; every eligible one when the shortfall is larger than they free). No pressure
 * parks nothing.
 */
export function pickChatsToPark(
  cands: readonly ParkCandidate[], pressure: ParkPressure, now: number,
  opts: { minIdleMs?: number; focusGraceMs?: number } = {},
): string[] {
  if (pressure.level === 'none') return [];
  const minIdle = opts.minIdleMs ?? minIdleFor(pressure.level);
  const eligible = cands.filter((c) => keepReason(c, minIdle, now, opts.focusGraceMs) === null).sort((a, b) => a.idleSince - b.idleSince);
  const budget = Math.max(1, Math.ceil(pressure.deficitGb / PARK_FREES_GB));
  return eligible.slice(0, budget).map((c) => c.id);
}

// ── Process tree + transcripts (the terminal's background check) ──────────────────

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh']);

/** pids from `ps -axo pid=,ppid=,comm=` whose process has a SHELL descendant: a background
 *  command (Bash `run_in_background`, a dev server) the park would kill. An MCP server started
 *  through a shell reads as one too, which only ever keeps a tab alive (the safe direction). */
export function pidsWithShellDescendant(psOut: string, roots: readonly number[]): Set<number> {
  const children = new Map<number, Array<{ pid: number; comm: string }>>();
  for (const line of psOut.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]); const ppid = Number(m[2]); const comm = m[3];
    const list = children.get(ppid) ?? [];
    list.push({ pid, comm: comm.slice(comm.lastIndexOf('/') + 1).replace(/^-/, '') });
    children.set(ppid, list);
  }
  const out = new Set<number>();
  for (const root of roots) {
    const stack = [...(children.get(root) ?? [])];
    const seen = new Set<number>();
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      if (SHELLS.has(p.comm)) { out.add(root); break; }
      stack.push(...(children.get(p.pid) ?? []));
    }
  }
  return out;
}

export interface TranscriptActivity {
  /** The transcript could be read at all. */
  readable: boolean;
  /** The newest write to the transcript or any sub-agent transcript (epoch ms). */
  at: number;
  /** The newest write to a sub-agent transcript (epoch ms), 0 when there is none. */
  subagentAt: number;
}

/** Writes to a transcript and its sub-agent transcripts. `<id>.jsonl` sits beside the
 *  `<id>/subagents/` directory. */
export function transcriptActivity(transcript: string | null): TranscriptActivity {
  if (!transcript) return { readable: false, at: 0, subagentAt: 0 };
  let at = 0;
  let readable = false;
  try { at = statSync(transcript).mtimeMs; readable = true; } catch { /* gone */ }
  let subagentAt = 0;
  const dir = join(dirname(transcript), transcript.replace(/^.*\//, '').replace(/\.jsonl$/, ''), 'subagents');
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try { subagentAt = Math.max(subagentAt, statSync(join(dir, f)).mtimeMs); } catch { /* raced */ }
    }
  } catch { /* no sub-agents */ }
  return { readable, at: Math.max(at, subagentAt), subagentAt };
}

// ── Registry + sweep ───────────────────────────────────────────────────────────────

const parkables = new Map<string, Parkable>();

export interface SweepDeps {
  now: () => number;
  enabled: () => boolean;
  readFacts: () => Promise<CapacityFacts>;
  /** `ps -axo pid=,ppid=,comm=`, read only when a terminal is a candidate. */
  ps: () => Promise<string>;
  activity: (p: Parkable) => TranscriptActivity;
  notice: (parked: number, pressure: ParkPressure) => void;
}

const run = promisify(execFile);

/** Settings → Chat "Park idle chats under load": ON unless `agent-ui.json` says `false`. */
export function parkIdleChatsEnabled(home: string = homedir()): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(home, '.dreamcontext', 'agent-ui.json'), 'utf-8')) as Record<string, unknown>;
    return raw.parkIdleChats !== false;
  } catch {
    return true;
  }
}

function systemTurkish(): boolean {
  try { return /^tr\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale) || /^tr/i.test(process.env.LANG ?? ''); } catch { return false; }
}

/** The one line a sweep that parked something leaves: "3 sohbet park edildi: bellek baskısı". */
export function parkNoticeText(parked: number, pressure: ParkPressure, turkish = systemTurkish()): { title: string; body: string } {
  const what = pressure.limits.includes('disk') && !pressure.limits.some((l) => l !== 'disk')
    ? (turkish ? 'disk baskısı' : 'low disk')
    : (turkish ? 'bellek baskısı' : 'memory pressure');
  return turkish
    ? { title: 'Sohbetler park edildi', body: `${parked} sohbet park edildi: ${what}` }
    : { title: 'Chats parked', body: `${parked} idle ${parked === 1 ? 'chat' : 'chats'} parked: ${what}` };
}

const defaultSweepDeps = (): SweepDeps => ({
  now: () => Date.now(),
  enabled: () => parkIdleChatsEnabled(),
  readFacts: () => readCapacityFactsFresh(),
  ps: async () => (await run('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })).stdout,
  activity: (p) => transcriptActivity(p.transcriptPath?.() ?? null),
  notice: (parked, pressure) => { recordNotification(parkNoticeText(parked, pressure)); },
});

let sweepDeps: SweepDeps | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

function armSweep(): void {
  if (sweepTimer || parkables.size === 0) return;
  sweepTimer = setInterval(() => { void sweepOnce(); }, parkSweepMs());
  sweepTimer.unref?.();
}

function disarmSweep(): void {
  if (sweepTimer && parkables.size === 0) { clearInterval(sweepTimer); sweepTimer = null; }
}

/** Register a live tab's process; returns the unregister to run when it exits. */
export function registerParkable(p: Parkable): () => void {
  if (!p.id) return () => { /* nothing registered */ };
  parkables.set(p.id, p);
  parkedAt.delete(p.id);
  armSweep();
  return () => {
    if (parkables.get(p.id) === p) parkables.delete(p.id);
    disarmSweep();
  };
}

/** Tabs parked (dormant, not ended) since their process last registered: `super state` says
 *  `parked` for them instead of `gone`. In memory: a restart forgets it. */
const parkedAt = new Map<string, number>();

/** When this tab was parked, or null when it was not (or has run again since). */
export function parkedSince(id: string): number | null {
  return parkedAt.get(id) ?? null;
}

export function findParkable(id: string): Parkable | null {
  return parkables.get(id) ?? null;
}

/**
 * THE PRIMITIVE: park one tab now (what `super end` and its backstop call). The server-side
 * never-park list is checked here too, so no caller can park a busy, asking, background or
 * exempt chat; the window then re-checks focus, typing and its draft. Idempotent: a tab already
 * parked (no longer registered) answers `already`. The terminal-only guards (shell descendants,
 * sub-agent transcripts) live in the sweep: a future caller that parks a TERMINAL by id (super
 * end only targets chats) must run them too.
 */
export async function parkChat(id: string, reason: string, opts: ParkOptions = {}): Promise<ParkOutcome> {
  const p = parkables.get(id);
  if (!p) return 'already';
  if (opts.force) {
    if (p.exempt()) return 'exempt';
    return noteParked(id, await p.park(reason, opts), opts);
  }
  const keep = keepReason(candidateOf(p), 0, Date.now());
  if (keep && keep !== 'focused') return keep;
  return noteParked(id, await p.park(reason, opts), opts);
}

function noteParked(id: string, outcome: ParkOutcome, opts: ParkOptions): ParkOutcome {
  if ((outcome === 'parked' || outcome === 'drained') && !opts.end) parkedAt.set(id, Date.now());
  return outcome;
}

function candidateOf(p: Parkable): ParkCandidate {
  return {
    id: p.id,
    exempt: p.exempt(),
    busy: p.busy(),
    asking: p.asking(),
    backgroundTasks: p.backgroundTasks(),
    idleSince: p.idleSince(),
    focusedAt: p.focusedAt(),
  };
}

/** One sweep. Exported for tests (with injected deps) and the verify route. */
export async function sweepOnce(deps: SweepDeps = sweepDeps ?? defaultSweepDeps()): Promise<{ parked: string[]; pressure: ParkPressure | null }> {
  if (sweeping || parkables.size === 0) return { parked: [], pressure: null };
  sweeping = true;
  try {
    if (!deps.enabled()) return { parked: [], pressure: null };
    const facts = await deps.readFacts();
    const forced = forcedPressure();
    const pressure = forced ? { level: forced, deficitGb: Infinity, limits: ['swap' as const] } : parkPressure(facts);
    if (pressure.level === 'none') return { parked: [], pressure };
    const now = deps.now();
    const minIdle = parkIdleOverrideMs() ?? minIdleFor(pressure.level);
    const pick = { minIdleMs: minIdle, focusGraceMs: parkFocusGraceMs() };
    const all = [...parkables.values()];
    // The last guards, read only for the ones the policy would pick: a transcript (or a
    // sub-agent's) written inside the idle window, and a terminal with a shell descendant.
    const picked = pickChatsToPark(all.map(candidateOf), { ...pressure, deficitGb: Infinity }, now, pick);
    const terminalPids = picked.map((id) => parkables.get(id)).filter((p): p is Parkable => p?.kind === 'terminal' && !!p.pid).map((p) => p.pid!);
    let shellBusy = new Set<number>();
    if (terminalPids.length) {
      try { shellBusy = pidsWithShellDescendant(await deps.ps(), terminalPids); } catch { shellBusy = new Set(terminalPids); }
    }
    const clear = new Set(picked.filter((id) => {
      const p = parkables.get(id);
      if (!p) return false;
      const act = deps.activity(p);
      if (p.kind === 'terminal') {
        // A terminal has no roster: unknown is kept, and so is a sub-agent touched since the
        // last turn started (it may still be running in the background).
        if (!p.pid || shellBusy.has(p.pid) || !act.readable) return false;
        if (act.subagentAt > 0 && act.subagentAt >= (p.lastTurnStartedAt?.() ?? 0)) return false;
      }
      return now - act.at >= minIdle;
    }));
    const order = pickChatsToPark(all.filter((p) => clear.has(p.id)).map(candidateOf), pressure, now, pick);
    const reason = pressure.level === 'hard' ? 'machine-hard' : 'machine';
    const parked: string[] = [];
    for (const id of order) {
      const outcome = await parkChat(id, reason).catch((): ParkOutcome => 'refused');
      if (outcome === 'parked' || outcome === 'drained') parked.push(id);
    }
    if (parked.length) deps.notice(parked.length, pressure);
    return { parked, pressure };
  } finally {
    sweeping = false;
  }
}

/** Tests only. */
export function _resetChatParkForTests(deps: SweepDeps | null = null): void {
  parkables.clear();
  parkedAt.clear();
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  sweepDeps = deps;
  sweeping = false;
}

/** Tests only: is the sweep timer armed? */
export function _sweepArmedForTests(): boolean {
  return sweepTimer !== null;
}
