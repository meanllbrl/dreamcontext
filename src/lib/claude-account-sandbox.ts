import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertConfinedConfigDir, isRealHomeConfigDir } from './claude-accounts.js';

/**
 * A per-account `CLAUDE_CONFIG_DIR` sandbox — the directory that makes N accounts signed in
 * AT THE SAME TIME.
 *
 * ── Account #0 bypasses this entire machine ───────────────────────────────────────────
 * The account already signed in to the real `~/.claude` is registered with `configDir: null`
 * and nothing is moved, copied or re-authenticated for it. {@link ensureSandbox} RETURNS
 * IMMEDIATELY, having done nothing, when the resolved directory is `homedir()`.
 *
 * This is not an edge case, it is the MAJORITY PATH: `resolveConfigDir`'s default resolution
 * (no account parameter, no preferred account) is account #0. Read literally WITHOUT this
 * exemption, the reconciliation policy below would refuse EVERY ORDINARY SPAWN, because the
 * real HOME's `projects/` and `settings.json` are genuine files rather than symlinks — the
 * exact opposite of the feature's headline guarantee. For a user who never adds a second
 * account: no sandbox and no symlink, and the only new code their spawn touches here is one
 * comparison against `homedir()`.
 *
 * ── What is isolated, what is shared, what is NEVER copied ────────────────────────────
 * ISOLATE (a real file inside the sandbox): `.claude.json`. It holds `oauthAccount` and
 * `cachedUsageUtilization` — precisely the account's own identity and quota state.
 *
 * SHARE (a symlink back into the real `~/.claude/`): `projects/`, `settings.json`, `skills/`,
 * `agents/`, `plugins/`, `history.jsonl`. Sharing `projects/` is THE ONLY REASON `--resume`
 * keeps working across a switch: measured 2026-09-04, `projectsDirectory` follows the config
 * dir, so a bare sandbox SPLITS the transcript store. The answer is not to isolate it, it is
 * to share it.
 *
 * NEVER COPIED: the MCP configuration, at BOTH levels — the top-level `mcpServers`, and the
 * `mcpServers`/`mcpContextUris`/`enabledMcpjsonServers`/`disabledMcpjsonServers` carried by
 * EACH `projects[<path>]` entry. Measured on this machine: 6 of 27 trusted project entries
 * carry their own NON-EMPTY `mcpServers`. So seeding is a WHITELIST, never a blacklist —
 * a blacklist leaks whatever key the CLI adds next; a whitelist fails closed.
 *
 * Every account, #0 included, gets its MCP servers from dreamcontext's own stores instead
 * (`mcp-store.ts`, `--mcp-config` on every spawn). Nothing is ever written into a sandbox's
 * `.claude.json` for MCP; servers the CLI writes there itself are COPIED into the stores.
 */

/** The paths shared back into the real `~/.claude/`, relative to the sandbox root. */
export const SHARED_SANDBOX_ENTRIES = [
  'projects',
  'settings.json',
  'skills',
  'agents',
  'plugins',
  'history.jsonl',
] as const;

/**
 * The ONLY keys copied out of the real `~/.claude.json` when a sandbox is first seeded.
 * Everything else — identity, usage cache, spend history, and above all MCP configuration —
 * is left behind. Adding a key here is a deliberate act; forgetting to add one costs the
 * user a trust prompt, which is the safe direction to fail in.
 */
export const SEEDED_TOP_LEVEL_KEYS = [
  'hasCompletedOnboarding',
  'hasTrustDialogAccepted',
] as const;

/** Per-`projects[<path>]` keys that may be seeded. Everything else about an entry is dropped. */
export const SEEDED_PROJECT_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
] as const;

/** Keys that must never appear in a sandbox `.claude.json`, at any depth. Asserted by tests. */
export const FORBIDDEN_SANDBOX_KEYS = [
  'mcpServers',
  'mcpContextUris',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
] as const;

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

// ─── Seeding ──────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/**
 * The initial `.claude.json` for a new sandbox, whitelisted out of the real one.
 *
 * The `projects` map is carried so the new account does not re-prompt the trust dialog for
 * every directory the user already trusts — but each entry is REBUILT from
 * {@link SEEDED_PROJECT_KEYS} alone, so no per-project MCP server rides along.
 */
