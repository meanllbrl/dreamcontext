/**
 * Several Codex (ChatGPT) accounts on one machine (plan r5 §4b, Track T W2).
 *
 * ── The layout ────────────────────────────────────────────────────────────────────────
 * Account #0 (`primary`) is `~/.codex` itself, the owner's own `codex login`. Every other account
 * is a T3 Codex instance in "authOverlay" mode: `homePath ~/.codex` + `shadowHomePath
 * ~/.dreamcontext/codex-accounts/<id>/` (0700). T3's `materializeCodexShadowHome` keeps
 * `auth.json` private to that folder and links everything else (sessions, config) to `~/.codex`,
 * so every account resumes every other account's threads. Non-#0 accounts keep their sign-in in
 * that file (`cli_auth_credentials_store="file"`), never in a shared keychain entry.
 *
 * ── What this file never does ────────────────────────────────────────────────────────────
 *   - read a credential: sign-in state is the PRESENCE of `auth.json`, identity comes from
 *     `codex app-server`'s `account/read` (email + plan);
 *   - log out or delete `~/.codex`: removing #0 only hides its row;
 *   - follow a symlink while deleting: the shadow home is FULL of links into `~/.codex`.
 *
 * No Effect here: T3's own code (home layout, limits probe) runs in a short bridge child
 * (`dreamcontext t3-account`, account-cli.ts) so the dashboard server never loads it.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { codexChildEnv, codexCommand } from './codex-bin.js';
import { spawnSpec } from './win-cmd.js';
import { CODEX_PRIMARY_ID, codexAccountHome, codexInstanceSettings, isCodexAccountId } from './t3-bridge/accounts.js';
import { bridgeNode } from './t3-bridge/node-floor.js';
import { recordLimitPoints } from './usage-records.js';
import type { UsageLimitWire, UsageLimitsResponse } from './claude-usage.js';

export { CODEX_PRIMARY_ID, isCodexAccountId };

export class CodexAccountError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) {
    super(message);
  }
}

/** One account as the register keeps it. Identity only: no token, no secret. */
export interface CodexAccountRow {
  id: string;
  email: string;
  planType: string;
  addedAt: number;
}

export interface CodexAccount extends CodexAccountRow {
  primary: boolean;
  /** The top of the list: new Codex chats start here. */
  preferred: boolean;
  /** The folder `codex` runs with (CODEX_HOME): `~/.codex` for #0, the shadow home otherwise. */
  home: string;
  signedIn: boolean;
}

interface RegisterFile {
  accounts: CodexAccountRow[];
  /** #0 was removed from the list (never from disk). */
  primaryHidden?: boolean;
}

export function codexAccountsFile(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'codex-accounts.json');
}

export function codexAccountsRoot(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'codex-accounts');
}

function readRegister(home: string): RegisterFile {
  try {
    const raw = JSON.parse(readFileSync(codexAccountsFile(home), 'utf-8')) as Partial<RegisterFile>;
    const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
    const seen = new Set<string>();
    const rows: CodexAccountRow[] = [];
    for (const r of accounts as Array<Partial<CodexAccountRow>>) {
      const id = typeof r?.id === 'string' ? r.id : '';
      if (!(id === CODEX_PRIMARY_ID || isCodexAccountId(id)) || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        email: typeof r.email === 'string' ? r.email.slice(0, 200) : '',
        planType: typeof r.planType === 'string' ? r.planType.slice(0, 40) : '',
        addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0,
      });
    }
    return { accounts: rows, ...(raw.primaryHidden ? { primaryHidden: true } : {}) };
  } catch {
    return { accounts: [] };
  }
}

