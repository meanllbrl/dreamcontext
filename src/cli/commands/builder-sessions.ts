import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASE_FRAMING,
  BASE_ID,
  BASE_TOKEN_CAP,
  BUILDER_DEFAULT_EFFORT,
  BUILDER_DEFAULT_MODEL,
  BUILDER_EFFORTS,
  BuilderInputError,
  NEEDS_ATTENTION,
  WAIT_SLICE_MAX_S,
  assertLane,
  builderArgv,
  builderEnv,
  builderFraming,
  callsSince,
  contextTokens,
  developDir,
  emptyRegistry,
  fileSize,
  findTranscript,
  firstCallHit,
  logPath,
  normalizeOwns,
  ownsOverlap,
  rawConfigDir,
  readLogSince,
  readRegistry,
  registryPath,
  resolvedModel,
  sessionAlive,
  sessionStatus,
  waveOf,
  writeRegistryAtomic,
  type BaseRecord,
  type BuilderRegistry,
  type LaneRecord,
  type LaneStatus,
  type SessionMode,
  type SessionRecord,
} from '../../lib/builder-spawn.js';
import { HEAVY_DEFAULT_WAIT_S, HEAVY_LOCK_BUSY_EXIT, acquireHeavy, heavySlotDir, listProcesses, repoToplevel } from '../../lib/builder-tools.js';
import {
  ownerOf,
  parseTestReport,
  parseTscErrors,
  planChecks,
  readTestState,
  statePath,
  testArgv,
  writeTestState,
  type Failure,
  type TestPlan,
  type TestWave,
} from '../../lib/builder-test.js';
import { claudeAwarePath } from '../../lib/claude-path.js';
import { resolveContextRoot } from '../../lib/context-path.js';
import { acquireFileLockWithin, releaseFileLock } from '../../lib/file-lock.js';
import { today } from '../../lib/id.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import { goalLiveActor, type ActorOptions } from './goal-live.js';

/**
 * `dreamcontext builder base|spawn|fork|resume|wait|status`: the Develop lead starts and
 * tracks its builders through these instead of hand-written `nohup claude -p` lines, so every
 * session gets the same argv (src/lib/builder-spawn.ts), the registry stays consistent and the
 * lead blocks on ONE command instead of polling.
 *
 *   base <slug> --prompt-file f     mint the builder base (shared exploration, once per task)
 *   base <slug> --update f --wave N resume it with a wave's delta (write-ahead into the task log)
 *   spawn <slug> <lane> --owns ...  a fresh builder (single-lane work, or no base)
 *   fork <slug> <lane> --owns ...   a builder forked from the base (reads it from the cache)
 *   resume <slug> <lane> --message-file f   the same builder again, with exactly the findings
 *   wait <slug> [--any] [--lanes]   block until the sessions return: exit 0 all reported,
 *                                   4 still running (slice over), 5 something needs attention
 *   status <slug>                   one line per session, never blocks
 */

export const BUILDER_INPUT_EXIT = 2;
export const BUILDER_WAIT_RUNNING_EXIT = 4;
export const BUILDER_WAIT_ATTENTION_EXIT = 5;
export const BUILDER_CANARY_MISS_EXIT = 6;
/** A lane resumed this many times is not converging: the next one is the owner's call. */
export const MAX_RESUMES = 3;
const TICK_MS = 10_000;
/** A fork's first turn plans its whole lane from the context it inherited: measured at 3 min on a
 *  125k base. The canary waits up to one wait slice for it, and no first call is never a miss. */
const CANARY_MAX_MS = 540_000;

export interface SessionDeps {
  root: () => string;
  env: NodeJS.ProcessEnv;
  home?: string;
  now: () => number;
  uuid: () => string;
  ps: () => string;
  /** Start `claude` detached with stdout+stderr appended to `logFile`; returns its pid. */
  launch: (argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }) => number;
  logTask: (slug: string, line: string) => Promise<void>;
  goalLive: (spec: string, opts: ActorOptions) => void;
  sleep: (ms: number) => Promise<void>;
  /** Run `npx <argv>` in `cwd` holding the repo's heavy lock, output to `logFile`. The exit
   *  code, or null when NOTHING ran (lock stayed busy, could not start, killed by a signal). */
  runCheck: (argv: string[], cwd: string, logFile: string) => Promise<number | null>;
  print: (line: string) => void;
  printErr: (line: string) => void;
}

/** Why a builder cannot be launched here, or null. Windows has no `ps` for the liveness checks. */
export function builderLaunchRefusal(platform: NodeJS.Platform = process.platform): string | null {
  return platform === 'win32'
    ? 'builder sessions are not supported on Windows yet (they track liveness with ps); run the builders yourself or use Chat'
    : null;
}

