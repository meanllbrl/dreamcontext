/**
 * The conductor (plan C6): one detached process per run, restart-safe from `run.json`. It
 * prepares the workspaces, spawns each team on the `hackathon-team` envelope and walks the
 * phases registered in `phases.ts`. It builds every envelope from `.conductor/design.json` only,
 * and stops the run when that copy's hash no longer matches the hash stored at start.
 *
 * Everything that touches the outside (spawning a turn, reading usage, the clock) is a dep, so
 * the unit test drives a whole run without a model.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFileLock, lockHolderPid, reclaimDeadHolderLock, releaseFileLock } from '../file-lock.js';
import { readUsageLimits } from '../claude-usage.js';
import { codexStrictArgs, parseCodexMcpList } from '../t3-bridge/launch.js';
import type { Design, TeamDesign } from './designer.js';
import { judgeLimit, readingOf, type LimitVerdict } from './limit.js';
import {
  addMoment, conductorDir, designHash, readJson, readRun, runDir, teamWorkspace, updateRun, writeJsonAtomic,
  type Phase, type RunRecord, type UsageReading,
} from './run-store.js';
import { claudeTeamArgv, claudeTeamEnv, codexTeamTurn, teamPaths } from './team-session.js';

/** A round's turn is stopped this long after its deadline. */
export const OVERRUN_MS = 5 * 60_000;
export const TICK_MS = 5_000;

export interface TeamState {
  sessionId: string;
  /** Codex thread id once the first turn printed it. */
  thread?: string;
  turns: number;
  /** Codex servers seen at start (a new one refuses the turn). */
  codexServers?: string[];
  installPaths?: string[];
  /** The team's latest snapshot: ok, and how many over-size files kept an older version. */
  snap?: { label: string; ok: boolean; kept: number };
}

export interface ConductorState {
  prepared: boolean;
  /** Blocks waiting for each team's next round message (peek cards, questions, answers, overlap). */
  pending?: Record<string, string[]>;
  /** Who asked whom, so an answer finds its way back: answerer → askers. */
  asked?: Record<string, string[]>;
  teams: Record<string, TeamState>;
  /** The last weekly reading before a reset (limit across a reset). */
  lastWeekly?: number | null;
}

export interface TurnHandle {
  /** Resolves with the exit code when the turn ends (or is killed). */
  done: Promise<number | null>;
  kill(): void;
}

export interface TurnRequest {
  run: RunRecord;
  design: Design;
  team: TeamDesign;
  state: TeamState;
  prompt: string;
  round: number;
  /** The team's transcript for this turn (brain side, local-only). */
  transcript: string;
}

export interface ConductorDeps {
  contextRoot: string;
  /** The brain's project root (teams read it). */
  brainRoot: string;
  linkedRepos: readonly string[];
  wsHome?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now(): number;
  sleep(ms: number): Promise<void>;
  startTurn(req: TurnRequest): TurnHandle;
  readUsage(): UsageReading | null;
  /** Hands the caller the kill for every live team turn (its SIGTERM handler calls it). */
  onAbort?(killAll: () => void): void;
  /** Workspace preparation (clone, install, snapshot repo); injectable for the unit test. */
  prepare(run: RunRecord, design: Design): Promise<Record<string, Partial<TeamState>>> | Record<string, Partial<TeamState>>;
  /** The team's snapshot after a round's turn ends. */
  /** Snapshot the team's tree; returns the over-size paths that kept their older version. */
  snapshot(run: RunRecord, team: string, label: string): { kept: readonly string[] } | void;
  notify?(text: string): void;
}

// ─── State files (conductor-owned) ──────────────────────────────────────────

export function designCopyPath(runId: string, wsHome?: string): string {
  return join(conductorDir(runId, wsHome), 'design.json');
}

export function statePath(runId: string, wsHome?: string): string {
  return join(conductorDir(runId, wsHome), 'state.json');
}

