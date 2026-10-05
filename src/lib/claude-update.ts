import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeAwarePath } from './claude-path.js';
import { compareVersions } from './version-check.js';

/**
 * Keeping the Claude Code CLI up to date for a user who only ever drives it through us.
 *
 * Claude Code's own updater lives in its interactive TUI (AutoUpdaterWrapper). Every claude
 * spawn dreamcontext makes is headless (`claude -p`), so a user who lives in the app never runs
 * that updater and their CLI silently freezes on an old version (and old models). This module
 * is the replacement: compare the installed version against the npm dist-tag of the user's
 * channel, run `claude update` when behind, and record the outcome machine-wide in
 * ~/.dreamcontext/claude-update.json so every server and window agree.
 *
 * `claude update` itself IGNORES DISABLE_AUTOUPDATER, so the opt-out is honoured HERE, mirroring
 * the CLI's own check. A forced run (the Update now button) skips the opt-out: the user clicked.
 */

export type ClaudeUpdateChannel = 'latest' | 'stable';
export type ClaudeUpdateState = 'current' | 'outdated' | 'updating' | 'updated' | 'failed' | 'disabled' | 'unknown';

/** The `capabilities.claudeUpdate` contract the dashboard renders. */
export interface ClaudeUpdateStatus {
  installed: string | null;
  latest: string | null;
  channel: ClaudeUpdateChannel;
  outdated: boolean;
  state: ClaudeUpdateState;
  disabledBy?: string;
  error?: string;
  checkedAt?: number;
  updateCommand: string;
}

/** What ~/.dreamcontext/claude-update.json holds. */
export interface ClaudeUpdateRecord {
  checkedAt: number;
  installed: string | null;
  latest: string | null;
  channel: ClaudeUpdateChannel;
  state: ClaudeUpdateState;
  disabledBy?: string;
  /** Last 4 non-empty output lines of a failed `claude update`. */
  error?: string;
  lastAttemptAt?: number;
  from?: string;
  to?: string;
}

export interface ClaudeUpdateRunResult {
  code: number | null;
  output: string;
}

export interface ClaudeUpdateDeps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Wall-clock ms: the record is shared across processes, so not a monotonic clock. */
  now?: () => number;
  fetch?: typeof fetch;
  /** Run a shell script, resolving (never rejecting) with its exit code and combined output. */
  run?: (script: string, timeoutMs: number) => Promise<ClaudeUpdateRunResult>;
  intervalMs?: number;
}

export interface ClaudeUpdateCheckResult {
  ok: boolean;
  /** False when the check was skipped (throttled) and nothing was probed. */
  ran: boolean;
  message: string;
  record: ClaudeUpdateRecord | null;
}

export const CLAUDE_UPDATE_COMMAND = 'claude update';
export const CLAUDE_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
export const CLAUDE_UPDATE_TIMEOUT_MS = 5 * 60_000;
const VERSION_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 5_000;
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags';
const OPT_OUT_KEYS = ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES'] as const;
/** A persisted 'updating' older than this is a crashed run, not a live one. */
const STALE_UPDATING_MS = CLAUDE_UPDATE_TIMEOUT_MS + 60_000;

const VERSION_RE = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/;

/**
 * The version in `claude --version` output ('2.1.284 (Claude Code)'), or null. Login-shell rc
 * noise can precede it (nvm's "Now using node v20.1.0"), so the '(Claude Code)' line wins, then
 * the last non-empty line.
 */
export function parseClaudeVersion(output: string): string | null {
  if (typeof output !== 'string') return null;
  const tagged = output.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*\(Claude Code\)/);
  if (tagged) return tagged[1];
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  const m = last?.match(new RegExp(`^${VERSION_RE.source}$`));
  return m ? m[1] : null;
}

