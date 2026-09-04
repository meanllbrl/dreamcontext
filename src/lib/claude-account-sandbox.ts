import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
 * account: no sandbox, no symlink, no mcp-config file, and the only new code their spawn
 * touches is one comparison against `homedir()`.
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

/**
 * Lay one shared symlink, reconciling whatever is there now.
 *
 *   • `correct`      → nothing to do (one `lstat`, the whole steady-state cost).
 *   • `missing` /
 *     `wrong-target` → (re)laid.
 *   • `dangling`     → the TARGET is recreated (e.g. `~/.claude` was wiped), then relaid.
 *   • `real-file`    → **LOUD FAILURE**. Neither skipped silently (that account would sit in
 *                      an isolated transcript store forever, which is the exact bug sharing
 *                      exists to prevent) nor silently overwritten (that would destroy
 *                      whatever accumulated there while the link was broken). The spawn is
 *                      refused for a NAMED reason and the path is reported to the user.
 */
function reconcileShared(linkPath: string, target: string, isDir: boolean): void {
  const state = inspectShared(linkPath, target);
  if (state === 'correct') return;
  if (state === 'real-file') {
    throw new SandboxError(
      `A real file or directory is sitting where a shared Claude path must be a symlink: ${linkPath}\n` +
      `Nothing was changed. Move or delete it (its contents are yours), then try again — ` +
      `overwriting it silently could destroy work, and skipping it would strand this account ` +
      `in a separate transcript store.`,
    );
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
  symlinkSync(target, linkPath, isDir ? 'dir' : 'file');
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
    reconcileShared(join(dir, entry), target, isDir);
  }

  return { configDir: dir, created: isNew };
}

/**
 * The shared MCP config a SANDBOXED spawn is pointed at with `--mcp-config <file>`.
 *
 * Sharing by REFERENCE, not by copy, is the whole point. The sandbox's own `.claude.json` is
 * seeded with NO MCP keys at any depth (see the module header), so without this a sandboxed
 * session would silently lose every MCP server the user has — the opposite of "behaviour is
 * identical". Copying them into each sandbox instead would multiply every MCP secret by the
 * number of accounts; pointing N spawns at ONE 0600 file keeps the blast radius at one.
 *
 * Only the TOP-LEVEL `mcpServers` map is carried. The per-project maps are deliberately left
 * behind: they belong to `projects[<path>]` entries whose trust state is seeded by whitelist,
 * and a project's own `.mcp.json` still applies because `--strict-mcp-config` is deliberately
 * NOT passed.
 *
 * Returns `null` when there is nothing to share, and the caller then passes no flag at all —
 * an empty `--mcp-config` would be a claim about configuration rather than the absence of it.
 */
export function ensureSharedMcpConfig(home: string = homedir()): string | null {
  let servers: unknown = null;
  try {
    servers = asRecord(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8')))?.mcpServers;
  } catch {
    return null;
  }
  const map = asRecord(servers);
  if (!map || Object.keys(map).length === 0) return null;

  const target = join(home, '.dreamcontext', 'claude-accounts', 'mcp-config.json');
  const body = JSON.stringify({ mcpServers: map }, null, 2) + '\n';
  try {
    // Rewritten whenever the source changes, so a server the user added reaches the sandboxes.
    // Compared first: an unchanged file is not rewritten, because this runs before every
    // sandboxed spawn.
    if (existsSync(target) && readFileSync(target, 'utf-8') === body) {
      const mode = statSync(target).mode & 0o777;
      if (mode !== 0o600) chmodSync(target, 0o600);
      return target;
    }
    writeAtomic0600(target, body);
    return target;
  } catch {
    // A config we cannot write is not a reason to refuse the spawn — the session simply runs
    // without the shared servers, which is visible and recoverable.
    return null;
  }
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