export function readState(runId: string, wsHome?: string): ConductorState {
  return readJson<ConductorState>(statePath(runId, wsHome)) ?? { prepared: false, teams: {} };
}

export function writeState(runId: string, s: ConductorState, wsHome?: string): void {
  writeJsonAtomic(statePath(runId, wsHome), s);
}

/** The started design from the conductor's copy, or the reason it cannot be trusted. */
export function startedDesign(run: RunRecord, wsHome?: string): { ok: true; design: Design } | { ok: false; reason: string } {
  const copy = readJson<{ design: Design; hash: string }>(designCopyPath(run.id, wsHome));
  if (!copy || !copy.design) return { ok: false, reason: 'tasarım kopyası yok' };
  if (!run.startedHash) return { ok: false, reason: 'koşu başlatılmamış' };
  if (designHash({ design: copy.design }) !== run.startedHash) return { ok: false, reason: 'tasarım kopyası başlangıçtan sonra değişti: koşu durduruldu' };
  return { ok: true, design: copy.design };
}

export function transcriptPath(contextRoot: string, runId: string, team: string, label: string): string {
  return join(runDir(contextRoot, runId), 'teams', team, `${label}.jsonl`);
}

// ─── Messages ───────────────────────────────────────────────────────────────

export function teamBrief(run: RunRecord, design: Design, team: TeamDesign, brainRoot: string): string {
  const out = teamWorkspace(run.id, team.id).out;
  const roles = team.inner === 'trio'
    ? 'You are the Kaptan. Your sub-agents: "yapici" builds, "elestirmen" raises one objection. Each round: plan, one objection from the Eleştirmen, your decision, then the Yapıcı builds.'
    : 'You work alone: plan, check your own plan once, decide, build.';
  return [
    `You are team "${team.name}" in a hackathon. Persona: ${team.persona || team.name}.`,
    `Problem (${design.kind}): ${design.problem}`,
    roles,
    `Your repo clone is your working directory; your files for the jury go in ${out}.`,
    'You have no network. You cannot reach the owner: never ask questions, decide and note why.',
    `Project memory (read-only): cd ${brainRoot} && dreamcontext memory recall "<query>"`,
    'Every round, write these files in your out folder:',
    `- thesis-r<N>.json: {"thesis": one sentence ≤200 chars, "claims": [3 short claims], "status": "on-track"|"stuck"|"pivot", "stuck"?: "…"}. No code, links or images in it.`,
    `- append to decisions.jsonl one JSON line per plan/objection/decision: {"at": ISO time, "role": "kaptan"|"yapici"|"elestirmen", "kind": "plan"|"objection"|"decision", "text": ≤280 chars}`,
    design.kind === 'screen' ? '- a static build of your screen under out/build/ (relative paths) and shot-request.json {"entry": "index.html"}' : '',
    `There are ${design.rounds} rounds of ${design.roundMinutes} minutes. Work only inside your clone and your out folder.`,
  ].filter(Boolean).join('\n');
}

export function roundMessage(run: RunRecord, design: Design, team: TeamDesign, round: number, brainRoot: string, extra: readonly string[] = []): string {
  const head = round === 1 ? `${teamBrief(run, design, team, brainRoot)}\n\n` : '';
  const last = round === design.rounds;
  return `${head}=== ROUND ${round} of ${design.rounds} (${design.roundMinutes} min) ===\n${extra.join('\n\n')}${extra.length ? '\n\n' : ''}Write thesis-r${round}.json before this round ends.${last ? ' This is the last round: finish and leave the work ready to present.' : ''}`;
}

// ─── The loop ───────────────────────────────────────────────────────────────

export interface PhaseCtx {
  deps: ConductorDeps;
  design: Design;
  state: ConductorState;
  /**
   * Run every team's turn for `label` with its message, until done or `durationMs` + overrun.
   * The clock starts when the turns start, after any session-guard wait (never before it).
   */
  runTurns(label: string, round: number, messages: Record<string, string>, durationMs: number, teams?: readonly string[]): Promise<void>;
  limit(): LimitVerdict;
  saveState(): void;
}