/** The CLI's own reading of an env flag: set, non-empty, and not '0' / 'false'. */
function isTruthyFlag(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  const s = String(value).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false';
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Why the user opted out of updates, or null. Mirrors the CLI's own disable check: DISABLE_UPDATES
 * or DISABLE_AUTOUPDATER in the process env or in ~/.claude/settings.json "env", or
 * `autoUpdates: false` in ~/.claude.json unless a native install protects itself
 * (installMethod 'native' + autoUpdatesProtectedForNative). Reads the PRIMARY account under
 * `home`, never a CLAUDE_CONFIG_DIR sandbox.
 */
export function readUpdateOptOut(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of OPT_OUT_KEYS) {
    if (isTruthyFlag(env[key])) return `${key} in the environment`;
  }
  const settingsEnv = readJsonObject(join(home, '.claude', 'settings.json'))?.env;
  if (settingsEnv && typeof settingsEnv === 'object') {
    for (const key of OPT_OUT_KEYS) {
      if (isTruthyFlag((settingsEnv as Record<string, unknown>)[key])) return `${key} in ~/.claude/settings.json`;
    }
  }
  const config = readJsonObject(join(home, '.claude.json'));
  if (config?.autoUpdates === false && !(config.installMethod === 'native' && config.autoUpdatesProtectedForNative === true)) {
    return 'autoUpdates: false in ~/.claude.json';
  }
  return null;
}

/**
 * The version probe, which also echoes both opt-out variables as the user's LOGIN shell sees
 * them. The desktop server is started by Tauri with only DREAMCONTEXT_* vars, so an
 * `export DISABLE_AUTOUPDATER=1` in ~/.zshrc (where users usually put it) is invisible to
 * process.env; the shell we already spawn for `claude --version` reads it for free.
 */
export const CLAUDE_VERSION_SCRIPT = `printf 'DA=%s DU=%s\\n' "$DISABLE_AUTOUPDATER" "$DISABLE_UPDATES"; claude --version`;

/** The opt-out the probe's shell reported (the DA=/DU= line of CLAUDE_VERSION_SCRIPT), or null. */
export function parseShellOptOut(output: string): string | null {
  const m = typeof output === 'string' ? output.match(/^DA=(.*?) DU=(.*)$/m) : null;
  if (!m) return null;
  if (isTruthyFlag(m[1])) return 'DISABLE_AUTOUPDATER in your shell profile';
  if (isTruthyFlag(m[2])) return 'DISABLE_UPDATES in your shell profile';
  return null;
}

const SHELL_OPT_OUT_SUFFIX = ' in your shell profile';

/** settings.autoUpdatesChannel: 'stable' when set so, else the CLI default 'latest'. */
export function readUpdateChannel(home: string = homedir()): ClaudeUpdateChannel {
  return readJsonObject(join(home, '.claude', 'settings.json'))?.autoUpdatesChannel === 'stable' ? 'stable' : 'latest';
}

/** The npm dist-tag version for `channel`, or null on any failure (offline, timeout, garbage). */
export async function fetchLatestClaudeVersion(
  channel: ClaudeUpdateChannel,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(DIST_TAGS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const tags = await res.json() as Record<string, unknown> | null;
    const tag = tags?.[channel];
    return typeof tag === 'string' ? parseClaudeVersion(tag) : null;
  } catch {
    return null;
  }
}

// ─── State file ────────────────────────────────────────────────────────────────

export function claudeUpdateStatePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'claude-update.json');
}

const STATES: readonly ClaudeUpdateState[] = ['current', 'outdated', 'updating', 'updated', 'failed', 'disabled', 'unknown'];
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const versionOrNull = (v: unknown): string | null => (typeof v === 'string' ? parseClaudeVersion(v) : null);

/** The persisted record, or null when missing or not the shape we write. */
export function readClaudeUpdateRecord(home: string = homedir()): ClaudeUpdateRecord | null {
  const raw = readJsonObject(claudeUpdateStatePath(home));
  if (!raw) return null;
  const checkedAt = optNum(raw.checkedAt);
  const state = STATES.includes(raw.state as ClaudeUpdateState) ? raw.state as ClaudeUpdateState : null;
  if (checkedAt === undefined || !state) return null;
  const rec: ClaudeUpdateRecord = {
    checkedAt,
    installed: versionOrNull(raw.installed),
    latest: versionOrNull(raw.latest),
    channel: raw.channel === 'stable' ? 'stable' : 'latest',
    state,
  };
  const disabledBy = optStr(raw.disabledBy);
  const error = optStr(raw.error);
  const lastAttemptAt = optNum(raw.lastAttemptAt);
  const from = optStr(raw.from);
  const to = optStr(raw.to);
  if (disabledBy) rec.disabledBy = disabledBy;
  if (error) rec.error = error;
  if (lastAttemptAt !== undefined) rec.lastAttemptAt = lastAttemptAt;
  if (from) rec.from = from;
  if (to) rec.to = to;
  return rec;
}