function writeRegister(reg: RegisterFile, home: string): void {
  const file = codexAccountsFile(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/** The folder `codex` runs with for this account. */
export function codexAccountDir(id: string, home: string = homedir()): string {
  return id === CODEX_PRIMARY_ID || !id ? join(home, '.codex') : codexAccountHome(home, id);
}

/** Signed in = a sign-in record exists in the account's own folder (presence only, never read). */
export function codexAccountSignedIn(id: string, home: string = homedir()): boolean {
  try {
    const st = lstatSync(join(codexAccountDir(id, home), 'auth.json'));
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Every account, in the owner's order. #0 is listed unless it was removed; a row that is in the
 * register but whose folder is gone is still listed (signed out), so the owner can remove it.
 */
export function listCodexAccounts(home: string = homedir()): CodexAccount[] {
  const reg = readRegister(home);
  const rows = [...reg.accounts];
  if (!reg.primaryHidden && !rows.some((r) => r.id === CODEX_PRIMARY_ID)) {
    rows.unshift({ id: CODEX_PRIMARY_ID, email: '', planType: '', addedAt: 0 });
  }
  if (reg.primaryHidden) {
    const i = rows.findIndex((r) => r.id === CODEX_PRIMARY_ID);
    if (i >= 0) rows.splice(i, 1);
  }
  return rows.map((r, i) => ({
    ...r,
    primary: r.id === CODEX_PRIMARY_ID,
    preferred: i === 0,
    home: codexAccountDir(r.id, home),
    signedIn: codexAccountSignedIn(r.id, home),
  }));
}

/** #0 was removed from the list (its folder and sign-in untouched): Settings offers it back. */
export function codexPrimaryHidden(home: string = homedir()): boolean {
  return readRegister(home).primaryHidden === true;
}

export function getCodexAccount(id: string, home: string = homedir()): CodexAccount | null {
  return listCodexAccounts(home).find((a) => a.id === id) ?? null;
}

/** Save what a probe learned about an account (its email and plan). */
export function noteCodexIdentity(id: string, ident: { email?: string; planType?: string }, home: string = homedir()): void {
  const reg = readRegister(home);
  const row = reg.accounts.find((r) => r.id === id);
  if (row) {
    if (ident.email) row.email = ident.email.slice(0, 200);
    if (ident.planType) row.planType = ident.planType.slice(0, 40);
  } else if (id === CODEX_PRIMARY_ID) {
    reg.accounts.unshift({ id, email: ident.email ?? '', planType: ident.planType ?? '', addedAt: 0 });
  } else {
    return;
  }
  writeRegister(reg, home);
}

/** The owner's order (top = preferred). Unknown ids refused; every listed id must be named. */
export function reorderCodexAccounts(ids: string[], home: string = homedir()): CodexAccount[] {
  const current = listCodexAccounts(home);
  const known = new Set(current.map((a) => a.id));
  if (ids.length !== known.size || !ids.every((id) => known.has(id)) || new Set(ids).size !== ids.length) {
    throw new CodexAccountError('bad_order', 'The order must name every connected Codex account once.');
  }
  const byId = new Map(current.map((a) => [a.id, a]));
  const reg = readRegister(home);
  reg.accounts = ids.map((id) => {
    const a = byId.get(id)!;
    return { id: a.id, email: a.email, planType: a.planType, addedAt: a.addedAt };
  });
  writeRegister(reg, home);
  return listCodexAccounts(home);
}

// ── Usage readings, per account ─────────────────────────────────────────────────────

/** One T3 usage window (`ServerProviderUsageWindow`), stored as T3 built it. */
export interface CodexUsageWindow {
  id: string;
  kind: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  windowDurationMins?: number;
}

/** The last reading of one account: kept in T3's shape so the Stats screen can read it as is. */
export interface CodexUsageReading {
  checkedAt: string;
  windows: CodexUsageWindow[];
  /** `probe` (account/rateLimits/read) or `session` (a live chat's limit update). */
  source: 'probe' | 'session';
}

export function codexUsageFile(id: string, home: string = homedir()): string {
  if (!(id === CODEX_PRIMARY_ID || isCodexAccountId(id))) throw new CodexAccountError('bad_account_id', 'Not a Codex account id.');
  return join(home, '.dreamcontext', 'codex-usage', `${id}.json`);
}

export function cleanUsageWindow(w: unknown): CodexUsageWindow | null {
  if (!w || typeof w !== 'object') return null;
  const o = w as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.kind !== 'string' || typeof o.usedPercent !== 'number' || !Number.isFinite(o.usedPercent)) return null;
  return {
    id: o.id.slice(0, 40),
    kind: o.kind.slice(0, 20),
    label: typeof o.label === 'string' ? o.label.slice(0, 60) : o.kind,
    usedPercent: Math.max(0, Math.min(100, o.usedPercent)),
    ...(typeof o.resetsAt === 'string' && !Number.isNaN(Date.parse(o.resetsAt)) ? { resetsAt: o.resetsAt } : {}),
    ...(typeof o.windowDurationMins === 'number' ? { windowDurationMins: o.windowDurationMins } : {}),
  };
}

export function readCodexUsage(id: string, home: string = homedir()): CodexUsageReading | null {
  try {
    const raw = JSON.parse(readFileSync(codexUsageFile(id, home), 'utf-8')) as Partial<CodexUsageReading>;
    if (typeof raw.checkedAt !== 'string' || !Array.isArray(raw.windows)) return null;
    return {
      checkedAt: raw.checkedAt,
      windows: raw.windows.map(cleanUsageWindow).filter((w): w is CodexUsageWindow => w !== null),
      source: raw.source === 'session' ? 'session' : 'probe',
    };
  } catch {
    return null;
  }
}

/**
 * Record windows for an account. A probe REPLACES the reading; a live session's update is
 * partial (T3: "omitted windows remain unchanged"), so it merges by window id.
 */
export function recordCodexUsage(
  id: string, windows: unknown[], checkedAt: string, source: 'probe' | 'session', home: string = homedir(),
): CodexUsageReading {
  const fresh = windows.map(cleanUsageWindow).filter((w): w is CodexUsageWindow => w !== null);
  const before = readCodexUsage(id, home);
  const prev = source === 'session' ? before : null;
  const merged = prev ? [...prev.windows.filter((w) => !fresh.some((f) => f.id === w.id)), ...fresh] : fresh;
  const reading: CodexUsageReading = { checkedAt: Number.isNaN(Date.parse(checkedAt)) ? new Date().toISOString() : checkedAt, windows: merged, source };
  recordLimitPoints(fresh
    .filter((w) => w.resetsAt && before?.windows.find((b) => b.id === w.id)?.usedPercent !== w.usedPercent)
    .map((w) => ({ ts: Date.parse(reading.checkedAt), account: `codex:${id}`, key: w.kind, percent: w.usedPercent, resetsAt: Date.parse(w.resetsAt as string) })), home);
  const file = codexUsageFile(id, home);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(reading) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* a reading that cannot be saved is re-read next time */ }
  return reading;
}

/**
 * The reading in the chooser's shape (`UsageLimitsResponse`): T3's 5-hour window is `session`,
 * its weekly window `weekly`. A monthly (free plan) or model-specific window is not a switch
 * input: the chooser has no such window and must not read it as one.
 */
export function codexLimitsFor(reading: CodexUsageReading | null): UsageLimitsResponse {
  if (!reading) return { limits: [], fetchedAtMs: null };
  const limits: UsageLimitWire[] = [];
  for (const w of reading.windows) {
    const key = w.kind === 'session' ? 'session' : w.kind === 'weekly' ? 'weekly' : null;
    if (!key || limits.some((l) => l.key === key)) continue;
    const resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (!Number.isFinite(resetsAt)) continue;
    limits.push({ key, percent: Math.round(w.usedPercent), resetsAt });
  }
  const fetched = Date.parse(reading.checkedAt);
  return { limits, fetchedAtMs: Number.isFinite(fetched) ? fetched : null };
}

// ── Running T3's account jobs and the `codex` CLI ──────────────────────────────────────

export interface CodexRunResult {
  /** The process started at all. */
  spawned: boolean;
  timedOut: boolean;
  code: number | null;
  /** stdout, ONLY for `t3-account` (a JSON line with no secret). `codex login` output is discarded. */
  stdout: string;
}

/** How a command is run; tests replace it. */
export type CodexRunner = (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number; keepStdout: boolean }) => Promise<CodexRunResult>;

export const defaultCodexRunner: CodexRunner = (cmd, args, o) => new Promise((resolve) => {
  let out = '';
  let timedOut = false;
  let child: ReturnType<typeof spawn>;
  try {
    // Output of `codex login` can carry a callback URL with an authorization code: never kept.
    // win32: `codex.cmd` only starts through cmd.exe (win-cmd.ts).
    const spec = spawnSpec(cmd, args);
    child = spawn(spec.file, spec.args, { env: o.env, stdio: ['ignore', o.keepStdout ? 'pipe' : 'ignore', 'ignore'], ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
  } catch {
    resolve({ spawned: false, timedOut: false, code: null, stdout: '' });
    return;
  }
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* gone */ } }, o.timeoutMs);
  child.stdout?.on('data', (c: Buffer) => { if (out.length < 64_000) out += c.toString(); });
  child.on('error', () => { clearTimeout(timer); resolve({ spawned: false, timedOut: false, code: null, stdout: '' }); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ spawned: true, timedOut, code, stdout: out }); });
});