/**
 * Drive the run from where `run.json` says it is to the end of its phases. Returns the final
 * record. Stop (state `stopped`) is checked every tick and kills the team processes.
 */
export async function conduct(runId: string, deps: ConductorDeps, phases: readonly Phase<PhaseCtx>[]): Promise<RunRecord> {
  let run = readRun(deps.contextRoot, runId);
  if (!run) throw new Error(`no hackathon run ${runId}`);
  const sd = startedDesign(run, deps.wsHome);
  if (!sd.ok) {
    if (run.state !== 'stopped' && run.state !== 'picked') run = stopRun(deps.contextRoot, runId, sd.reason);
    return run;
  }
  const design = sd.design;
  const state = readState(runId, deps.wsHome);
  const saveState = () => writeState(runId, state, deps.wsHome);
  const live = new Set<TurnHandle>();

  const limit = (): LimitVerdict => {
    const cur = readRun(deps.contextRoot, runId) ?? run!;
    const now = deps.readUsage();
    if (now?.weeklyPercent != null && cur.usageAtStart?.weeklyResetsAt != null && now.weeklyResetsAt === cur.usageAtStart.weeklyResetsAt) {
      state.lastWeekly = now.weeklyPercent;
    }
    return judgeLimit({ limit: design.limit, start: cur.usageAtStart, now, lastBeforeReset: state.lastWeekly ?? null, at: deps.now(), guardOverride: cur.guardOverride });
  };

  const stopped = (): boolean => (readRun(deps.contextRoot, runId)?.state ?? 'stopped') === 'stopped';

  const runTurns: PhaseCtx['runTurns'] = async (label, round, messages, durationMs, only) => {
    const teams = design.teams.filter((t) => (!only || only.includes(t.id)) && messages[t.id]);
    // The session guard: no new team turn while the 5-hour window is past it.
    for (;;) {
      const v = limit();
      if (v.newTurn || stopped()) {
        if ((readRun(deps.contextRoot, runId)?.paused ?? null) !== null) run = updateRun(deps.contextRoot, runId, (r) => ({ ...r, paused: null }));
        break;
      }
      run = updateRun(deps.contextRoot, runId, (r) => (r.paused === v.reason ? null : addMoment({ ...r, paused: v.reason }, v.reason ?? '')));
      // A minute between readings, in ticks, so a Stop is seen within one.
      for (let w = 0; w < 60_000 && !stopped(); w += TICK_MS) await deps.sleep(TICK_MS);
    }
    if (stopped()) return;
    const deadlineMs = deps.now() + durationMs;
    const handles = teams.map((team) => {
      const st = state.teams[team.id] ?? (state.teams[team.id] = { sessionId: randomUUID(), turns: 0 });
      const transcript = transcriptPath(deps.contextRoot, runId, team.id, label);
      mkdirSync(join(transcript, '..'), { recursive: true });
      const h = deps.startTurn({ run: run!, design, team, state: st, prompt: messages[team.id]!, round, transcript });
      st.turns += 1;
      live.add(h);
      return { team, h, ended: false };
    });
    saveState();
    const all = Promise.all(handles.map(async (x) => { await x.h.done; x.ended = true; live.delete(x.h); }));
    let finished = false;
    void all.then(() => { finished = true; });
    while (!finished) {
      if (stopped()) { for (const x of handles) x.h.kill(); break; }
      if (deps.now() > deadlineMs + OVERRUN_MS) {
        for (const x of handles.filter((y) => !y.ended)) {
          x.h.kill();
          run = updateRun(deps.contextRoot, runId, (r) => addMoment(r, `${x.team.name}: süre doldu, tur durduruldu`));
        }
        break;
      }
      await deps.sleep(Math.min(TICK_MS, Math.max(10, deadlineMs + OVERRUN_MS - deps.now())));
    }
    await all;
    // Every team's snapshot after its turn ends or is stopped.
    for (const x of handles) {
      const st = state.teams[x.team.id]!;
      try {
        const got = deps.snapshot(run!, x.team.id, label);
        st.snap = { label, ok: true, kept: got?.kept.length ?? 0 };
      } catch (e) {
        st.snap = { label, ok: false, kept: 0 };
        run = updateRun(deps.contextRoot, runId, (r) => addMoment(r, `${x.team.name}: kopya alınamadı (${(e as Error).message.slice(0, 80)})`));
      }
    }
    saveState();
  };

  const ctx: PhaseCtx = { deps, design, state, runTurns, limit, saveState };
  deps.onAbort?.(() => { for (const h of live) h.kill(); });

  try {
    if (!state.prepared) {
      const extra = await deps.prepare(run, design);
      for (const [team, s] of Object.entries(extra)) state.teams[team] = { ...(state.teams[team] ?? { sessionId: randomUUID(), turns: 0 }), ...s } as TeamState;
      state.prepared = true;
      saveState();
      run = updateRun(deps.contextRoot, runId, (r) => addMoment(r, 'ekipler masalarında'));
    }
    const startAt = phases.findIndex((p) => p.name === (run!.phase ?? phases[0]!.name));
    for (const phase of phases.slice(Math.max(0, startAt))) {
      if (stopped()) break;
      run = updateRun(deps.contextRoot, runId, (r) => ({ ...r, phase: phase.name }));
      run = await phase.run(run, ctx);
    }
  } finally {
    for (const h of live) h.kill();
  }
  return readRun(deps.contextRoot, runId) ?? run;
}

