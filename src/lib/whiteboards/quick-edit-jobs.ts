/**
 * The quick edit's jobs (plan C1, Decision 11), in memory and keyed on (vault, board, id): one
 * runs per board and one more may wait; a third send is refused (`busy`). Machine-wide at most
 * {@link QUICK_MAX_RUNNING} run at once and {@link QUICK_MAX_PER_MINUTE} start a minute (per
 * server process). Every key has a death: a settled job lives {@link QUICK_JOB_TTL_MS}.
 *
 * Stop: before the apply starts, the child's process group is killed and the board is never
 * touched; once `applying`, the edit stands (one short locked write) and "Geri al" undoes it.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { executeClaudeDetached, type ClaudeExecution } from '../automations/runner.js';
import { accountEnvFor, listClaudeAccounts, resolveConfigDir } from '../claude-accounts.js';
import { ensureSandbox } from '../claude-account-sandbox.js';
import { chatSpawnAccount, signedOutAccounts } from '../automations/account.js';
import { findClaudeBin } from '../claude-path.js';
import { killPortable } from '../proc.js';
import { identityKey, mutateWhiteboard, readWhiteboard } from './store.js';
import {
  applyQuickEdit, buildAdds, expandScope, scopeTextLimit, parseQuickEditAnswer, quickEditArgs, quickEditInput, quickEditSystemPrompt,
  quickEditUserMessage, QuickEditRefusal, readJournal, writeJournal, QUICK_MODEL,
  type QuickArea, type QuickEditAnswer, type QuickJournalRecord,
} from './quick-edit.js';
import type { WhiteboardElement } from './widgets.js';
import { WhiteboardValidationError } from './errors.js';

export const QUICK_TIMEOUT_MS = 60_000;
export const QUICK_MAX_RUNNING = 3;
export const QUICK_MAX_PER_MINUTE = 30;
export const QUICK_JOB_TTL_MS = 10 * 60_000;

export type QuickJobState = 'queued' | 'running' | 'applying' | 'done' | 'failed' | 'stopped';
/** Why a job failed, as a code: the page words it in the owner's language (review r1). */
export type QuickFailCode = 'spawn' | 'timeout' | 'limit' | 'unreadable' | 'too_big' | 'refused' | 'write' | 'unrecorded';

export interface QuickJobView {
  state: QuickJobState;
  startedAt: string;
  reply?: string;
  notBoard?: boolean;
  outOfScope?: boolean;
  /** Only when the edit wrote something: what "Geri al" undoes. */
  edit?: { id: string; added: number; changed: number; skipped: string[] };
  /** Scope elements the owner changed while the edit ran: left as he made them. */
  skipped?: string[];
  elements?: WhiteboardElement[];
  /** A failed job's reason: `code` for the page, `error` a log line (never shown as is). */
  code?: QuickFailCode;
  error?: string;
  /** The answer asked for changes and none could be made: not a success. */
  nothing?: boolean;
  /** Asked-for changes that could not be made beside the ones that were. */
  dropped?: number;
  /** Measured, for the speed criterion: spawn → answer, and the whole job. */
  timing?: { modelMs: number; totalMs: number };
  costUsd?: number | null;
}

export interface QuickJobRequest {
  text: string;
  scope: { ids: string[]; identities: Record<string, string> } | null;
  area: QuickArea | null;
  selfOrigin?: string;
}

interface Job {
  key: string;
  boardKey: string;
  root: string;
  slug: string;
  id: string;
  req: QuickJobRequest;
  view: QuickJobView;
  child: ChildProcess | null;
  stopRequested: boolean;
  /** The board was written: a later failure must not say nothing changed. */
  committed: boolean;
  timer: NodeJS.Timeout | null;
  queuedAt: number;
}

type Exec = typeof executeClaudeDetached;