function launchDetached(argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }): number {
  const refusal = builderLaunchRefusal();
  if (refusal) throw new BuilderInputError(refusal);
  const fd = openSync(o.logFile, 'a');
  try {
    const env = { ...o.env, PATH: claudeAwarePath(o.env.PATH ?? '') };
    const child = spawn('claude', argv, { cwd: o.cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    if (child.pid == null) throw new BuilderInputError('could not start claude (not on PATH?)');
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

async function runCheckLocked(argv: string[], cwd: string, logFile: string): Promise<number | null> {
  // The repo's heavy lock, then one of the machine's heavy slots (plan r5 D12).
  const held = await acquireHeavy(cwd, { waitMs: HEAVY_DEFAULT_WAIT_S * 1000, slotDir: heavySlotDir() });
  if (!held) return null;
  const fd = openSync(logFile, 'w');
  try {
    return await new Promise<number | null>((done) => {
      const child = spawn('npx', argv, { cwd, stdio: ['ignore', fd, fd] });
      child.on('error', () => done(null));
      child.on('exit', (code, signal) => done(signal ? null : code ?? null));
    });
  } finally {
    closeSync(fd);
    held.release();
  }
}

export const DEFAULT_SESSION_DEPS: SessionDeps = {
  root: () => repoToplevel(process.cwd()),
  env: process.env,
  now: () => Date.now(),
  uuid: () => randomUUID(),
  ps: listProcesses,
  launch: launchDetached,
  logTask: async (slug, line) => {
    await getTaskBackend().addChangelog(slug, `### ${today()} - Session Update\n- ${line}`, { createIfMissing: true });
  },
  goalLive: (spec, opts) => goalLiveActor({ resolveRoot: () => resolveContextRoot(), env: process.env, now: () => new Date() }, spec, opts),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  runCheck: runCheckLocked,
  print: (l) => process.stdout.write(`${l}\n`),
  printErr: (l) => process.stderr.write(`${l}\n`),
};

// ─── registry access ─────────────────────────────────────────────────────────

async function withRegistry<T>(root: string, slug: string, fn: (reg: BuilderRegistry) => T): Promise<T> {
  mkdirSync(developDir(root, slug), { recursive: true });
  const path = registryPath(root, slug);
  const lock = `${path}.lock`;
  const held = await acquireFileLockWithin(lock, { waitMs: 15_000, staleMs: 60_000, pollMs: 100, verifyPidLiveness: true });
  if (!held) throw new BuilderInputError(`the builder registry of ${slug} stayed locked for 15 s; run the command again`);
  try {
    const reg = readRegistry(path, slug);
    const out = fn(reg);
    writeRegistryAtomic(path, reg);
    return out;
  } finally {
    releaseFileLock(lock);
  }
}

function peekRegistry(root: string, slug: string): BuilderRegistry {
  const path = registryPath(root, slug);
  return existsSync(path) ? readRegistry(path, slug) : emptyRegistry(slug);
}

function readPrompt(file: string | undefined, flag: string): string {
  if (!file) throw new BuilderInputError(`${flag} <file> is required`);
  if (!existsSync(file)) throw new BuilderInputError(`${flag}: no file at ${file}`);
  const text = readFileSync(file, 'utf-8').trim();
  if (!text) throw new BuilderInputError(`${flag}: ${file} is empty`);
  return text;
}

function checkEffort(effort: string | undefined): string {
  const e = effort ?? BUILDER_DEFAULT_EFFORT;
  if (!(BUILDER_EFFORTS as readonly string[]).includes(e)) throw new BuilderInputError(`--effort must be one of ${BUILDER_EFFORTS.join(', ')}`);
  return e;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const kTok = (n: number) => `${Math.round(n / 1000)}k`;

async function logQuietly(deps: SessionDeps, slug: string, line: string): Promise<void> {
  try { await deps.logTask(slug, line); } catch (err) {
    deps.printErr(`task log not written (${err instanceof Error ? err.message : String(err)}): ${line}`);
  }
}

function goalLiveQuietly(deps: SessionDeps, spec: string, opts: ActorOptions): void {
  try { deps.goalLive(spec, opts); } catch (err) {
    deps.printErr(`goal-live: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── observing ───────────────────────────────────────────────────────────────

function transcriptCalls(deps: SessionDeps, rec: SessionRecord) {
  const t = findTranscript(rec.sid, rec.cfg, deps.home);
  if (!t) return { path: null, calls: [] };
  return { path: t, calls: callsSince(readFileSync(t, 'utf-8'), Date.parse(rec.startedAt)) };
}

function observe(deps: SessionDeps, root: string, slug: string, id: string, rec: SessionRecord, psText: string): LaneStatus {
  const t = findTranscript(rec.sid, rec.cfg, deps.home);
  let mtime: number | null = null;
  if (t) { try { mtime = statSync(t).mtimeMs; } catch { /* rotated away */ } }
  return sessionStatus(id, rec, {
    alive: sessionAlive(rec.pid, rec.sid, psText),
    logText: readLogSince(logPath(root, slug, id), rec.logOffset),
    transcriptMtimeMs: mtime,
    nowMs: deps.now(),
  });
}

/** The first call's cache read: proof (or not) that a fork inherited its base from the cache. */
function cacheNote(deps: SessionDeps, rec: SessionRecord): string {
  const hit = firstCallHit(transcriptCalls(deps, rec).calls);
  if (!hit) return '';
  const pct = Math.round(hit.share * 100);
  return ` | first call: ${kTok(hit.read)} read from cache, ${kTok(hit.write)} written (${pct}%${hit.share < 0.9 ? ', CACHE MISS' : ''})`;
}

function describe(deps: SessionDeps, s: LaneStatus, rec: SessionRecord | undefined): string {
  let extra = '';
  if (rec && s.id === BASE_ID) {
    const b = rec as BaseRecord;
    extra = ` | ${b.state}, ${b.tokens != null ? `${kTok(b.tokens)} tokens` : 'size unknown'}, absorbed through wave ${b.absorbedWave}, effort ${b.effort}`;
  } else if (rec) {
    const l = rec as LaneRecord;
    extra = ` | ${l.kind}, round ${l.round}, effort ${l.effort}${l.kind === 'fork' ? cacheNote(deps, rec) : ''}`;
  }
  return `${s.id} ${s.state}: ${s.detail}${extra}`;
}

/** A finished mint or update makes the base ready (or failed) and records its real size. */
function settleBase(deps: SessionDeps, root: string, slug: string, base: BaseRecord, status: LaneStatus): void {
  if (base.state !== 'minting' && base.state !== 'updating') return;
  if (status.state === 'running' || status.state === 'stalled') return;
  if (status.state !== 'reported') { base.state = 'failed'; return; }
  base.state = 'ready';
  base.model = resolvedModel(readLogSince(logPath(root, slug, BASE_ID), base.logOffset), base.model);
  base.tokens = contextTokens(transcriptCalls(deps, base).calls) ?? base.tokens;
  if (base.absorbing != null) { base.absorbedWave = base.absorbing; delete base.absorbing; }
}

async function settleAndMark(deps: SessionDeps, root: string, slug: string, statuses: LaneStatus[], markSeen: boolean): Promise<void> {
  await withRegistry(root, slug, (reg) => {
    for (const s of statuses) {
      if (s.id === BASE_ID && reg.base) settleBase(deps, root, slug, reg.base, s);
      const rec = s.id === BASE_ID ? reg.base : reg.lanes[s.id];
      if (markSeen && rec && s.state !== 'running') rec.seen = { round: rec.round, state: s.state, detail: s.detail };
    }
  });
}

// ─── wait ────────────────────────────────────────────────────────────────────

export async function builderWait(
  deps: SessionDeps, slug: string, opts: { lanes?: string; any?: boolean; maxWait?: string },
): Promise<number> {
  const root = deps.root();
  const maxS = opts.maxWait == null ? WAIT_SLICE_MAX_S : Number(opts.maxWait);
  if (!Number.isFinite(maxS) || maxS < 0) throw new BuilderInputError(`--max-wait must be seconds, got "${opts.maxWait}"`);
  const deadline = deps.now() + Math.min(maxS, WAIT_SLICE_MAX_S) * 1000;
  const named = opts.lanes ? opts.lanes.split(',').map((x) => x.trim()).filter(Boolean) : null;
  for (;;) {
    const reg = peekRegistry(root, slug);
    const recOf = (id: string): SessionRecord | undefined => (id === BASE_ID ? reg.base ?? undefined : reg.lanes[id]);
    const ids = named ?? [
      ...(reg.base && (reg.base.state === 'minting' || reg.base.state === 'updating') ? [BASE_ID] : []),
      ...Object.values(reg.lanes).filter((l) => l.seen?.round !== l.round).map((l) => l.lane),
    ];
    for (const id of ids) if (!recOf(id)) throw new BuilderInputError(`no session "${id}" in ${slug}'s registry`);
    if (ids.length === 0) {
      deps.print(`nothing to wait for: every session of ${slug} already reported (builder status ${slug} lists them)`);
      return 0;
    }
    const psText = deps.ps();
    const statuses = ids.map((id) => observe(deps, root, slug, id, recOf(id)!, psText));
    const running = statuses.filter((s) => s.state === 'running');
    const returned = statuses.filter((s) => s.state !== 'running');
    const done = opts.any ? returned.length > 0 : running.length === 0;
    const sliceOver = deps.now() >= deadline;
    if (done || sliceOver) {
      await settleAndMark(deps, root, slug, statuses, true);
      const fresh = peekRegistry(root, slug);
      for (const s of statuses) deps.print(describe(deps, s, s.id === BASE_ID ? fresh.base ?? undefined : fresh.lanes[s.id]));
      if (returned.some((s) => NEEDS_ATTENTION.includes(s.state))) return BUILDER_WAIT_ATTENTION_EXIT;
      if (!done) return BUILDER_WAIT_RUNNING_EXIT;
      return 0;
    }
    await deps.sleep(Math.min(TICK_MS, Math.max(0, deadline - deps.now())));
  }
}

export async function builderStatus(deps: SessionDeps, slug: string): Promise<number> {
  const root = deps.root();
  const reg = peekRegistry(root, slug);
  const psText = deps.ps();
  const statuses: LaneStatus[] = [];
  if (reg.base) statuses.push(observe(deps, root, slug, BASE_ID, reg.base, psText));
  for (const l of Object.values(reg.lanes)) statuses.push(observe(deps, root, slug, l.lane, l, psText));
  if (statuses.length === 0) { deps.print(`no builder sessions for ${slug} yet`); return 0; }
  await settleAndMark(deps, root, slug, statuses, false);
  const fresh = peekRegistry(root, slug);
  for (const s of statuses) deps.print(describe(deps, s, s.id === BASE_ID ? fresh.base ?? undefined : fresh.lanes[s.id]));
  return 0;
}

// ─── base ────────────────────────────────────────────────────────────────────

export async function builderBase(
  deps: SessionDeps, slug: string,
  opts: { promptFile?: string; update?: string; wave?: string; effort?: string; remint?: boolean; maxWait?: string },
): Promise<number> {
  const root = deps.root();
  const dir = developDir(root, slug);
  mkdirSync(dir, { recursive: true });
  const log = logPath(root, slug, BASE_ID);
  const psText = deps.ps();

  if (opts.update) {
    const delta = readPrompt(opts.update, '--update');
    const wave = opts.wave == null ? null : Number(opts.wave);
    if (wave != null && (!Number.isInteger(wave) || wave < 1)) throw new BuilderInputError(`--wave must be a wave number, got "${opts.wave}"`);
    const cur = peekRegistry(root, slug).base;
    if (!cur || cur.state !== 'ready') throw new BuilderInputError(`no ready base for ${slug} (${cur ? cur.state : 'none'}): mint one with --prompt-file first`);
    if (sessionAlive(cur.pid, cur.sid, psText)) throw new BuilderInputError('the base is still running; builder wait first');
    if (cur.tokens != null && cur.tokens > BASE_TOKEN_CAP) {
      throw new BuilderInputError(`the base holds ${kTok(cur.tokens)} tokens, over the ${kTok(BASE_TOKEN_CAP)} cap: every fork would re-read it on every turn. Mint a fresh one from the task doc with --remint --prompt-file <f>`);
    }
    // Write-ahead: the delta is on record before the base reads it, so a crash mid-update loses nothing.
    copyFileSync(opts.update, join(dir, `base-delta-r${cur.round + 1}.md`));
    await logQuietly(deps, slug, `base update${wave != null ? ` wave ${wave}` : ''} (write-ahead, base-delta-r${cur.round + 1}.md): ${oneLine(delta, 300)}`);
    await withRegistry(root, slug, (reg) => {
      const b = reg.base!;
      const offset = fileSize(log);
      const argv = builderArgv(delta, { kind: 'resume', sessionId: b.sid }, { model: b.model, effort: b.effort });
      b.pid = deps.launch(argv, { cwd: root, env: builderEnv(deps.env, b.cfg), logFile: log });
      Object.assign(b, { state: 'updating', round: b.round + 1, logOffset: offset, startedAt: new Date(deps.now()).toISOString() });
      if (wave != null) b.absorbing = wave;
      delete b.seen;
    });
    deps.print(`base updating${wave != null ? ` with wave ${wave}` : ''}`);
    return builderWait(deps, slug, { lanes: BASE_ID, maxWait: opts.maxWait });
  }

  const prompt = readPrompt(opts.promptFile, '--prompt-file');
  const effort = checkEffort(opts.effort);
  const cur = peekRegistry(root, slug).base;
  if (cur && !opts.remint && cur.state !== 'failed') {
    if (cur.state === 'ready') {
      deps.print(`base already ready: sid ${cur.sid}, ${cur.tokens != null ? kTok(cur.tokens) : '?'} tokens. Use --update to add a wave, or --remint to start over.`);
      return 0;
    }
    if (sessionAlive(cur.pid, cur.sid, psText)) return builderWait(deps, slug, { lanes: BASE_ID, maxWait: opts.maxWait });
  }
  if (cur && sessionAlive(cur.pid, cur.sid, psText)) throw new BuilderInputError('the current base is still running; builder wait first');
  const sid = deps.uuid();
  const cfg = rawConfigDir(deps.env);
  await withRegistry(root, slug, (reg) => {
    const offset = fileSize(log);
    const argv = builderArgv(`${BASE_FRAMING(slug)}\n\n${prompt}`, { kind: 'new', sessionId: sid }, { model: BUILDER_DEFAULT_MODEL, effort });
    const pid = deps.launch(argv, { cwd: root, env: builderEnv(deps.env, cfg), logFile: log });
    reg.base = {
      sid, pid, cfg, model: BUILDER_DEFAULT_MODEL, effort, round: 1, logOffset: offset,
      startedAt: new Date(deps.now()).toISOString(), state: 'minting', absorbedWave: 0, tokens: null,
    };
  });
  const base = peekRegistry(root, slug).base!;
  await logQuietly(deps, slug, `base minting sid ${sid} pid ${base.pid} cfg ${cfg} effort ${effort}`);
  deps.print(`base minting: sid ${sid} pid ${base.pid} (effort ${effort})`);
  const code = await builderWait(deps, slug, { lanes: BASE_ID, maxWait: opts.maxWait });
  const after = peekRegistry(root, slug).base;
  if (after?.state === 'ready' && after.tokens != null && after.tokens > BASE_TOKEN_CAP) {
    deps.printErr(`warning: the base holds ${kTok(after.tokens)} tokens, over the ${kTok(BASE_TOKEN_CAP)} cap; forks will re-read it on every turn. Give it a narrower reading list and --remint.`);
  }
  return code;
}

// ─── lanes ───────────────────────────────────────────────────────────────────

export interface LaneOptions { owns?: string[]; promptFile?: string; effort?: string; name?: string; canary?: boolean }

export async function builderLane(deps: SessionDeps, slug: string, lane: string, kind: 'fork' | 'fresh', opts: LaneOptions): Promise<number> {
  assertLane(lane);
  const root = deps.root();
  mkdirSync(developDir(root, slug), { recursive: true });
  const owns = normalizeOwns(root, opts.owns ?? []);
  if (owns.length === 0) throw new BuilderInputError('--owns <files...> is required: the files this lane alone may change');
  const prompt = readPrompt(opts.promptFile, '--prompt-file');
  if (kind === 'fork' && opts.effort) throw new BuilderInputError('a fork always runs at its base\'s effort (a different effort misses the cache)');
  const effort = checkEffort(opts.effort);
  const psText = deps.ps();
  const log = logPath(root, slug, lane);
  const wave = waveOf(lane);

  const outcome = await withRegistry(root, slug, (reg): { rec: LaneRecord; already: boolean } => {
    const existing = reg.lanes[lane];
    if (existing) {
      const alive = sessionAlive(existing.pid, existing.sid, psText);
      if (alive && existing.owns.join('\n') === owns.join('\n')) return { rec: existing, already: true };
      throw new BuilderInputError(alive
        ? `lane ${lane} is already running with other files`
        : `lane ${lane} already ran (round ${existing.round}); resume it: builder resume ${slug} ${lane} --message-file <f>`);
    }
    for (const other of Object.values(reg.lanes)) {
      const sameWave = wave != null ? waveOf(other.lane) === wave : sessionAlive(other.pid, other.sid, psText);
      const hits = sameWave ? ownsOverlap(owns, other.owns) : [];
      if (hits.length) throw new BuilderInputError(`lane ${lane} would share files with ${other.lane}: ${hits.join(', ')}. Lanes of one wave own disjoint files; coupled work is one lane.`);
    }
    let mode: SessionMode;
    let identity: { model: string; effort: string };
    let cfg: string;
    let parent: string | null = null;
    if (kind === 'fork') {
      const b = reg.base;
      if (!b || b.state !== 'ready') throw new BuilderInputError(`no ready base for ${slug} (${b ? b.state : 'none'}): builder base ${slug} --prompt-file <f>`);
      if (sessionAlive(b.pid, b.sid, psText)) throw new BuilderInputError('the base is still running; builder wait first');
      mode = { kind: 'fork', from: b.sid, sessionId: deps.uuid() };
      identity = { model: b.model, effort: b.effort };
      cfg = b.cfg; // the base's account: its transcript and its cache live there
      parent = b.sid;
    } else {
      mode = { kind: 'new', sessionId: deps.uuid() };
      identity = { model: BUILDER_DEFAULT_MODEL, effort };
      cfg = rawConfigDir(deps.env);
    }
    const offset = fileSize(log);
    const argv = builderArgv(`${builderFraming(lane, slug, kind)}\n\n${prompt}`, mode, identity);
    const pid = deps.launch(argv, { cwd: root, env: builderEnv(deps.env, cfg), logFile: log });
    const rec: LaneRecord = {
      lane, kind, parent, owns, sid: mode.sessionId, pid, cfg, model: identity.model, effort: identity.effort,
      round: 1, logOffset: offset, startedAt: new Date(deps.now()).toISOString(),
    };
    reg.lanes[lane] = rec;
    return { rec, already: false };
  });

  const { rec } = outcome;
  if (outcome.already) {
    deps.print(`${lane} is already running: sid ${rec.sid} pid ${rec.pid}`);
    return 0;
  }
  const base = kind === 'fork' && rec.parent ? ` (fork of base ${rec.parent})` : '';
  await logQuietly(deps, slug, `${lane} spawned sid ${rec.sid} pid ${rec.pid} cfg ${rec.cfg}${base}`);
  // A comma separates actors in a goal-live spec: one inside the name would split this lane into several.
  goalLiveQuietly(deps, `${lane}${opts.name ? `=${opts.name.replace(/,/g, ';')}` : ''}`, {
    kind: kind === 'fork' ? 'fork' : 'spawn', role: 'implementer', session: rec.sid,
    ...(wave != null ? { wave: String(wave) } : {}),
    ...(kind === 'fork' && rec.parent ? { contextOf: rec.parent } : {}),
  });
  deps.print(`${lane} ${kind === 'fork' ? 'forked from the base' : 'spawned'}: sid ${rec.sid} pid ${rec.pid}, owns ${rec.owns.length} path(s), effort ${rec.effort}`);
  if (kind === 'fork' && opts.canary) return canary(deps, rec);
  return 0;
}

/** Wait for a fork's first call and say whether it read the base from the cache. */
async function canary(deps: SessionDeps, rec: LaneRecord): Promise<number> {
  const until = deps.now() + CANARY_MAX_MS;
  while (deps.now() < until) {
    const hit = firstCallHit(transcriptCalls(deps, rec).calls);
    if (hit) {
      const pct = Math.round(hit.share * 100);
      if (hit.share >= 0.9) {
        deps.print(`canary ${rec.lane}: ${kTok(hit.read)} read from cache on the first call (${pct}%): fork the other lanes now`);
        return 0;
      }
      deps.print(`canary ${rec.lane}: CACHE MISS, ${kTok(hit.write)} written on the first call (${pct}% read). The lane keeps running; check model, effort and account before forking more.`);
      return BUILDER_CANARY_MISS_EXIT;
    }
    await deps.sleep(3000);
  }
  deps.print(`canary ${rec.lane}: no first call within ${CANARY_MAX_MS / 60_000} min: a long first turn, not a cache miss. builder status shows the read once it lands`);
  return BUILDER_WAIT_RUNNING_EXIT;
}

export async function builderResume(
  deps: SessionDeps, slug: string, lane: string, opts: { messageFile?: string; force?: boolean },
): Promise<number> {
  if (lane === BASE_ID) throw new BuilderInputError('the base is updated with: builder base <slug> --update <delta-file> --wave <n>');
  assertLane(lane);
  const root = deps.root();
  const message = readPrompt(opts.messageFile, '--message-file');
  const psText = deps.ps();
  const log = logPath(root, slug, lane);
  const rec = await withRegistry(root, slug, (reg) => {
    const l = reg.lanes[lane];
    if (!l) throw new BuilderInputError(`no lane ${lane} in ${slug}'s registry`);
    if (sessionAlive(l.pid, l.sid, psText)) throw new BuilderInputError(`${lane} is still running: wait for it, never resume a live session (two writers on one conversation)`);
    if (l.round > MAX_RESUMES && !opts.force) {
      throw new BuilderInputError(`${lane} was already resumed ${l.round - 1} times; a lane that does not converge goes to the owner (--force to override)`);
    }
    const offset = fileSize(log);
    const argv = builderArgv(message, { kind: 'resume', sessionId: l.sid }, { model: l.model, effort: l.effort });
    l.pid = deps.launch(argv, { cwd: root, env: builderEnv(deps.env, l.cfg), logFile: log });
    Object.assign(l, { round: l.round + 1, logOffset: offset, startedAt: new Date(deps.now()).toISOString() });
    return l;
  });
  await logQuietly(deps, slug, `${lane} resumed sid ${rec.sid} pid ${rec.pid} cfg ${rec.cfg} round ${rec.round}`);
  const wave = waveOf(lane);
  goalLiveQuietly(deps, lane, {
    kind: 'resume', role: 'implementer', session: rec.sid, round: String(rec.round),
    ...(wave != null ? { wave: String(wave) } : {}),
  });
  deps.print(`${lane} resumed: sid ${rec.sid} pid ${rec.pid}, round ${rec.round}`);
  return 0;
}

// ─── wave-end checks ─────────────────────────────────────────────────────────

export interface TestOptions { wave?: string; related?: string[]; failed?: boolean; also?: string[] }

const MAX_PRINTED_FAILURES = 25;

/**
 * The lead's wave-end check: type-check + related tests once, through the heavy lock. Exit 0
 * green, 1 failures (each with its key and owning lane), 75 when a check did not run at all.
 */
export async function builderTest(deps: SessionDeps, slug: string, opts: TestOptions): Promise<number> {
  const wave: TestWave = opts.wave === 'final' ? 'final' : Number(opts.wave);
  if (wave !== 'final' && (!Number.isInteger(wave) || wave < 1)) throw new BuilderInputError('--wave <n|final> is required');
  const root = deps.root();
  const dir = developDir(root, slug);
  mkdirSync(dir, { recursive: true });
  const sp = statePath(dir, wave);
  const state = readTestState(sp, wave);
  const related = normalizeOwns(root, opts.related ?? []);
  const also = normalizeOwns(root, opts.also ?? []);
  if (!opts.failed && related.length === 0 && also.length === 0) throw new BuilderInputError('give --related <changed files...> (and/or --also <test files>), or --failed');

  const plan: TestPlan = planChecks(root, related, also);
  if (opts.failed) {
    plan.tsc = [...new Set([...plan.tsc, ...state.tscFailed])].sort();
    for (const [pkg, files] of Object.entries(state.failedTests)) {
      const entry = plan.tests.find((t) => t.pkg === pkg);
      const relFiles = files.map((f) => (pkg === '.' ? f : f.slice(pkg.length + 1)));
      if (entry) entry.explicit.push(...relFiles.filter((f) => !entry.explicit.includes(f)));
      else {
        const fromPlan = planChecks(root, files);
        const t = fromPlan.tests.find((x) => x.pkg === pkg);
        if (t) plan.tests.push({ ...t, related: [], explicit: relFiles });
      }
    }
  }
  if (plan.tsc.length === 0 && plan.tests.length === 0) {
    deps.print(opts.failed ? `nothing failed in wave ${wave} last time` : 'no package or test runner found for these files');
    return 0;
  }

  const failures: Failure[] = [];
  const notRun: string[] = [];
  const ranTsc = new Set<string>();
  const tscFailedNow = new Set<string>();
  const ranTests = new Map<string, Set<string>>(); // pkg -> test files that ran
  const uncovered: string[] = [];
  const tag = (pkg: string) => (pkg === '.' ? 'root' : pkg.replace(/[^A-Za-z0-9]+/g, '-'));

  for (const pkg of plan.tsc) {
    const log = join(dir, `test-w${wave}-tsc-${tag(pkg)}.log`);
    const code = await deps.runCheck(['tsc', '--noEmit', '-p', 'tsconfig.json'], join(root, pkg), log);
    if (code == null) { notRun.push(`tsc ${pkg}`); continue; }
    ranTsc.add(pkg);
    const text = existsSync(log) ? readFileSync(log, 'utf-8') : '';
    const errs = parseTscErrors(text, pkg, root);
    if (code !== 0 && errs.length === 0) errs.push({ key: `tsc ${pkg} exit ${code}`, file: pkg, message: text.trim().split('\n')[0] ?? '' });
    failures.push(...errs);
    if (errs.length > 0) tscFailedNow.add(pkg);
    deps.print(`tsc ${pkg}: ${errs.length === 0 ? 'clean' : `${errs.length} error(s)`} (log ${relativeTo(root, log)})`);
  }

  for (const t of plan.tests) {
    for (const mode of ['related', 'explicit'] as const) {
      const files = t[mode];
      if (files.length === 0) continue;
      const out = join(dir, `test-w${wave}-${tag(t.pkg)}-${mode}.json`);
      const log = out.replace(/\.json$/, '.log');
      rmSync(out, { force: true });
      const code = await deps.runCheck(testArgv(t.runner, mode, files, out), join(root, t.pkg), log);
      const label = `${t.runner} ${mode === 'related' ? 'related' : 'run'} (${t.pkg})`;
      if (code == null) { notRun.push(label); continue; }
      if (!existsSync(out)) {
        failures.push({ key: `${label} exit ${code}: no report`, file: t.pkg, message: firstLogLine(log) });
        deps.print(`${label}: exit ${code}, no report (log ${relativeTo(root, log)})`);
        continue;
      }
      const report = parseTestReport(readFileSync(out, 'utf-8'), root);
      const ran = ranTests.get(t.pkg) ?? new Set<string>();
      for (const f of report.files) ran.add(f);
      if (mode === 'explicit') {
        // Asked for by name: whatever the report does not list has no tests any more (a fix
        // deleted or renamed it), so it leaves the failed set instead of pinning it red.
        for (const f of files) {
          const repoRel = t.pkg === '.' ? f : `${t.pkg}/${f}`;
          if (!report.files.includes(repoRel)) deps.print(`${label}: ${repoRel} ran no tests (deleted or renamed?)`);
          ran.add(repoRel);
        }
      }
      ranTests.set(t.pkg, ran);
      failures.push(...report.failures);
      if (code !== 0 && report.failures.length === 0) {
        // vitest exits 1 on an unhandled error even when every test passed.
        failures.push({ key: `${label} exit ${code} with no failing test`, file: t.pkg, message: firstLogLine(log) });
      }
      if (mode === 'related' && report.total === 0) {
        uncovered.push(...files.map((f) => (t.pkg === '.' ? f : `${t.pkg}/${f}`)));
        deps.print(`${label}: NO COVERAGE, no test imports ${files.join(', ')}`);
      } else {
        deps.print(`${label}: ${report.total} test(s), ${report.failures.length} failed${code !== 0 && report.failures.length === 0 ? `, exit ${code}` : ''} (log ${relativeTo(root, log)})`);
      }
    }
  }

  // State: what ran this time replaces its earlier status; what did not run keeps it.
  state.runs += 1;
  state.tscFailed = [...new Set([...state.tscFailed.filter((p) => !ranTsc.has(p)), ...tscFailedNow])].sort();
  for (const [pkg, ran] of ranTests) {
    const keep = (state.failedTests[pkg] ?? []).filter((f) => !ran.has(f));
    const now = failures.filter((f) => !f.key.startsWith('tsc ') && ran.has(f.file)).map((f) => f.file);
    const all = [...new Set([...keep, ...now])].sort();
    if (all.length) state.failedTests[pkg] = all; else delete state.failedTests[pkg];
  }
  for (const f of failures) state.seen[f.key] = (state.seen[f.key] ?? 0) + 1;

  // A lead that builds alone has no lanes: its failures are its own, so no owner is printed.
  const lanes = Object.values(peekRegistry(root, slug).lanes);
  for (const f of failures.slice(0, MAX_PRINTED_FAILURES)) {
    const again = state.seen[f.key] >= 2 ? ` [FAILED ${state.seen[f.key]}x: after a fix this goes to the owner]` : '';
    if (lanes.length === 0) { deps.print(`FAIL: ${f.key}${again}`); continue; }
    const owner = ownerOf(f.file, lanes);
    deps.print(`FAIL ${owner ?? `? (no lane owns ${f.file})`}: ${f.key}${again}`);
  }
  if (failures.length > MAX_PRINTED_FAILURES) deps.print(`... and ${failures.length - MAX_PRINTED_FAILURES} more (see the logs above)`);
  for (const n of notRun) deps.print(`NOT RUN: ${n} (heavy lock busy, could not start, or killed): run the same command again`);

  const remaining = state.tscFailed.length > 0 || Object.keys(state.failedTests).length > 0;
  if (failures.length === 0 && notRun.length === 0 && !remaining) {
    rmSync(sp, { force: true });
    deps.print(uncovered.length === 0
      ? `wave ${wave}: GREEN`
      : `wave ${wave}: nothing failed, but NOT GREEN: no test covers ${uncovered.join(', ')}. Add --also <test files>, or say in the report that it is untested`);
    return 0;
  }
  writeTestState(sp, state);
  if (failures.length > 0 || remaining) return 1;
  return HEAVY_LOCK_BUSY_EXIT;
}

const relativeTo = (root: string, p: string) => p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
function firstLogLine(log: string): string {
  try { return readFileSync(log, 'utf-8').trim().split('\n').slice(-1)[0] ?? ''; } catch { return ''; }
}

// ─── commander wiring ────────────────────────────────────────────────────────

function run(deps: SessionDeps, action: () => Promise<number>): Promise<void> {
  return action().then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      deps.printErr(`builder: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = BUILDER_INPUT_EXIT;
    },
  );
}

export function registerBuilderSessionCommands(cmd: Command, deps: SessionDeps = DEFAULT_SESSION_DEPS): void {
  cmd
    .command('base')
    .argument('<slug>', 'The task slug')
    .option('--prompt-file <file>', 'Mint: what the base reads (the task doc and the code every lane touches)')
    .option('--update <file>', 'Resume the ready base with this delta (what a wave landed), write-ahead into the task log')
    .option('--wave <n>', 'With --update: the wave the delta closes')
    .option('--effort <level>', `Mint only: ${BUILDER_EFFORTS.join('|')} (default ${BUILDER_DEFAULT_EFFORT}); forks reuse it`)
    .option('--remint', 'Replace the current base with a fresh one')
    .option('--max-wait <seconds>', `How long to block for it (max ${WAIT_SLICE_MAX_S})`)
    .description(`Mint or update the builder base every fork reads from cache (capped at ${kTok(BASE_TOKEN_CAP)} tokens)`)
    .action((slug: string, opts: { promptFile?: string; update?: string; wave?: string; effort?: string; remint?: boolean; maxWait?: string }) =>
      run(deps, () => builderBase(deps, slug, opts)));

  for (const kind of ['spawn', 'fork'] as const) {
    cmd
      .command(kind)
      .argument('<slug>', 'The task slug')
      .argument('<lane>', 'Wave-qualified lane id, e.g. w1-A')
      .requiredOption('--owns <paths...>', 'The files (or directories) only this lane may change')
      .requiredOption('--prompt-file <file>', 'The lane brief')
      .option('--name <text>', 'What it builds, for the live map')
      .option(kind === 'spawn' ? '--effort <level>' : '--canary', kind === 'spawn'
        ? `${BUILDER_EFFORTS.join('|')} (default ${BUILDER_DEFAULT_EFFORT})`
        : `Wait for the first call and report the cache read (exit ${BUILDER_CANARY_MISS_EXIT} on a miss, ${BUILDER_WAIT_RUNNING_EXIT} when none landed in ${CANARY_MAX_MS / 60_000} min)`)
      .description(kind === 'spawn'
        ? 'Start a fresh builder for one lane (detached; returns at once)'
        : 'Start a builder forked from the base, so it starts knowing what the base read (detached)')
      .action((slug: string, lane: string, opts: LaneOptions) =>
        run(deps, () => builderLane(deps, slug, lane, kind === 'fork' ? 'fork' : 'fresh', opts)));
  }

  cmd
    .command('resume')
    .argument('<slug>', 'The task slug')
    .argument('<lane>', 'The lane id')
    .requiredOption('--message-file <file>', 'Exactly the findings or failing output, nothing else')
    .option('--force', `Resume past ${MAX_RESUMES} rounds`)
    .description('Resume the same builder (detached): it fixes and again runs no tests')
    .action((slug: string, lane: string, opts: { messageFile?: string; force?: boolean }) =>
      run(deps, () => builderResume(deps, slug, lane, opts)));

  cmd
    .command('wait')
    .argument('<slug>', 'The task slug')
    .option('--lanes <ids>', 'Comma-separated ids (default: every session whose result was not reported yet)')
    .option('--any', 'Return as soon as one of them returns')
    .option('--max-wait <seconds>', `Block at most this long (max and default ${WAIT_SLICE_MAX_S})`)
    .description(`Block until builders return: exit 0 all reported, ${BUILDER_WAIT_RUNNING_EXIT} still running, ${BUILDER_WAIT_ATTENTION_EXIT} one needs attention`)
    .action((slug: string, opts: { lanes?: string; any?: boolean; maxWait?: string }) =>
      run(deps, () => builderWait(deps, slug, opts)));

  cmd
    .command('test')
    .argument('<slug>', 'The task slug')
    .requiredOption('--wave <n|final>', 'The wave being checked, or final for the run-end check (failures are tracked per wave)')
    .option('--related <files...>', 'Changed files: type-check their packages and run the tests that import them')
    .option('--failed', 'Re-run only what failed last time (plus --related when given)')
    .option('--also <tests...>', 'Test files related cannot see (they read files by path)')
    .description(`Wave-end check through the heavy lock: exit 0 green, 1 failures (key + owning lane), ${HEAVY_LOCK_BUSY_EXIT} a check did not run`)
    .action((slug: string, opts: TestOptions) => run(deps, () => builderTest(deps, slug, opts)));

  cmd
    .command('status')
    .argument('<slug>', 'The task slug')
    .description('One line per builder session of the task (never blocks)')
    .action((slug: string) => run(deps, () => builderStatus(deps, slug)));
}