export function stopRun(contextRoot: string, runId: string, reason: string): RunRecord {
  return updateRun(contextRoot, runId, (r) => (r.state === 'stopped' || r.state === 'picked' ? null : addMoment({ ...r, state: 'stopped', stopReason: reason, paused: null }, `durduruldu: ${reason}`)));
}

// ─── The real deps ──────────────────────────────────────────────────────────

function splitConfigArgs(s: string): string[] {
  const out: string[] = [];
  const re = /-c '((?:[^']|'\\'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push('-c', m[1]!.replace(/'\\''/g, "'"));
  return out;
}

/** The Codex servers Codex lists from `cwd`, or null when unreadable. */
export function codexListedServers(cwd: string, env: NodeJS.ProcessEnv): ReturnType<typeof parseCodexMcpList> {
  const r = spawnSync('codex', ['mcp', 'list', '--json'], { cwd, env, encoding: 'utf-8', timeout: 30_000 });
  return r.status === 0 ? parseCodexMcpList(r.stdout) : null;
}

/** Spawn one real team turn: Claude through `claudeTeamArgv`, Codex through `codex exec`. */
export function realStartTurn(base: { brainRoot: string; linkedRepos: readonly string[]; wsHome?: string; home?: string; env: NodeJS.ProcessEnv; hookCommand?: string | null }) {
  return (req: TurnRequest): TurnHandle => {
    const paths = teamPaths({ runId: req.run.id, team: req.team.id, design: req.design, brainRoot: base.brainRoot, linkedRepos: base.linkedRepos, home: base.home, wsHome: base.wsHome });
    const fd = openSync(req.transcript, 'a');
    let child: ChildProcess | null = null;
    let refused: string | null = null;
    if (req.team.tool === 'claude') {
      const argv = claudeTeamArgv({
        team: req.team, paths, design: req.design, prompt: req.prompt, sessionId: req.state.sessionId,
        resume: req.state.turns > 0, configDir: join(conductorDir(req.run.id, base.wsHome), 'cfg'), hookCommand: base.hookCommand ?? null,
      });
      child = spawn('claude', argv, { cwd: paths.repo, env: claudeTeamEnv(base.env, req.run.id, req.team.id), stdio: ['ignore', fd, fd], detached: true });
    } else {
      const listed = codexListedServers(paths.repo, base.env);
      const plan = codexTeamTurn({ paths, listed, seenAtStart: req.state.codexServers ?? null, base: base.env });
      if (!plan.ok) refused = plan.reason;
      else {
        const common = ['--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false',
          '-c', 'approval_policy="never"', ...splitConfigArgs(plan.configArgs), '--cd', plan.cwd, '--add-dir', paths.out,
          ...(req.team.model ? ['-m', req.team.model] : [])];
        const argv = req.state.thread ? ['exec', 'resume', ...common, req.state.thread, req.prompt] : ['exec', ...common, req.prompt];
        child = spawn('codex', argv, { cwd: plan.cwd, env: plan.env, stdio: ['ignore', 'pipe', fd], detached: true });
        const log = createWriteStream(req.transcript, { flags: 'a' });
        child.stdout?.on('data', (b: Buffer) => {
          log.write(b);
          const m = /"thread_id"\s*:\s*"([0-9a-f-]{36})"/.exec(b.toString('utf-8'));
          if (m && !req.state.thread) req.state.thread = m[1];
        });
        child.on('close', () => log.end());
      }
    }
    closeSync(fd);
    if (refused) {
      writeFileSync(req.transcript, `${JSON.stringify({ type: 'refused', reason: refused })}\n`, { flag: 'a' });
      return { done: Promise.resolve(1), kill() {} };
    }
    let closed = false;
    const done = new Promise<number | null>((res) => { child!.on('close', (code) => { closed = true; res(code); }); child!.on('error', () => { closed = true; res(1); }); });
    const signal = (sig: NodeJS.Signals) => { try { if (child?.pid) process.kill(-child.pid, sig); } catch { /* gone */ } };
    return {
      done,
      kill() {
        signal('SIGTERM');
        // A turn that ignores SIGTERM is not left running (and `await all` never hangs on it).
        setTimeout(() => { if (!closed) signal('SIGKILL'); }, 10_000).unref();
      },
    };
  };
}

export function realReadUsage(): UsageReading | null {
  try {
    return readingOf(readUsageLimits());
  } catch {
    return null;
  }
}

// ─── Launch ─────────────────────────────────────────────────────────────────

export function conductorLockPath(runId: string, wsHome?: string): string {
  return join(conductorDir(runId, wsHome), 'conductor.lock');
}

/** Take the run's PID lock; false when a live conductor already holds it. */
export function takeConductorLock(runId: string, wsHome?: string): boolean {
  mkdirSync(conductorDir(runId, wsHome), { recursive: true });
  // A dead holder (reboot, crash, kill -9) frees the run at once, whatever the lock's age.
  reclaimDeadHolderLock(conductorLockPath(runId, wsHome));
  return acquireFileLock(conductorLockPath(runId, wsHome), Date.now(), 24 * 3600_000, { verifyPidLiveness: true });
}

export function releaseConductorLock(runId: string, wsHome?: string): void {
  releaseFileLock(conductorLockPath(runId, wsHome));
}

/** The pid of the live conductor holding this run's lock, else null. Reads only. */
export function liveConductorPid(runId: string, wsHome?: string, probe: (pid: number) => void = (pid) => { process.kill(pid, 0); }): number | null {
  const pid = lockHolderPid(conductorLockPath(runId, wsHome));
  if (pid === null) return null;
  try { probe(pid); return pid; } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'EPERM' ? pid : null; }
}

