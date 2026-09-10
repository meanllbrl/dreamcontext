import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_SWITCH_STRATEGY,
  DEFAULT_SWITCH_WEIGHTS,
  asSwitchStrategy,
  sanitizeSwitchWeights,
  type SwitchStrategy,
  type SwitchWeights,
} from './claude-account-switch.js';

/**
 * The multi-account REGISTER — which Claude accounts this machine knows, and for each one
 * WHICH credential store its processes should read.
 *
 * ── The mechanism ─────────────────────────────────────────────────────────────────────
 * `CLAUDE_CONFIG_DIR=<dir>` gives a spawned `claude` its OWN credential store. Measured
 * 2026-09-04 (CLI 2.1.260): a fresh directory reports `loggedIn: false` while the real HOME
 * stays signed in. So N directories = N accounts signed in AT THE SAME TIME, with no
 * logout/login churn between them. That is the whole basis of this feature, and this module
 * is the only place that decides which directory a spawn gets.
 *
 * ── Why the register is COLD ──────────────────────────────────────────────────────────
 * There is deliberately NO `lastUsage` field and NO `recordUsage()`. Each account's usage
 * already lives in its OWN `<configDir>/.claude.json`, written by the CLI itself
 * (`cachedUsageUtilization`); copying it here would create a HOT read-modify-write path hit
 * by every probe and every switch from several panels at once, which then needs a lockfile
 * to survive its own lost-update race. Removing the copy removed the race. What is left —
 * add / remove / setPreferred, by hand, rarely — is cold enough for the same plain atomic
 * temp+rename `linked-repos.ts` uses (no lock, no spin, no stale TTL).
 *
 * ── Identity ──────────────────────────────────────────────────────────────────────────
 * The fingerprint carries `accountUuid` + `emailAddress` + `organizationUuid`, verbatim from
 * `claude-auth-watch.ts:mirrorFingerprint`. The org is in there on purpose: ONE email can
 * hold seats in two organizations, and each seat is a SEPARATE quota pool — so two accounts
 * that differ only by org are genuinely two accounts here.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClaudeAccount {
  /** Kebab-case slug; also the sandbox directory name. Shape-validated in {@link resolveConfigDir}. */
  id: string;
  accountUuid: string;
  email: string;
  organizationUuid: string;
  organizationName: string;
  /** Display only ("max", "pro", …). NEVER used to decide whether an account can serve a model. */
  tier: string;
  /** `null` = the REAL `~/.claude` (account #0). A slug-derived absolute path otherwise. */
  configDir: string | null;
  /** New sessions start on the preferred account unless told otherwise. At most one. */
  preferred: boolean;
}

/** On-disk shape of `~/.dreamcontext/claude-accounts.json`. */
export interface ClaudeAccountRegistry {
  accounts: ClaudeAccount[];
  /**
   * Auto-switch, ON by default. When OFF the system REPORTS a limit and changes nothing.
   *
   * The plan originally put this in `~/.dreamcontext/app.json`. That file is the installed-app
   * MANIFEST and `writeAppManifest` (cli/commands/app.ts) rewrites it WHOLESALE, so the
   * setting would have been silently erased on every install or update. It lives here instead:
   * the same machine-local, cold, atomically-written file, and account policy is what this
   * file is for.
   */
  autoSwitch?: boolean;
  /**
   * WHICH rule auto-switch uses to pick the next account. Absent = `score`, the behaviour
   * every machine had before the setting existed.
   *
   * It lives beside `autoSwitch` for the same reason that flag does: this file is the cold,
   * machine-local, atomically-written home of account POLICY, and `app.json` is rewritten
   * wholesale by `writeAppManifest` on every install.
   */
  switchStrategy?: SwitchStrategy;
  /** The `score` strategy's coefficients. Each falls back to its default on its own. */
  switchWeights?: SwitchWeights;
}

export class ClaudeAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeAccountError';
  }
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/** The register file. Injectable `home` for testability (precedent: `vaults.ts:39`). */
export function claudeAccountsFilePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'claude-accounts.json');
}

/** The directory every sandbox lives under. The ONLY place a config dir may be, besides HOME. */
export function claudeSandboxRoot(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'claude-accounts');
}

/** Where account `id`'s sandbox goes. Callers must still go through {@link resolveConfigDir}. */
export function sandboxDirFor(id: string, home: string = homedir()): string {
  return join(claudeSandboxRoot(home), id);
}

// ─── Slug shape ───────────────────────────────────────────────────────────────

/**
 * The account id's shape, identical to `isSafeAutomationSlug` (automations/store.ts:90-96).
 * The id becomes a DIRECTORY NAME, so validating it only at the WebSocket query boundary
 * would not be enough: the login endpoint and the automations runner reach
 * `resolveConfigDir`/`ensureSandbox` without passing through that boundary at all.
 */