export function buildSeedConfig(realBlob: unknown): Record<string, unknown> {
  const real = asRecord(realBlob);
  const seed: Record<string, unknown> = {};
  if (real) {
    for (const key of SEEDED_TOP_LEVEL_KEYS) {
      if (real[key] !== undefined) seed[key] = real[key];
    }
    const projects = asRecord(real.projects);
    if (projects) {
      const out: Record<string, unknown> = {};
      for (const [path, raw] of Object.entries(projects)) {
        const entry = asRecord(raw);
        if (!entry) continue;
        const kept: Record<string, unknown> = {};
        for (const key of SEEDED_PROJECT_KEYS) {
          if (entry[key] !== undefined) kept[key] = entry[key];
        }
        if (Object.keys(kept).length > 0) out[path] = kept;
      }
      if (Object.keys(out).length > 0) seed.projects = out;
    }
  }
  return seed;
}

/** Atomic 0600 write: temp file (pid+nonce) → `rename`. A reader never sees a half file. */
function writeAtomic0600(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, filePath);
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

/** What a shared path currently is, before we decide what to do about it. */
type SharedState = 'correct' | 'missing' | 'wrong-target' | 'dangling' | 'real-file';

function inspectShared(linkPath: string, target: string): SharedState {
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(linkPath);
  } catch {
    return 'missing';
  }
  if (!link.isSymbolicLink()) return 'real-file';
  let pointsAt: string;
  try {
    pointsAt = resolve(dirname(linkPath), readlinkSync(linkPath));
  } catch {
    return 'missing';
  }
  if (pointsAt !== resolve(target)) return 'wrong-target';
  // The link is right; is what it points AT still there?
  return existsSync(pointsAt) ? 'correct' : 'dangling';
}

/** `base`, or `base.1`, `base.2`, … — the first name nothing sits at yet. */
function freePath(base: string): string {
  if (!lexists(base)) return base;
  for (let n = 1; ; n++) {
    const candidate = `${base}.${n}`;
    if (!lexists(candidate)) return candidate;
  }
}

function lexists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/** Park `src` under the dated backup folder at `rel`, never over anything already there. */
function park(src: string, backupRoot: string, rel: string): void {
  const dest = freePath(join(backupRoot, rel));
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  renameSync(src, dest);
}

/**
 * Move everything in the real directory `src` into `dst` WITHOUT overwriting anything.
 * Never follows a symlink on either side (`lstat` only): a link found in the sandbox is parked
 * as the link itself, and a link found in the real store is treated as a clash, so nothing is
 * ever written through one. A same-name clash keeps both: the real one stays, the sandbox one
 * is parked in the backup. A path that vanished meanwhile (a second spawn healing the same
 * sandbox) is skipped.
 */
function mergeInto(src: string, dst: string, backupRoot: string, rel: string): void {
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    const relName = join(rel, name);
    let fromStat: ReturnType<typeof lstatSync>;
    try { fromStat = lstatSync(from); } catch { continue; }
    let toStat: ReturnType<typeof lstatSync> | null = null;
    try { toStat = lstatSync(to); } catch { /* free: move it straight in */ }

    if (fromStat.isSymbolicLink()) { park(from, backupRoot, relName); continue; }
    if (toStat === null) { renameSync(from, to); continue; }
    if (fromStat.isDirectory() && toStat.isDirectory()) {
      mergeInto(from, to, backupRoot, relName);
      try { rmdirSync(from); } catch { /* not empty: whatever is left stays where it was */ }
      continue;
    }
    park(from, backupRoot, relName);
  }
}

/**
 * Where a heal keeps what it could not merge: OUTSIDE the sandbox, because removing an account
 * deletes its sandbox whole (`removeClaudeAccount`), and a backup must outlive that.
 * `~/.dreamcontext/claude-account-backups/<id>/backup-<date>/`.
 */
export function sandboxBackupDir(sandboxDir: string, home: string = homedir(), now: Date = new Date()): string {
  return join(home, '.dreamcontext', 'claude-account-backups', basename(sandboxDir), `backup-${now.toISOString().slice(0, 10)}`);
}