export interface CodexAccountDeps {
  home?: string;
  run?: CodexRunner;
  /** Node that can load the bridge bundle (`bridgeNode()`); null = none on this machine. */
  node?: string | null;
  /** The dreamcontext CLI entry. */
  cli?: string;
  env?: NodeJS.ProcessEnv;
}

let depsOverride: (() => CodexAccountDeps) | null = null;
/** Tests: the runner and Node every server caller uses (routes, the chat's switch). */
export function setCodexAccountDepsForTests(fn: (() => CodexAccountDeps) | null): void {
  depsOverride = fn;
}
/** What the server's callers run with: a Node that can load the bridge bundle, the real `codex`. */
export function codexAccountDeps(): CodexAccountDeps {
  return depsOverride ? depsOverride() : { node: bridgeNode() };
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 25_000;

function lastJsonLine(text: string): Record<string, unknown> | null {
  for (const line of text.trim().split('\n').reverse()) {
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* not this line */ }
  }
  return null;
}

async function t3Account(action: 'prepare' | 'probe', id: string, deps: CodexAccountDeps): Promise<Record<string, unknown> | null> {
  const node = deps.node;
  const cli = deps.cli ?? (process.env.DREAMCONTEXT_CLI || process.argv[1] || '');
  if (!node || !cli) return null;
  const args = [cli, 't3-account', action, ...(id && id !== CODEX_PRIMARY_ID ? ['--account', id] : [])];
  const r = await (deps.run ?? defaultCodexRunner)(node, args, { env: deps.env ?? process.env, timeoutMs: PROBE_TIMEOUT_MS, keepStdout: true });
  return r.spawned ? lastJsonLine(r.stdout) : null;
}