export function isSafeAccountId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return false;
  if (id.includes('--')) return false;
  if (id.endsWith('-')) return false;
  return true;
}

/** An email → a candidate id. Callers must still check {@link isSafeAccountId} on the result. */
export function accountIdFromEmail(email: string): string {
  const slug = email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `account-${randomBytes(3).toString('hex')}`;
}

// ─── Read (never throws) ──────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * One raw entry → an account, or `null` when it cannot be trusted. Built field by field:
 * an unknown key in the file cannot ride into the process, and an entry whose `configDir`
 * is not the slug's OWN sandbox path is dropped rather than honoured — the file is
 * machine-local, but it is still not a place from which to accept an arbitrary directory.
 */
function parseAccount(raw: unknown, home: string): ClaudeAccount | null {
  const o = asRecord(raw);
  if (!o) return null;
  const id = str(o.id);
  if (!isSafeAccountId(id)) return null;
  const configDir = o.configDir === null || o.configDir === undefined ? null : str(o.configDir);
  if (configDir !== null && configDir !== sandboxDirFor(id, home)) return null;
  return {
    id,
    accountUuid: str(o.accountUuid),
    email: str(o.email),
    organizationUuid: str(o.organizationUuid),
    organizationName: str(o.organizationName),
    tier: str(o.tier),
    configDir,
    preferred: o.preferred === true,
  };
}

/**
 * Read the register. Missing file ⇒ `[]`; malformed JSON ⇒ `[]` + a logged notice;
 * untrustworthy entries are filtered out. NEVER throws — a corrupt machine-local file must
 * not break a spawn, it must fall back to account #0.
 */