/**
 * A real file or directory sits where a shared link belongs. It got there because a `claude`
 * ran with this `CLAUDE_CONFIG_DIR` before the links existed (the CLI creates `projects/`
 * and `plugins/` itself). Heal it instead of locking the account out:
 *   • a directory is MERGED into the real `~/.claude/<entry>` (nothing overwritten; a clash
 *     keeps both, the sandbox copy in {@link sandboxBackupDir}), then removed;
 *   • a file: the real one wins, the sandbox one is backed up (or moved in, when the real one
 *     does not exist yet).
 *
 * The stray entry is first RENAMED to a private staging name and merged only from there. Two
 * processes healing the same sandbox at once (the app server and an automation) would
 * otherwise race: once one lays the link, the other's paths would run THROUGH it and move the
 * real store's own files into the backup. Only the process that wins the rename merges; the
 * loser re-inspects. The real store must resolve to `~/.claude/<entry>` (realpath containment),
 * so a planted link can never redirect where the files go.
 */
function healRealEntry(linkPath: string, target: string, realClaudeDir: string, entry: string, home: string): void {
  const sandboxDir = dirname(linkPath);
  const backupRoot = sandboxBackupDir(sandboxDir, home);
  const staging = join(sandboxDir, `.healing-${entry}-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    renameSync(linkPath, staging);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // another process took it
    throw err;
  }
  const staged = lstatSync(staging);
  if (staged.isSymbolicLink()) {
    // Lost a race to a process that had just laid the link: put it back, or drop our copy.
    try { renameSync(staging, linkPath); } catch { rmSync(staging, { force: true }); }
    return;
  }
  try {
    mergeStaged(staging, staged.isDirectory(), target, realClaudeDir, entry, backupRoot);
  } catch (err) {
    // Whatever was not moved yet goes back where the user would look for it, or, when a racing
    // heal already relaid the link there, to the backup (never left inside the sandbox, which
    // removing the account deletes).
    if (lexists(staging)) {
      try {
        if (!lexists(linkPath)) renameSync(staging, linkPath);
        else park(staging, backupRoot, entry);
      } catch { /* left at its staging name; nothing deleted */ }
    }
    throw err;
  }
}

function mergeStaged(staging: string, isDir: boolean, target: string, realClaudeDir: string, entry: string, backupRoot: string): void {
  if (!lexists(target) && isDir) mkdirSync(target, { recursive: true });
  if (lexists(target) && realpathSync(target) !== join(realpathSync(realClaudeDir), entry)) {
    throw new Error(`${target} does not resolve inside ${realClaudeDir}`);
  }

  if (isDir) {
    if (!lstatSync(target).isDirectory()) { park(staging, backupRoot, entry); return; }
    mergeInto(staging, target, backupRoot, entry);
    // Anything still here could not be merged by name; it is kept, never deleted.
    if (readdirSync(staging).length === 0) rmdirSync(staging);
    else park(staging, backupRoot, entry);
    return;
  }
  if (!lexists(target)) {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
    return;
  }
  park(staging, backupRoot, entry);
}

/**
 * Lay one shared symlink, reconciling whatever is there now.
 *
 *   • `correct`      → nothing to do (one `lstat`, the whole steady-state cost).
 *   • `missing` /
 *     `wrong-target` → (re)laid.
 *   • `dangling`     → the TARGET is recreated (e.g. `~/.claude` was wiped), then relaid.
 *   • `real-file`    → HEALED ({@link healRealEntry}): its contents join the real store,
 *                      nothing is overwritten, clashes are kept in a dated backup outside the
 *                      sandbox, then the link is laid. Refused only when that move itself
 *                      fails, with what to do, the stray entry back where it was.
 */
function reconcileShared(linkPath: string, target: string, isDir: boolean, realClaudeDir: string, entry: string, home: string, attempt = 0): void {
  let state = inspectShared(linkPath, target);
  if (state === 'correct') return;
  if (state === 'real-file') {
    try {
      healRealEntry(linkPath, target, realClaudeDir, entry, home);
    } catch (err) {
      throw new SandboxError(
        `This Claude account's folder could not be tidied up: ${linkPath}\n` +
        `Its files were not deleted (${(err as Error).message}). Quit dreamcontext, move that ` +
        `folder to your Desktop, then open dreamcontext again; it rebuilds the folder by itself.`,
      );
    }
    state = inspectShared(linkPath, target);
    if (state === 'correct') return;
  }
  if (state === 'dangling' || !existsSync(target)) {
    // The shared target itself is gone. Recreate it so the link is not born broken.
    if (isDir) mkdirSync(target, { recursive: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(target)) writeFileSync(target, '', { encoding: 'utf-8', mode: 0o600 });
    }
  }
  if (state === 'wrong-target' || state === 'dangling') {
    rmSync(linkPath, { force: true });
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    symlinkSync(target, linkPath, isDir ? 'dir' : 'file');
  } catch (err) {
    // Another spawn healing the same sandbox got there first: look again (a few times, as a
    // racing heal can hold the path at its staging name for a moment).
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      if (inspectShared(linkPath, target) === 'correct') return;
      if (attempt < 5) return reconcileShared(linkPath, target, isDir, realClaudeDir, entry, home, attempt + 1);
    }
    throw err;
  }
}