/** `codex` with this account's home and its credential store. */
export function codexArgsEnv(id: string, deps: CodexAccountDeps): { env: NodeJS.ProcessEnv; pre: string[] } {
  const home = deps.home ?? homedir();
  const s = codexInstanceSettings(home, id === CODEX_PRIMARY_ID ? null : id);
  const env = { ...(deps.env ?? process.env) };
  delete env.T3CODE_CODEX_LAUNCH_ARGS;
  if (s.shadowHomePath) env.CODEX_HOME = s.shadowHomePath;
  else delete env.CODEX_HOME;
  return { env, pre: s.shadowHomePath ? ['-c', 'cli_auth_credentials_store="file"'] : [] };
}

/** The interactive terminal's account (Track T W4): `''` is #0, whose env stays as it is. */
export function codexTerminalEnv(id: string, home: string = homedir()): { env: Record<string, string>; pre: string[] } {
  if (!id || id === CODEX_PRIMARY_ID || !isCodexAccountId(id)) return { env: {}, pre: [] };
  const s = codexInstanceSettings(home, id);
  return s.shadowHomePath
    ? { env: { CODEX_HOME: s.shadowHomePath }, pre: ['-c', 'cli_auth_credentials_store="file"'] }
    : { env: {}, pre: [] };
}