export function listClaudeAccounts(home: string = homedir()): ClaudeAccount[] {
  const filePath = claudeAccountsFilePath(home);
  if (!existsSync(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    console.error('[dreamcontext] claude-accounts.json is malformed — treating the register as empty.');
    return [];
  }
  const list = asRecord(parsed)?.accounts;
  if (!Array.isArray(list)) return [];
  const out: ClaudeAccount[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const acc = parseAccount(raw, home);
    if (!acc || seen.has(acc.id)) continue;
    seen.add(acc.id);
    out.push(acc);
  }
  return out;
}

export function getClaudeAccount(id: string, home?: string): ClaudeAccount | null {
  return listClaudeAccounts(home).find((a) => a.id === id) ?? null;
}

/** Is auto-switch on? Absent (and any non-boolean) reads as ON — the documented default. */
export function autoSwitchEnabled(home: string = homedir()): boolean {
  const filePath = claudeAccountsFilePath(home);
  if (!existsSync(filePath)) return true;
  try {
    const parsed = asRecord(JSON.parse(readFileSync(filePath, 'utf-8')));
    return parsed?.autoSwitch === false ? false : true;
  } catch {
    return true;
  }
}

/** Turn auto-switch on or off, preserving the accounts. */
export function setAutoSwitchEnabled(enabled: boolean, home: string = homedir()): void {
  writeClaudeAccounts(listClaudeAccounts(home), home, enabled);
}

/** The registry object, or null when there is no readable file. Never throws. */
function readRegistry(home: string): Record<string, unknown> | null {
  const filePath = claudeAccountsFilePath(home);
  if (!existsSync(filePath)) return null;
  try {
    return asRecord(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch {
    return null;
  }
}

/** Which rule picks the next account. An unreadable or unknown value reads as the default. */
export function switchStrategyFor(home: string = homedir()): SwitchStrategy {
  return asSwitchStrategy(readRegistry(home)?.switchStrategy) ?? DEFAULT_SWITCH_STRATEGY;
}

/** The `score` strategy's coefficients, each falling back to its own default. */
export function switchWeightsFor(home: string = homedir()): SwitchWeights {
  return sanitizeSwitchWeights(readRegistry(home)?.switchWeights ?? DEFAULT_SWITCH_WEIGHTS);
}

/**
 * Set the strategy, its weights, or both — the accounts and `autoSwitch` are preserved.
 *
 * Partial on purpose: the UI writes the mode and the coefficients from two different
 * controls, and neither should be able to reset the other by not mentioning it.
 */
export function setSwitchPolicy(
  policy: { strategy?: SwitchStrategy; weights?: SwitchWeights },
  home: string = homedir(),
): { strategy: SwitchStrategy; weights: SwitchWeights } {
  const next = {
    strategy: policy.strategy ?? switchStrategyFor(home),
    weights: policy.weights ? sanitizeSwitchWeights(policy.weights) : switchWeightsFor(home),
  };
  writeClaudeAccounts(listClaudeAccounts(home), home, undefined, next);
  return next;
}

/** The account new sessions start on: the preferred one, else account #0, else null. */
export function preferredClaudeAccount(home?: string): ClaudeAccount | null {
  const accounts = listClaudeAccounts(home);
  return accounts.find((a) => a.preferred) ?? accounts.find((a) => a.configDir === null) ?? null;
}

// ─── Write (atomic temp+rename, pid+nonce) ────────────────────────────────────

/**
 * Persist the register atomically: write a sibling temp file (pid + nonce, so two writers
 * never pick the same scratch path), then `rename` over the target. Mirrors
 * `writeLinkedRepoRegistry` (linked-repos.ts:92-106) — deliberately NOT a lockfile, because
 * this file is only written by human-driven, rare operations.
 */
export function writeClaudeAccounts(
  accounts: ClaudeAccount[],
  home: string = homedir(),
  autoSwitch?: boolean,
  /** The switch policy to store. Omitted = keep whatever is on disk. */
  policy?: { strategy: SwitchStrategy; weights: SwitchWeights },
): void {
  const filePath = claudeAccountsFilePath(home);
  mkdirSync(dirname(filePath), { recursive: true });
  // Preserve the existing settings when the caller is only touching the accounts. Every
  // account mutation in this file goes through here, so a reorder or a removal must not be
  // able to silently reset the switch policy to its defaults.
  const keep = autoSwitch === undefined ? autoSwitchEnabled(home) : autoSwitch;
  const keepPolicy = policy ?? { strategy: switchStrategyFor(home), weights: switchWeightsFor(home) };
  const registry: ClaudeAccountRegistry = {
    accounts,
    autoSwitch: keep,
    switchStrategy: keepPolicy.strategy,
    switchWeights: keepPolicy.weights,
  };
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
}

/** Add or replace an account. `preferred: true` clears the flag on every sibling. */
export function upsertClaudeAccount(account: ClaudeAccount, home?: string): ClaudeAccount {
  if (!isSafeAccountId(account.id)) {
    throw new ClaudeAccountError(`Not a usable account id: ${JSON.stringify(account.id)}`);
  }
  const accounts = listClaudeAccounts(home).filter((a) => a.id !== account.id);
  const next = account.preferred ? accounts.map((a) => ({ ...a, preferred: false })) : accounts;
  next.push(account);
  writeClaudeAccounts(next, home ?? homedir());
  return account;
}

/** Mark `id` preferred and clear every sibling. Unknown id ⇒ throws (never a silent no-op). */
export function setPreferredClaudeAccount(id: string, home?: string): void {
  const accounts = listClaudeAccounts(home);
  if (!accounts.some((a) => a.id === id)) {
    throw new ClaudeAccountError(`No such account: ${id}`);
  }
  writeClaudeAccounts(accounts.map((a) => ({ ...a, preferred: a.id === id })), home ?? homedir());
}

/**
 * Drop `id` from the register AND delete its sandbox directory.
 *
 * Two refusals: an unknown id, and the LAST account (removing it would leave the app with
 * no account at all). The delete does NOT follow symlinks — plain `rm -rf` semantics remove
 * the link, never its target — which is what keeps this away from the real
 * `~/.claude/projects`. It is the one destructive operation in the design, so it has a test.
 */
/**
 * Persist a user-chosen ORDER, and make the account at the top the preferred one.
 *
 * The register is an array and `listClaudeAccounts` preserves it, so order was already the
 * list's identity — it just had no way to be expressed. Dragging is that way. Position 0
 * carries real meaning: it is the account new sessions start on, and the tie-break
 * `chooseAccount` applies when two accounts are equally free (`preferredId`). Below the top,
 * order is how the list reads.
 *
 * `ids` need not be exhaustive or clean: unknown ids are ignored and any account the caller
 * forgot keeps its relative position at the end, so a stale tab cannot silently drop an
 * account by reordering with a list it built before the account existed.
 */
export function reorderClaudeAccounts(ids: string[], home: string = homedir()): ClaudeAccount[] {
  const current = listClaudeAccounts(home);
  const byId = new Map(current.map((a) => [a.id, a]));
  const ordered: ClaudeAccount[] = [];
  const taken = new Set<string>();
  for (const id of ids) {
    const acc = byId.get(id);
    if (!acc || taken.has(id)) continue;
    taken.add(id);
    ordered.push(acc);
  }
  for (const acc of current) {
    if (!taken.has(acc.id)) ordered.push(acc);
  }
  // Exactly one preferred, and it is the top row — the two can never disagree again.
  const next = ordered.map((acc, i) => ({ ...acc, preferred: i === 0 }));
  writeClaudeAccounts(next, home); // autoSwitch is preserved by the writer
  return next;
}

export function removeClaudeAccount(id: string, home: string = homedir()): void {
  const accounts = listClaudeAccounts(home);
  const victim = accounts.find((a) => a.id === id);
  if (!victim) throw new ClaudeAccountError(`No such account: ${id}`);
  if (accounts.length === 1) throw new ClaudeAccountError('Cannot remove the last account.');

  const dir = victim.configDir;
  if (dir !== null) {
    // Assert BEFORE deleting: the path must be inside the sandbox root. `parseAccount`
    // already enforces this on read, and it is re-asserted here because this call deletes.
    const root = claudeSandboxRoot(home);
    const target = resolve(dir);
    if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) {
      throw new ClaudeAccountError(`Refusing to delete a directory outside the sandbox root: ${dir}`);
    }
    rmSync(target, { recursive: true, force: true });
  }

  const remaining = accounts.filter((a) => a.id !== id);
  // The register must not be left with nothing preferred when the removed account was it.
  if (victim.preferred && !remaining.some((a) => a.preferred)) {
    const fallback = remaining.find((a) => a.configDir === null) ?? remaining[0];
    if (fallback) fallback.preferred = true;
  }
  writeClaudeAccounts(remaining, home);
}

// ─── The single gate ──────────────────────────────────────────────────────────

/**
 * Account id → the credential directory a spawn must read. THE ONLY WAY to turn an id into a
 * config dir, and where every check lives.
 *
 * `null`/`undefined` resolves the DEFAULT: the preferred account, else account #0, i.e. the
 * real HOME. That default is the majority path, not an edge case — a machine with one
 * account never leaves it.
 *
 * Three refusals, in order:
 *   (a) an id that is not slug-shaped;
 *   (b) an id that is not in the register — REJECTED, never silently downgraded to HOME,
 *       because "we ran your prompt on some other account" is worse than an error;
 *   (c) a resolved path that is neither `homedir()` nor inside `~/.dreamcontext/claude-accounts/`
 *       — asserted BEFORE returning, so no caller can hand a raw directory to a spawn.
 */
export function resolveConfigDir(id: string | null | undefined, home: string = homedir()): string {
  if (id === null || id === undefined || id === '') {
    return preferredClaudeAccount(home)?.configDir ?? home;
  }
  if (!isSafeAccountId(id)) {
    throw new ClaudeAccountError(`Not a usable account id: ${JSON.stringify(id)}`);
  }
  const account = getClaudeAccount(id, home);
  if (!account) throw new ClaudeAccountError(`No such account: ${id}`);
  return assertConfinedConfigDir(account.configDir ?? home, home);
}

/**
 * A config dir is either the real HOME or a directory under the sandbox root — nothing else,
 * ever. Exported and REPEATED at every site that hands a directory to a spawned `claude`
 * (`readUsageLimits`, `claudeAuthStatus`, `ensureSandbox`), so the guarantee does not depend
 * on today's — or tomorrow's — callers remembering to come through `resolveConfigDir`.
 */
export function assertConfinedConfigDir(dir: string, home: string = homedir()): string {
  const target = resolve(dir);
  if (target === resolve(home)) return target;
  const root = resolve(claudeSandboxRoot(home));
  if (target.startsWith(root + sep) && target !== root) return target;
  throw new ClaudeAccountError(
    `Refusing a Claude config dir outside the account sandbox root: ${dir}`,
  );
}

/** True when this dir is the real HOME — the account-#0 short circuit every caller checks. */
export function isRealHomeConfigDir(dir: string, home: string = homedir()): boolean {
  return resolve(dir) === resolve(home);
}

/**
 * The env a spawn merges to run as this account.
 *
 * Account #0 does not "set nothing" — it explicitly CLEARS `CLAUDE_CONFIG_DIR`. The variable
 * cannot express the default (it relocates BOTH `~/.claude.json` and `~/.claude` under one
 * directory, so no value points at the real pair), which leaves removal as the only way to
 * say "the machine's own account". Node omits an `undefined` value from a child's env, so a
 * plain spread over `process.env` still expresses it.
 *
 * MEASURED 2026-09-07, and it is not hypothetical: a probe of the PRIMARY account, run from a
 * process that itself inherited `CLAUDE_CONFIG_DIR` from a sandbox account (any `claude`
 * session exports it, so any dreamcontext command started inside one has it), read the
 * SANDBOX account's usage and attributed it to the primary — 9% session where the primary was
 * at 98%. Nothing downstream can catch that: a usage report carries no identity, and the
 * cache's `accountUuid` was the primary's own. The only place it can be prevented is here.
 */
export function accountEnvFor(
  configDir: string,
  home: string = homedir(),
): Record<string, string | undefined> {
  return isRealHomeConfigDir(configDir, home)
    ? { CLAUDE_CONFIG_DIR: undefined }
    : { CLAUDE_CONFIG_DIR: configDir };
}