export interface QuickDeps {
  exec?: Exec;
  /** Skip the account lookup (tests): the env the child gets. */
  env?: Record<string, string | undefined>;
  now?: () => number;
  system?: () => string;
  /** Tests: the status answer and the process-group kill. */
  status?: () => QuickStatus;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

const jobs = new Map<string, Job>();
/** Per board: the running job's key, then the waiting one's. */
const lanes = new Map<string, string[]>();
const starts: number[] = [];
let deps: QuickDeps = {};

const boardKeyOf = (root: string, slug: string) => `${root}\u0000${slug}`;
const jobKeyOf = (root: string, slug: string, id: string) => `${root}\u0000${slug}\u0000${id}`;

/** Tests: swap the spawn, the env and the clock; reset clears every job. */
export function setQuickDepsForTests(d: QuickDeps): void { deps = d; }
export function resetQuickJobsForTests(): void {
  for (const j of jobs.values()) if (j.timer) clearTimeout(j.timer);
  jobs.clear();
  lanes.clear();
  starts.length = 0;
  deps = {};
}

let systemCache: string | null = null;
function systemPrompt(): string {
  if (deps.system) return deps.system();
  systemCache ??= quickEditSystemPrompt();
  return systemCache;
}

// ─── who can run it (C1 status) ───────────────────────────────────────────

export type QuickStatus = { ok: true } | { ok: false; reason: 'no_claude'; text: string };

/** Whether a quick edit can run on this Mac: Claude installed and an account signed in. Never names the account. */
export function quickEditStatus(home?: string): QuickStatus {
  if (deps.status) return deps.status();
  const no = (): QuickStatus => ({ ok: false, reason: 'no_claude', text: 'Hızlı düzenle Claude ister: bu Mac\'te oturum açılmış bir Claude hesabı yok.' });
  try {
    if (!findClaudeBin()) return no();
    const accounts = listClaudeAccounts(home);
    if (accounts.length > 0) {
      const out = signedOutAccounts(accounts, home ?? process.env.HOME ?? '', Date.now());
      if (accounts.every((a) => out.has(a.id))) return no();
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

// ─── start / read / stop ──────────────────────────────────────────────────

export type StartRefusal = { status: 409 | 429; error: 'busy' | 'rate'; message: string };

export function startQuickEdit(root: string, slug: string, req: QuickJobRequest): { ok: true; job: string } | ({ ok: false } & StartRefusal) {
  const now = (deps.now ?? Date.now)();
  const boardKey = boardKeyOf(root, slug);
  const lane = lanes.get(boardKey) ?? [];
  if (lane.length >= 2) return { ok: false, status: 409, error: 'busy', message: 'Bir düzenleme sırada; o bitince tekrar dene.' };
  while (starts.length && now - starts[0] >= 60_000) starts.shift();
  if (starts.length >= QUICK_MAX_PER_MINUTE) return { ok: false, status: 429, error: 'rate', message: `Dakikada en fazla ${QUICK_MAX_PER_MINUTE} hızlı düzenleme.` };
  if (lane.length === 0 && runningCount() >= QUICK_MAX_RUNNING) {
    return { ok: false, status: 429, error: 'rate', message: `Bu Mac'te aynı anda en fazla ${QUICK_MAX_RUNNING} hızlı düzenleme.` };
  }
  starts.push(now);
  const id = randomBytes(16).toString('base64url');
  const key = jobKeyOf(root, slug, id);
  const job: Job = {
    key, boardKey, root, slug, id, req, child: null, stopRequested: false, committed: false, timer: null, queuedAt: now,
    view: { state: 'queued', startedAt: new Date(now).toISOString() },
  };
  jobs.set(key, job);
  lane.push(key);
  lanes.set(boardKey, lane);
  // A safety net: the key dies even if nothing ever settles it.
  expireLater(job, QUICK_JOB_TTL_MS + QUICK_TIMEOUT_MS);
  if (lane.length === 1) void run(job);
  return { ok: true, job: id };
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  (deps.kill ?? killPortable)(pid, signal);
}

function runningCount(): number {
  let n = 0;
  for (const j of jobs.values()) if (j.view.state === 'running' || j.view.state === 'applying') n += 1;
  return n;
}

function expireLater(job: Job, ms = QUICK_JOB_TTL_MS): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => jobs.delete(job.key), ms);
  job.timer.unref?.();
}

/** The job's view, or null (another board, another vault, or gone). */
export function readQuickJob(root: string, slug: string, id: string): QuickJobView | null {
  return jobs.get(jobKeyOf(root, slug, id))?.view ?? null;
}

export function stopQuickJob(root: string, slug: string, id: string): QuickJobView | null {
  const job = jobs.get(jobKeyOf(root, slug, id));
  if (!job) return null;
  const s = job.view.state;
  if (s === 'applying') return { ...job.view, state: 'done' };
  if (s !== 'queued' && s !== 'running') return job.view;
  job.stopRequested = true;
  if (job.child?.pid) {
    try { killGroup(-job.child.pid, 'SIGTERM'); } catch { /* already gone */ }
    const pid = job.child.pid;
    setTimeout(() => { try { killGroup(-pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref?.();
  }
  settle(job, { state: 'stopped' });
  return job.view;
}

function settle(job: Job, patch: Partial<QuickJobView> & { state: QuickJobState }): void {
  if (['done', 'failed', 'stopped'].includes(job.view.state)) return;
  job.view = { ...job.view, ...patch };
  expireLater(job);
  const lane = lanes.get(job.boardKey) ?? [];
  const i = lane.indexOf(job.key);
  if (i >= 0) lane.splice(i, 1);
  if (lane.length === 0) lanes.delete(job.boardKey);
  else if (i === 0) {
    const next = jobs.get(lane[0]);
    if (next && next.view.state === 'queued') void run(next);
  }
}

function failed(job: Job, code: QuickFailCode, error: string): void {
  settle(job, { state: 'failed', code, error });
}

/**
 * The identity a scope element counts as untouched at. The page sends what it saw; an earlier
 * quick edit on this board (the one a queued send waited for) may have rewritten it since. When
 * the journal's chain of edits leads from what the page saw to what is on disk, nobody's hand
 * did it, and the disk's identity stands (review r1, edge-cases).
 */
export function untouchedIdentity(given: string, disk: string, id: string, records: readonly QuickJournalRecord[]): string {
  let cur = given;
  for (let hop = 0; hop < records.length && cur !== disk; hop++) {
    const next = records.find((r) => !r.undone && r.before[id] && identityKey(r.before[id]) === cur && typeof r.after[id] === 'string');
    if (!next) break;
    cur = next.after[id];
  }
  return cur === disk ? disk : given;
}

async function run(job: Job): Promise<void> {
  const t0 = (deps.now ?? Date.now)();
  job.view = { ...job.view, state: 'running', startedAt: new Date(t0).toISOString() };
  let cwd: string | null = null;
  try {
    // The board as it is now, and the scope grown from it (C3).
    const { board } = readWhiteboard(job.root, job.slug);
    const pageIds = job.req.scope?.ids ?? [];
    const scope = expandScope(board.elements, pageIds);
    const identities: Record<string, string> = {};
    const byId = new Map(board.elements.map((e) => [e.id, e]));
    let records: QuickJournalRecord[] | null = null;
    for (const id of scope) {
      const given = job.req.scope?.identities[id];
      const disk = identityKey(byId.get(id)!);
      if (typeof given !== 'string' || given === disk) { identities[id] = disk; continue; }
      records ??= readJournal(job.root, job.slug, job.req.selfOrigin);
      identities[id] = untouchedIdentity(given, disk, id, records);
    }
    const input = quickEditInput(board.elements, scope, job.req.area);
    const textLimit = scopeTextLimit(board.elements, scope);
    const args = quickEditArgs(systemPrompt(), quickEditUserMessage(job.req.text, input));
    cwd = mkdtempSync(join(tmpdir(), 'dc-quick-'));
    const exec = deps.exec ?? executeClaudeDetached;
    let env = deps.env;
    if (!env) {
      const dir = resolveConfigDir(chatSpawnAccount().id ?? null);
      ensureSandbox(dir);
      env = accountEnvFor(dir);
    }
    const tModel = (deps.now ?? Date.now)();
    const r: ClaudeExecution = await exec(args, {
      cwd,
      timeoutMs: QUICK_TIMEOUT_MS,
      env,
      onSpawned: (child) => {
        job.child = child;
        if (job.stopRequested && child.pid) { try { killGroup(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
      },
    });
    const modelMs = (deps.now ?? Date.now)() - tModel;
    if (job.stopRequested) return;
    if (!r.spawned) { failed(job, 'spawn', 'claude did not start'); return; }
    if (r.timedOut) { failed(job, 'timeout', `no answer in ${QUICK_TIMEOUT_MS / 1000} s`); return; }
    const parsed = parseQuickEditAnswer(r.stdout);
    if (!parsed.ok) {
      failed(job, parsed.reason === 'limit' ? 'limit' : 'unreadable', parsed.reason === 'limit' ? 'account limit' : 'answer not readable');
      job.view.costUsd = parsed.costUsd;
      return;
    }
    const answer = parsed.answer;
    if (answer.notBoard) {
      settle(job, { state: 'done', reply: answer.reply, notBoard: true, costUsd: parsed.costUsd, timing: { modelMs, totalMs: (deps.now ?? Date.now)() - t0 } });
      return;
    }
    // The drawings are built here, in a worker under a deadline, outside the board's lock.
    const built = await buildAdds(answer);
    if (job.stopRequested) return;
    job.view = { ...job.view, state: 'applying' };
    await apply(job, answer, scope, identities, built, textLimit, parsed.costUsd, { modelMs, t0 });
  } catch (err) {
    if (job.stopRequested) return;
    if (job.committed) failed(job, 'unrecorded', 'the board was written; its record was not');
    else if (err instanceof QuickEditRefusal) failed(job, err.code === 'too_big' ? 'too_big' : 'refused', err.message);
    else failed(job, err instanceof WhiteboardValidationError ? 'refused' : 'write', 'the edit was not written');
  } finally {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
}

async function apply(
  job: Job,
  answer: QuickEditAnswer,
  scope: string[],
  identities: Record<string, string>,
  built: WhiteboardElement[][],
  textLimit: number,
  costUsd: number | null,
  t: { modelMs: number; t0: number },
): Promise<void> {
  let outcome: ReturnType<typeof applyQuickEdit> | null = null;
  const recordId = randomBytes(16).toString('base64url');
  await mutateWhiteboard(job.root, job.slug, (board) => {
    outcome = applyQuickEdit(board, answer, { scope, identities, area: job.req.area, built, textLimit });
  }, {
    selfOrigin: job.req.selfOrigin,
    onCommitted: (res) => {
      if (!res.changed || !outcome || outcome.outOfScope) return;
      job.committed = true;
      const o = outcome;
      const written = new Map(res.board.elements.map((e) => [e.id, e]));
      const after: Record<string, string> = {};
      for (const id of [...o.added, ...o.changed]) { const el = written.get(id); if (el) after[id] = identityKey(el); }
      const rec: QuickJournalRecord = {
        id: recordId, at: new Date().toISOString(), text: job.req.text.slice(0, 2000), reply: answer.reply,
        added: o.added, changed: o.changed, before: o.before, after, costUsd, model: QUICK_MODEL, undone: false,
      };
      writeJournal(job.root, job.slug, [...readJournal(job.root, job.slug, job.req.selfOrigin), rec]);
    },
  });
  const o = outcome as ReturnType<typeof applyQuickEdit> | null;
  const timing = { modelMs: t.modelMs, totalMs: (deps.now ?? Date.now)() - t.t0 };
  if (!o) { failed(job, 'write', 'the edit was not written'); return; }
  if (o.outOfScope) {
    settle(job, { state: 'done', reply: answer.reply, outOfScope: true, costUsd, timing });
    return;
  }
  const wroteSomething = o.added.length + o.changed.length > 0;
  // The line follows what was written, not the model's sentence (review r1, edge-cases).
  if (!wroteSomething && o.skipped.length === 0) {
    settle(job, { state: 'done', reply: answer.reply, nothing: true, costUsd, timing });
    return;
  }
  // What the page reconciles at once: every element the edit wrote, as it landed on disk.
  const fresh = readWhiteboard(job.root, job.slug).board.elements;
  const ids = new Set(o.written.map((e) => e.id));
  settle(job, {
    state: 'done',
    reply: answer.reply,
    costUsd,
    timing,
    ...(wroteSomething ? { edit: { id: recordId, added: o.added.length, changed: o.changed.length, skipped: o.skipped } } : {}),
    ...(o.skipped.length ? { skipped: o.skipped } : {}),
    ...(o.dropped ? { dropped: o.dropped } : {}),
    elements: fresh.filter((e) => ids.has(e.id)),
  });
}