export interface ProbeOutcome {
  status: 'ok' | 'needs-relogin' | 'unknown';
  email?: string;
  planType?: string;
  reading?: CodexUsageReading;
}

/**
 * Ask Codex, for one account, who is signed in and how full its windows are. No model call
 * (`account/read`, `account/rateLimits/read`). The reading and identity are saved.
 */
export async function probeCodexAccount(id: string, deps: CodexAccountDeps = {}): Promise<ProbeOutcome> {
  const home = deps.home ?? homedir();
  if (!(id === CODEX_PRIMARY_ID || isCodexAccountId(id))) throw new CodexAccountError('bad_account_id', 'Not a Codex account id.');
  if (!codexAccountSignedIn(id, home)) return { status: 'needs-relogin' };
  const out = await t3Account('probe', id, deps);
  if (!out || out.ok !== true) return { status: 'unknown' };
  if (out.signedIn !== true) return { status: 'needs-relogin' };
  const email = typeof out.email === 'string' ? out.email : undefined;
  const planType = typeof out.planType === 'string' ? out.planType : undefined;
  noteCodexIdentity(id, { ...(email ? { email } : {}), ...(planType ? { planType } : {}) }, home);
  const reading = Array.isArray(out.windows) && typeof out.checkedAt === 'string'
    ? recordCodexUsage(id, out.windows as unknown[], out.checkedAt, 'probe', home)
    : undefined;
  return { status: 'ok', ...(email ? { email } : {}), ...(planType ? { planType } : {}), ...(reading ? { reading } : {}) };
}

/**
 * Add an account: a fresh shadow home, T3 lays it out, `codex login` runs into it (the browser
 * does the ChatGPT sign-in; its output is discarded), then a probe says who signed in. A sign-in
 * that landed on an account already connected is undone: two homes never hold one login.
 */
export async function signInNewCodexAccount(deps: CodexAccountDeps = {}): Promise<CodexAccount> {
  const home = deps.home ?? homedir();
  if (!deps.node) throw new CodexAccountError('node_missing', 'Codex needs Node 22.16 or newer on this machine to add an account.', 409);
  const id = `acct-${randomBytes(3).toString('hex')}`;
  signingIn.add(id);
  try {
    return await signInInto(id, home, deps);
  } finally {
    signingIn.delete(id);
  }
}