/** A run whose phases are not done yet: it needs a live conductor to move. */
export function needsConductor(contextRoot: string, run: RunRecord): boolean {
  return run.state === 'running' || run.state === 'presenting' || (run.state === 'judging' && !existsSync(join(runDir(contextRoot, run.id), 'jury.json')));
}

/** Grace after Başlat or a relaunch before a missing conductor counts as gone. */
export const CONDUCTOR_GRACE_MS = 30_000;

/**
 * `alive`, `starting` (launched within the grace), `gone` (the run needs one and none holds its
 * lock: the page offers Sürdür) or null (the run needs none).
 */
export function conductorStatus(contextRoot: string, run: RunRecord, o: { wsHome?: string; now?: number } = {}): 'alive' | 'starting' | 'gone' | null {
  if (!needsConductor(contextRoot, run)) return null;
  if (liveConductorPid(run.id, o.wsHome) !== null) return 'alive';
  const since = Date.parse(run.launchedAt ?? run.startedAt ?? '');
  return Number.isFinite(since) && (o.now ?? Date.now()) - since < CONDUCTOR_GRACE_MS ? 'starting' : 'gone';
}

/** Start the detached conductor (`dreamcontext hackathon conduct <run>`); it outlives every chat. */
export function launchConductor(cliEntry: { file: string; args: string[] }, runId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const logDir = conductorDir(runId);
  mkdirSync(logDir, { recursive: true });
  const fd = openSync(join(logDir, 'conductor.log'), 'a');
  const child = spawn(cliEntry.file, [...cliEntry.args, 'hackathon', 'conduct', runId], { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  closeSync(fd);
  return child.pid ?? null;
}

// ─── The owner's Başlat ─────────────────────────────────────────────────────

/** Minutes a team's workspace preparation may take (clone + install) before round 1. */
export const PREP_MINUTES_PER_TEAM = 15;

/** The earliest end a run started at `at` needs: prep, every round, presentation and slack. */
export function earliestEnd(design: Design, at: Date): Date {
  return new Date(at.getTime() + (design.teams.length * PREP_MINUTES_PER_TEAM + design.rounds * design.roundMinutes + 30) * 60_000);
}

export type StartOutcome = { ok: true; run: RunRecord } | { ok: false; status: number; reason: string };

/**
 * `POST …/start`, bound to the design the card showed: the card's hash must equal the hash of
 * `run.json`'s design now ("tasarım değişti" otherwise). Then, in one owner-route write, the base
 * SHA joins the design, the design and its hash are copied to `.conductor/design.json`, and the
 * run moves to `running`. The caller launches the conductor.
 */
export function ownerStart(contextRoot: string, runId: string, shownHash: string, o: { wsHome?: string; baseSha: (target: string) => string; usage: () => UsageReading | null; now?: () => Date }): StartOutcome {
  const cur = readRun(contextRoot, runId);
  if (!cur) return { ok: false, status: 404, reason: 'koşu yok' };
  if (cur.state !== 'awaiting-owner') return { ok: false, status: 409, reason: `koşu ${cur.state} durumunda` };
  if (designHash(cur) !== shownHash) return { ok: false, status: 409, reason: 'tasarım değişti' };
  let base: string;
  try { base = o.baseSha(cur.design.target); } catch { return { ok: false, status: 400, reason: 'hedef repo okunamadı' }; }
  const at = (o.now ?? (() => new Date()))();
  const usage = o.usage();
  const run = updateRun(contextRoot, runId, (r) => {
    if (r.state !== 'awaiting-owner' || designHash(r) !== shownHash) return null;
    // The end time counts from Başlat, never from the drafting: a card started the next morning
    // still gets every round (the weekly share ceiling stays the spending bound).
    const earliest = earliestEnd(r.design, at);
    const late = Date.parse(r.design.limit.endsAt) < earliest.getTime();
    const design = { ...r.design, baseSha: base, limit: late ? { ...r.design.limit, endsAt: earliest.toISOString() } : r.design.limit };
    const hash = designHash({ design });
    writeJsonAtomic(designCopyPath(runId, o.wsHome), { design, hash });
    const started = addMoment({ ...r, design, state: 'running', startedAt: at.toISOString(), startedHash: hash, usageAtStart: usage, phase: 'rounds', round: 1 }, 'sahip başlattı', at);
    return late ? addMoment(started, `bitiş başlangıca göre ${earliest.toISOString().slice(11, 16)} UTC oldu`, at) : started;
  });
  if (run.state !== 'running') return { ok: false, status: 409, reason: 'tasarım değişti' };
  return { ok: true, run };
}