/** Write tmp + rename so a concurrent reader never sees half a file. Never throws. */
export function writeClaudeUpdateRecord(home: string, record: ClaudeUpdateRecord): void {
  const path = claudeUpdateStatePath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* unwritable home: the next check simply runs again */
  }
}

// ─── Status (the capabilities path: files only, no network, no spawn) ──────────

const isBehind = (installed: string | null, latest: string | null): boolean =>
  !!installed && !!latest && compareVersions(installed, latest) < 0;

/**
 * `capabilities.claudeUpdate`, from the state file alone. 'updating' while a run is in flight in
 * this process (or a recent one is recorded by another); 'disabled' = behind, but the user opted
 * out (re-read live, so flipping the setting shows at once); 'unknown' = no installed or no latest
 * version. Never throws.
 */
export function readClaudeUpdateStatus(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): ClaudeUpdateStatus {
  const base = { updateCommand: CLAUDE_UPDATE_COMMAND };
  try {
    const rec = readClaudeUpdateRecord(home);
    const channel = rec?.channel ?? readUpdateChannel(home);
    const installed = rec?.installed ?? null;
    const latest = rec?.latest ?? null;
    const outdated = isBehind(installed, latest);
    const status: ClaudeUpdateStatus = { ...base, installed, latest, channel, outdated, state: 'unknown' };
    if (rec) status.checkedAt = rec.checkedAt;
    const recentlyUpdating = rec?.state === 'updating' && now - (rec.lastAttemptAt ?? rec.checkedAt) < STALE_UPDATING_MS;
    if (inFlight || recentlyUpdating) {
      status.state = 'updating';
    } else if (!installed || !latest) {
      status.state = 'unknown';
    } else if (rec?.state === 'failed' && outdated) {
      status.state = 'failed';
      if (rec.error) status.error = rec.error;
    } else if (outdated) {
      // A shell-profile opt-out is only visible to the job's probe, so it rides in the record.
      const recordedShell = rec?.state === 'disabled' && rec.disabledBy?.endsWith(SHELL_OPT_OUT_SUFFIX) ? rec.disabledBy : null;
      const disabledBy = readUpdateOptOut(home, env) ?? recordedShell;
      status.state = disabledBy ? 'disabled' : 'outdated';
      if (disabledBy) status.disabledBy = disabledBy;
    } else {
      status.state = rec?.state === 'updated' ? 'updated' : 'current';
    }
    return status;
  } catch {
    return { ...base, installed: null, latest: null, channel: 'latest', outdated: false, state: 'unknown' };
  }
}

// ─── The check + update run ─────────────────────────────────────────────────────

/** Spawned env: the user's login shell sees `claude` (claudeAwarePath) and no tab/session identity. */
function updateEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, PATH: claudeAwarePath(env.PATH ?? '') };
  delete out.CLAUDE_CODE_SESSION_ID;
  delete out.DREAMCONTEXT_TAB_SESSION;
  return out;
}

/** `$SHELL -ilc '<script>'`, like the in-app installer. Resolves, never rejects. */
function defaultRun(env: NodeJS.ProcessEnv): NonNullable<ClaudeUpdateDeps['run']> {
  return (script, timeoutMs) => new Promise((resolve) => {
    let output = '';
    let settled = false;
    const done = (r: ClaudeUpdateRunResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let timer: NodeJS.Timeout | undefined;
    try {
      const child = spawn(env.SHELL || '/bin/zsh', ['-ilc', script], { env: updateEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
      const append = (c: Buffer) => { output = (output + c.toString('utf-8')).slice(-8000); };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
        done({ code: null, output: `${output}\n[timed out after ${Math.round(timeoutMs / 1000)} s]` });
      }, timeoutMs);
      timer.unref?.();
      child.on('error', (err) => done({ code: null, output: `${output}\n${err.message}` }));
      child.on('close', (code) => done({ code, output }));
    } catch (err) {
      done({ code: null, output: err instanceof Error ? err.message : 'spawn failed' });
    }
  });
}

/** Last `n` non-empty lines: a Homebrew/winget install prints its own upgrade hint there. */
function outputTail(output: string, n = 4): string {
  return output.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n).join('\n');
}

let inFlight: { force: boolean; promise: Promise<ClaudeUpdateCheckResult> } | null = null;

/** True while a check or update runs in this process. */
export function claudeUpdateInFlight(): boolean {
  return inFlight !== null;
}

