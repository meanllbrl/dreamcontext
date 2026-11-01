/**
 * `dc.ask(text)`: an app's backend asks its assistant one question and reads the answer (plan r9,
 * D14). One call for both kinds of assistant. The own assistant's answer is one headless `claude -p`
 * that leaves nothing behind: no session (`--no-session-persistence`, the `runLeavesNoSession`
 * rule), so no record, no history and nothing to resume.
 *
 * READ-ONLY. It reads the app's folder and nothing else: `dontAsk` refuses what is not listed, and
 * the whole light-job deny list (Bash included) outranks any allow rule. No action runs from here;
 * a backend already calls its own routes, so it puts the facts in the text.
 *
 * Jobs live in memory and every key has a death: read once, or a TTL.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { accountEnvFor, resolveConfigDir } from '../claude-accounts.js';
import { ensureSandbox } from '../claude-account-sandbox.js';
import { chatSpawnAccount } from '../automations/account.js';
import { CREDENTIAL_ANYWHERE, credentialReadDenies } from '../automations/board-scope.js';
import { LIGHT_DEFAULT_MODEL, LIGHT_DISALLOWED_TOOLS } from '../automations/light-run.js';
import { buildAppAskBlock, executeClaudeDetached, newTurnNonce, sanitizeAutomationPrompt, type ClaudeExecution } from '../automations/runner.js';
import { APP_CREDENTIAL_FILES, ROLE_MAX_CHARS } from './assistant.js';
import { appRunBrief } from './brief.js';
import { ROLE_FILE, roleFileProblem } from './manifest.js';
import type { AppRecord } from './registry.js';
import { readFileSync } from 'node:fs';

export const ASK_TIMEOUT_MS = 120_000;
export const ASK_MAX_PER_APP = 3;
export const ASK_MAX_MACHINE = 6;
export const ASK_MAX_PER_MINUTE = 20;
const ASK_TEXT_MAX = 8000;
const JOB_TTL_MS = 5 * 60_000;

export type AskState =
  | { state: 'running' }
  | { state: 'done'; answer: string }
  | { state: 'failed'; code: string; message: string };

interface Job {
  hash: string;
  value: AskState;
  timer: NodeJS.Timeout | null;
}

const jobs = new Map<string, Job>();
const recent = new Map<string, number[]>();

function runningOf(hash?: string): number {
  let n = 0;
  for (const j of jobs.values()) if (j.value.state === 'running' && (!hash || j.hash === hash)) n += 1;
  return n;
}

export type AskRefusal = { code: string; message: string; status: 400 | 409 | 429 };

/** The rate and concurrency gate, shared by both kinds. Null while there is room. */
export function askRoom(hash: string, now = Date.now(), memberRunning = 0): AskRefusal | null {
  if (runningOf(hash) + memberRunning >= ASK_MAX_PER_APP) return { status: 429, code: 'ask_busy', message: `At most ${ASK_MAX_PER_APP} questions at once per app.` };
  if (runningOf() >= ASK_MAX_MACHINE) return { status: 429, code: 'ask_busy', message: `At most ${ASK_MAX_MACHINE} questions at once on this Mac.` };
  const window = (recent.get(hash) ?? []).filter((t) => now - t < 60_000);
  if (window.length >= ASK_MAX_PER_MINUTE) return { status: 429, code: 'ask_rate', message: `At most ${ASK_MAX_PER_MINUTE} questions a minute.` };
  window.push(now);
  recent.set(hash, window);
  return null;
}

function expireLater(id: string, job: Job): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => jobs.delete(id), JOB_TTL_MS);
  job.timer.unref?.();
}

function settle(id: string, job: Job, value: AskState): void {
  job.value = value;
  expireLater(id, job);
}

/** The own assistant's closed envelope: its folder to read, nothing else. */
export function appAskArgs(prompt: string, appRoot: string, home?: string): string[] {
  const scope = `/${appRoot}/**`;
  return [
    '-p', prompt,
    '--model', LIGHT_DEFAULT_MODEL,
    '--output-format', 'json',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
    '--setting-sources', '',
    '--allowedTools', `Read(${scope})`, `Grep(${scope})`, `Glob(${scope})`,
    '--disallowedTools', ...LIGHT_DISALLOWED_TOOLS,
    ...credentialReadDenies(home),
    ...[...CREDENTIAL_ANYWHERE, ...APP_CREDENTIAL_FILES].map((g) => `Read(//${g})`),
  ];
}

type Exec = typeof executeClaudeDetached;

export function startOwnAsk(rec: AppRecord, text: string, opts: { home?: string; exec?: Exec } = {}): { ok: true; id: string } | ({ ok: false } & AskRefusal) {
  const home = opts.home ?? homedir();
  const q = text.trim();
  if (!q || q.length > ASK_TEXT_MAX) return { ok: false, status: 400, code: 'bad_ask', message: `Say something, under ${ASK_TEXT_MAX} characters.` };
  const app = appRunBrief(rec.projectRoot, rec.slug, home);
  if (!app) return { ok: false, status: 409, code: 'not_ready', message: 'The manifest cannot be read.' };
  if (roleFileProblem(rec.root)) return { ok: false, status: 409, code: 'no_role', message: `${ROLE_FILE} is missing or not a plain file.` };
  const room = askRoom(rec.hash);
  if (room) return { ok: false, ...room };
  const role = sanitizeAutomationPrompt(readFileSync(join(rec.root, ROLE_FILE), 'utf-8')).trim().slice(0, ROLE_MAX_CHARS);
  const prompt = sanitizeAutomationPrompt(`${role}\n\n${buildAppAskBlock(q, app, newTurnNonce())}`);
  const dir = resolveConfigDir(chatSpawnAccount().id ?? null);
  ensureSandbox(dir);
  const id = randomUUID();
  const job: Job = { hash: rec.hash, value: { state: 'running' }, timer: null };
  jobs.set(id, job);
  // Safety net for a child that never reports: the key still dies.
  expireLater(id, job);
  const exec = opts.exec ?? executeClaudeDetached;
  void exec(appAskArgs(prompt, rec.root, home), { cwd: rec.root, timeoutMs: ASK_TIMEOUT_MS, env: accountEnvFor(dir) })
    .then((r: ClaudeExecution) => {
      const answer = askAnswer(r);
      settle(id, job, answer === null
        ? { state: 'failed', code: r.timedOut ? 'ask_timeout' : 'ask_failed', message: r.timedOut ? 'The assistant took too long.' : 'The assistant did not answer.' }
        : { state: 'done', answer });
    })
    .catch(() => settle(id, job, { state: 'failed', code: 'ask_failed', message: 'The assistant did not answer.' }));
  return { ok: true, id };
}

function askAnswer(r: ClaudeExecution): string | null {
  if (!r.spawned || r.timedOut || r.exitCode !== 0) return null;
  try {
    const doc = JSON.parse(r.stdout) as { result?: unknown; is_error?: unknown };
    return typeof doc.result === 'string' && doc.is_error !== true ? doc.result : null;
  } catch {
    return null;
  }
}

/** What a poll sees; a settled job is read once and goes. Another app's id reads as gone. */
export function readOwnAsk(hash: string, id: string): AskState | null {
  const job = jobs.get(id);
  if (!job || job.hash !== hash) return null;
  if (job.value.state !== 'running') {
    if (job.timer) clearTimeout(job.timer);
    jobs.delete(id);
  }
  return job.value;
}

/** Tests: nothing outlives a case. */
export function resetAppAsksForTests(): void {
  for (const j of jobs.values()) if (j.timer) clearTimeout(j.timer);
  jobs.clear();
  recent.clear();
}