// ─── The entry point ──────────────────────────────────────────────────────────

export interface EnsureSandboxResult {
  /** The directory a spawn should use. Equals `home` for account #0. */
  configDir: string;
  /** False for account #0 (nothing was inspected) and for a no-op reconcile. */
  created: boolean;
}

/**
 * Make `configDir` usable as an account's credential store, then return it.
 *
 * Called SYNCHRONOUSLY BEFORE EVERY account-scoped spawn — chat, automation, usage probe,
 * login — and NOT only at creation time. If it only ran at creation, a symlink broken later
 * would never be repaired: the CLI would open a REAL `projects/` at that path and the
 * transcript split this design exists to prevent would come back silently. The steady-state
 * cost is one `lstat` per shared path.
 *
 * Idempotent AND self-healing. The seeded `.claude.json` is CREATE-ONCE: if the file already
 * exists it is not touched at all, because rewriting it on every spawn would clobber the
 * account's identity and its usage cache.
 */
export function ensureSandbox(configDir: string, home: string = homedir()): EnsureSandboxResult {
  // ── Account #0: do nothing, immediately. See the module header.
  if (isRealHomeConfigDir(configDir, home)) return { configDir: resolve(home), created: false };

  const dir = assertConfinedConfigDir(configDir, home);
  const realClaudeDir = join(home, '.claude');
  const isNew = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // ── Isolated: `.claude.json`, seeded exactly once.
  const isolated = join(dir, '.claude.json');
  if (!existsSync(isolated)) {
    let realBlob: unknown = null;
    try {
      realBlob = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'));
    } catch { /* no real config to seed from — an empty seed is correct */ }
    writeAtomic0600(isolated, JSON.stringify(buildSeedConfig(realBlob), null, 2) + '\n');
  } else {
    // DRIFT DETECTOR, not a fix for a known hole: measured, the CLI writes this file 0600
    // itself even under umask 022. The mode is pulled back if something widened it; the
    // CONTENT is never touched.
    try {
      const mode = statSync(isolated).mode & 0o777;
      if (mode !== 0o600) chmodSync(isolated, 0o600);
    } catch { /* the file vanished under us; the next spawn re-seeds it */ }
  }

  // ── Shared: symlinks back into the real `~/.claude/`.
  for (const entry of SHARED_SANDBOX_ENTRIES) {
    const target = join(realClaudeDir, entry);
    const isDir = entry.indexOf('.') === -1;
    reconcileShared(join(dir, entry), target, isDir, realClaudeDir, entry, home);
  }

  return { configDir: dir, created: isNew };
}

/**
 * Does this sandbox still hold a credential at all?
 *
 * A sandbox deleted by hand is recreated and re-seeded by {@link ensureSandbox}, but its
 * IDENTITY is gone — so the account is not an ordinary "signed out", it is a distinct
 * needs-relogin state the UI must name. This is the cheap trigger for that; the authoritative
 * answer is `claudeAuthStatus(configDir)`.
 */
export function sandboxHasIdentity(configDir: string, home: string = homedir()): boolean {
  if (isRealHomeConfigDir(configDir, home)) return true;
  try {
    const blob = JSON.parse(readFileSync(join(assertConfinedConfigDir(configDir, home), '.claude.json'), 'utf-8')) as unknown;
    return asRecord(asRecord(blob)?.oauthAccount) !== null;
  } catch {
    return false;
  }
}