/**
 * Probe the installed version, fetch the channel's latest, and run `claude update` when behind
 * and not opted out (or when forced). Records every outcome in the state file. One run per
 * process: a second call joins the one in flight (a forced call waits for a non-forced one to
 * finish, then runs, so Update now is never swallowed by a background check that stopped at the
 * opt-out). A non-forced call within `intervalMs` of the last recorded check is skipped, which
 * throttles every server on the machine together. Never throws.
 */
export function runClaudeUpdateCheck(
  opts: { force?: boolean } = {},
  deps: ClaudeUpdateDeps = {},
): Promise<ClaudeUpdateCheckResult> {
  const force = opts.force === true;
  if (inFlight && (inFlight.force || !force)) return inFlight.promise;
  const prior = inFlight?.promise;
  const promise = (async () => {
    if (prior) await prior;
    return checkOnce(force, deps);
  })().finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { force, promise };
  return promise;
}

async function checkOnce(force: boolean, deps: ClaudeUpdateDeps): Promise<ClaudeUpdateCheckResult> {
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const run = deps.run ?? defaultRun(env);
  const intervalMs = deps.intervalMs ?? CLAUDE_UPDATE_INTERVAL_MS;
  try {
    // checkedAt is when this check STARTED, so the next one is due exactly intervalMs later,
    // not intervalMs plus however long the probe and a 5 min update took.
    const startedAt = now();
    const prev = readClaudeUpdateRecord(home);
    const sinceLast = prev ? startedAt - prev.checkedAt : Infinity;
    if (!force && prev && sinceLast >= 0 && sinceLast < intervalMs) {
      return { ok: true, ran: false, message: 'Checked recently, skipped.', record: prev };
    }

    const channel = readUpdateChannel(home);
    let shellOptOut: string | null = null;
    const readInstalled = async (): Promise<string | null> => {
      const r = await run(CLAUDE_VERSION_SCRIPT, VERSION_TIMEOUT_MS);
      shellOptOut ??= parseShellOptOut(r.output);
      return r.code === 0 ? parseClaudeVersion(r.output) : null;
    };
    const [installed, latest] = await Promise.all([readInstalled(), fetchLatestClaudeVersion(channel, deps.fetch)]);
    const base = { checkedAt: startedAt, installed, latest, channel };
    const finish = (record: ClaudeUpdateRecord, ok: boolean, message: string): ClaudeUpdateCheckResult => {
      writeClaudeUpdateRecord(home, record);
      return { ok, ran: true, message, record };
    };

    if (!installed) return finish({ ...base, state: 'unknown' }, false, "Couldn't read the installed Claude Code version.");
    // Offline: a background check stops here, but a click still tries `claude update` itself.
    if (!latest && !force) return finish({ ...base, state: 'unknown' }, false, "Couldn't reach npm to find the latest Claude Code version.");
    if (latest && !isBehind(installed, latest)) {
      return finish({ ...base, state: 'current' }, true, `Claude Code is up to date (${installed}).`);
    }
    const disabledBy = force ? null : (readUpdateOptOut(home, env) ?? shellOptOut);
    if (disabledBy) {
      return finish({ ...base, state: 'disabled', disabledBy }, true, `Claude Code ${installed} is behind ${latest}, updates are turned off (${disabledBy}).`);
    }

    const attemptAt = now();
    writeClaudeUpdateRecord(home, { ...base, state: 'updating', lastAttemptAt: attemptAt });
    const result = await run(CLAUDE_UPDATE_COMMAND, CLAUDE_UPDATE_TIMEOUT_MS);
    const after = await readInstalled();
    const reached = !!after && !!latest && compareVersions(after, latest) >= 0;
    const saysOk = /up to date|successfully updated/i.test(result.output);
    const record: ClaudeUpdateRecord = { ...base, installed: after ?? installed, lastAttemptAt: attemptAt, from: installed, state: 'failed' };
    if (after) record.to = after;
    if (result.code === 0 && (reached || saysOk)) {
      const changed = !!after && after !== installed;
      record.state = changed ? 'updated' : 'current';
      return finish(record, true, changed ? `Updated Claude Code ${installed} -> ${after}` : `Claude Code is up to date (${after ?? installed}).`);
    }
    record.error = outputTail(result.output) || `claude update exited with code ${result.code}`;
    return finish(record, false, record.error);
  } catch (err) {
    return { ok: false, ran: true, message: err instanceof Error ? err.message : 'Claude Code update check failed.', record: null };
  }
}