async function signInInto(id: string, home: string, deps: CodexAccountDeps): Promise<CodexAccount> {
  const dir = codexAccountHome(home, id);
  mkdirSync(codexAccountsRoot(home), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const prepared = await t3Account('prepare', id, deps);
  if (!prepared || prepared.ok !== true) {
    removeCodexHome(id, home);
    throw new CodexAccountError('prepare_failed', 'Could not prepare a folder for the new account.', 500);
  }
  const { env, pre } = codexArgsEnv(id, deps);
  const login = await (deps.run ?? defaultCodexRunner)(deps.run ? 'codex' : codexCommand({ home }), [...pre, 'login'], { env: codexChildEnv(env), timeoutMs: LOGIN_TIMEOUT_MS, keepStdout: false });
  if (!login.spawned) { removeCodexHome(id, home); throw new CodexAccountError('spawn_failed', 'Could not start the sign-in: the Codex CLI did not launch.', 500); }
  if (login.timedOut) { removeCodexHome(id, home); throw new CodexAccountError('login_timeout', 'The sign-in timed out. Nothing was saved; you can try again.', 504); }
  if (!codexAccountSignedIn(id, home)) { removeCodexHome(id, home); throw new CodexAccountError('login_incomplete', 'The sign-in did not complete. Nothing was saved; you can try again.', 409); }
  // Register first (so the probe can save what it learns), then check who it is.
  const reg = readRegister(home);
  reg.accounts.push({ id, email: '', planType: '', addedAt: Date.now() });
  writeRegister(reg, home);
  const probe = await probeCodexAccount(id, deps);
  const email = (probe.email ?? '').toLowerCase();
  // Every other signed-in account must have a KNOWN email to compare against: #0 is never
  // probed until something asks, and an empty email let the same ChatGPT login in twice (live,
  // 2026-10-31). Read those first; one that still cannot be read is not proof of a twin.
  if (email) {
    for (const other of listCodexAccounts(home)) {
      if (other.id !== id && other.signedIn && !other.email) await probeCodexAccount(other.id, deps).catch(() => undefined);
    }
  }
  const twin = email ? listCodexAccounts(home).find((a) => a.id !== id && a.email.toLowerCase() === email) : undefined;
  if (twin) {
    await removeCodexAccount(id, deps);
    throw new CodexAccountError('already_connected', `That ChatGPT account (${probe.email}) is already connected. Sign in with another one.`, 409);
  }
  return getCodexAccount(id, home)!;
}

/** Ids whose sign-in is running in THIS server right now: their folder is not an orphan yet. */
const signingIn = new Set<string>();

/**
 * Signed-in account folders the list does not know: a sign-in that finished after the server
 * that started it died (live, 2026-10-31) leaves a logged-in home with no row. Only a plain
 * folder directly under the accounts root, with a real `auth.json`, whose sign-in is not still
 * running here, counts. Nothing is read from inside it.
 */
export function orphanCodexAccountIds(home: string = homedir()): string[] {
  const root = codexAccountsRoot(home);
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const known = new Set(readRegister(home).accounts.map((r) => r.id));
  const out: string[] = [];
  for (const name of names.sort()) {
    if (!isCodexAccountId(name) || known.has(name) || signingIn.has(name)) continue;
    try {
      if (!confinedCodexHome(name, home)) continue;
    } catch { continue; }
    if (codexAccountSignedIn(name, home)) out.push(name);
  }
  return out;
}

export interface AdoptResult {
  /** Accounts now on the list. */
  adopted: string[];
  /** Orphans that were a second login of an account already listed: logged out and deleted, the way a twin sign-in is. */
  twins: string[];
}

/**
 * The Settings "bring back" button: #0 when it was hidden, plus every orphan folder. An orphan is
 * registered, then probed for who it is; a twin of a listed account is undone exactly like a twin
 * sign-in (two homes never hold one login).
 */
export async function adoptCodexAccounts(deps: CodexAccountDeps = {}): Promise<AdoptResult> {
  const home = deps.home ?? homedir();
  const adopted: string[] = [];
  const twins: string[] = [];
  if (readRegister(home).primaryHidden && codexAccountSignedIn(CODEX_PRIMARY_ID, home)) {
    adoptPrimaryCodexAccount(home);
    adopted.push(CODEX_PRIMARY_ID);
  }
  for (const id of orphanCodexAccountIds(home)) {
    const reg = readRegister(home);
    if (reg.accounts.some((r) => r.id === id)) continue;
    reg.accounts.push({ id, email: '', planType: '', addedAt: Date.now() });
    writeRegister(reg, home);
    const probe = await probeCodexAccount(id, deps).catch((): ProbeOutcome => ({ status: 'unknown' }));
    const email = (probe.email ?? '').toLowerCase();
    if (email) {
      for (const other of listCodexAccounts(home)) {
        if (other.id !== id && other.signedIn && !other.email) await probeCodexAccount(other.id, deps).catch(() => undefined);
      }
    }
    const twin = email ? listCodexAccounts(home).find((a) => a.id !== id && a.email.toLowerCase() === email) : undefined;
    if (twin) { await removeCodexAccount(id, deps); twins.push(id); continue; }
    adopted.push(id);
  }
  if (adopted.length === 0 && twins.length === 0) {
    throw new CodexAccountError('nothing_to_adopt', 'No signed-in Codex account was found that is not already listed.', 409);
  }
  return { adopted, twins };
}

/** Re-list #0 after it was removed from the list (it was never touched on disk). */
export function adoptPrimaryCodexAccount(home: string = homedir()): CodexAccount {
  if (!codexAccountSignedIn(CODEX_PRIMARY_ID, home)) {
    throw new CodexAccountError('not_signed_in', 'Codex is not signed in on this machine yet. Run codex login first, then add it.', 409);
  }
  const reg = readRegister(home);
  delete reg.primaryHidden;
  if (!reg.accounts.some((r) => r.id === CODEX_PRIMARY_ID)) reg.accounts.push({ id: CODEX_PRIMARY_ID, email: '', planType: '', addedAt: Date.now() });
  writeRegister(reg, home);
  return getCodexAccount(CODEX_PRIMARY_ID, home)!;
}

/**
 * Delete one account's shadow home, confined: the folder must be a real directory directly
 * under `~/.dreamcontext/codex-accounts/`, and nothing inside is followed. A link is removed as a
 * link, so `~/.codex/sessions` (linked in every shadow home) is never reached.
 */
export function removeCodexHome(id: string, home: string = homedir()): void {
  const confined = confinedCodexHome(id, home);
  if (confined) removeTreeNoFollow(confined.dir, confined.realRoot + sep);
}

/**
 * The account's home, proven to be a plain folder directly under the accounts root, or null when
 * it does not exist. Throws when it is anything else: a link (to `~/.codex` or anywhere), a file,
 * or a folder that resolves outside the root. Run BEFORE anything acts on the home, logout included.
 */
function confinedCodexHome(id: string, home: string): { dir: string; realRoot: string } | null {
  if (id === CODEX_PRIMARY_ID) throw new CodexAccountError('primary_account', 'Account #0 (~/.codex) is never deleted.', 409);
  if (!isCodexAccountId(id)) throw new CodexAccountError('bad_account_id', 'Not a Codex account id.');
  const root = codexAccountsRoot(home);
  const dir = codexAccountHome(home, id);
  let st;
  try { st = lstatSync(dir); } catch { return null; }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new CodexAccountError('not_confined', 'The account folder is not a plain folder; nothing was deleted.', 409);
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { throw new CodexAccountError('not_confined', 'The accounts folder is missing; nothing was deleted.', 409); }
  if (realpathSync(dir) !== join(realRoot, id)) {
    throw new CodexAccountError('not_confined', 'The account folder is not inside ~/.dreamcontext/codex-accounts; nothing was deleted.', 409);
  }
  return { dir, realRoot };
}

/** `path`'s parent is always a real folder inside the root: links are unlinked, never entered. */
function removeTreeNoFollow(path: string, mustStartWith: string): void {
  if (!(realpathSync(dirname(path)) + sep).startsWith(mustStartWith)) {
    throw new CodexAccountError('not_confined', 'Refused to delete outside the account folder.', 409);
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) { unlinkSync(path); return; }
  for (const name of readdirSync(path)) removeTreeNoFollow(join(path, name), mustStartWith);
  rmdirSync(path);
}

/**
 * Remove an account. #0 only leaves the list. Any other: `codex logout` in its own home first
 * (so the login is revoked, not just forgotten), then its folder, its row and its records.
 */
export async function removeCodexAccount(id: string, deps: CodexAccountDeps = {}): Promise<void> {
  const home = deps.home ?? homedir();
  if (id === CODEX_PRIMARY_ID) {
    const reg = readRegister(home);
    reg.accounts = reg.accounts.filter((r) => r.id !== CODEX_PRIMARY_ID);
    reg.primaryHidden = true;
    writeRegister(reg, home);
    return;
  }
  // Proven confined FIRST: a home that is a link (say, to ~/.codex) must never reach `logout`.
  const confined = confinedCodexHome(id, home);
  if (confined && codexAccountSignedIn(id, home)) {
    const { env, pre } = codexArgsEnv(id, deps);
    await (deps.run ?? defaultCodexRunner)(deps.run ? 'codex' : codexCommand({ home }), [...pre, 'logout'], { env: codexChildEnv(env), timeoutMs: 30_000, keepStdout: false });
  }
  removeCodexHome(id, home);
  // Read again after the (slow) logout: a row added meanwhile must survive this write.
  const reg = readRegister(home);
  reg.accounts = reg.accounts.filter((r) => r.id !== id);
  writeRegister(reg, home);
  try { unlinkSync(codexUsageFile(id, home)); } catch { /* none */ }
}
