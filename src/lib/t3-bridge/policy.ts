/**
 * Our chat permission modes → T3's runtime policy for a Codex turn (plan r5 §6).
 *
 * Load-bearing rule: our `auto` maps to T3's `auto-accept-edits` (approvals reviewer `user`,
 * approval policy `on-request`), NEVER to T3's `auto`. T3's `auto` sets
 * `approvalsReviewer: "auto_review"`, a model that approves sandbox escapes and blocked network
 * access, and a runtime policy cannot override it — every rule below would become best-effort.
 * `codex-runtime-policy.test.ts` pins the `turn/start` parameters per mode.
 *
 * In auto the sandbox is `workspaceWrite` with ONLY these writable roots: the project, its linked
 * code repos (and their worktrees), and a private per-process temp folder. Shared `$TMPDIR` and
 * `/tmp` are excluded, network is off (so the dashboard port is unreachable), and anything under
 * `~/.dreamcontext` is refused as a root even when it was asked for.
 */
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import nodePath, { isAbsolute, join } from 'node:path';
import { linkedWritableRoots } from './roots.js';
import { memberFileWriteTarget, ownerStoreWriteTarget } from '../agents/member-file-guard.js';
import { movesGuardedPlace } from '../antigravity-gate.js';
import { isMarketingEnvPath } from '../marketing/path-guards.js';

export type ChatPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
export type T3RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';

export interface CodexRuntimePolicy {
  readonly runtimeMode: T3RuntimeMode;
  readonly interactionMode: 'default' | 'plan';
  readonly cwd: string | null;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}

export interface PolicyInput {
  readonly mode: string;
  readonly cwd: string;
  /** Extra roots the session may write (linked code repos, their worktrees). */
  readonly extraRoots?: readonly string[];
  /** The private per-process temp folder handed to Codex as TMPDIR. */
  readonly privateTmp?: string | null;
  readonly home?: string;
}

/**
 * Our modes → T3's Claude runtime modes, one to one: unlike Codex, T3's `auto` here IS Claude's
 * own auto mode, the one our chats run today. Claude keeps its own permission rules, so no
 * sandbox policy is added on top (`--permission-mode` semantics stay Claude's).
 */
export function claudeRuntimePolicy(input: { mode: string; cwd: string }): CodexRuntimePolicy {
  const mode = normalizeMode(input.mode);
  const cwd = input.cwd || null;
  switch (mode) {
    case 'bypassPermissions': return { runtimeMode: 'full-access', interactionMode: 'default', cwd };
    case 'auto': return { runtimeMode: 'auto', interactionMode: 'default', cwd };
    case 'acceptEdits': return { runtimeMode: 'auto-accept-edits', interactionMode: 'default', cwd };
    case 'plan': return { runtimeMode: 'approval-required', interactionMode: 'plan', cwd };
    default: return { runtimeMode: 'approval-required', interactionMode: 'default', cwd };
  }
}

/**
 * Antigravity has no OS sandbox, so the roots, network and deny rules of Codex's
 * `auto` cannot hold on it. Every mode but Bypass therefore asks: edits and commands each come to
 * the owner as an approval card, and nothing runs wider than it does today.
 */
export function instanceRuntimePolicy(input: { mode: string; cwd: string }): CodexRuntimePolicy {
  // Bypass too: T3 fixes the agent's mode once, at session start, so a `yolo` agent would stay so
  // after the owner turned Bypass off. The agent always asks, and the bridge answers for Bypass.
  return { runtimeMode: 'approval-required', interactionMode: normalizeMode(input.mode) === 'plan' ? 'plan' : 'default', cwd: input.cwd || null };
}

/**
 * What Bypass still brings to the owner: the writes Claude's PreToolUse hook refuses even in bypass
 * (marketing tokens, AI Team member files). This tool has no hooks, so the card is the gate.
 */
export function bypassNeedsOwner(tool: string, input: unknown, cwd: string): boolean {
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = typeof record.file_path === 'string' ? record.file_path : '';
  // An edit that names no real path cannot be judged, so the owner judges it.
  if (tool === 'Edit' && !/[\\/]/.test(path)) return true;
  return /marketing[\\/]+\.env/i.test(JSON.stringify(record))
    || /config[\\/]+hooks\.json/i.test(JSON.stringify(record))
    // The owner's permission and approval stores (G3): a call that so much as names them is his
    // to judge, like the token file above, since this tool has no hook reading the shell for us.
    || OWNER_STORE_NAMED.test(JSON.stringify(record))
    || (!!path && isMarketingEnvPath(isAbsolute(path) ? path : join(cwd, path)))
    || movesGuardedPlace(tool, record, cwd)
    || !!memberFileWriteTarget(tool, record, cwd)
    || !!ownerStoreWriteTarget(tool, record, cwd);
}

/** The grant store or the approval registry, named anywhere in a call's input. */
const OWNER_STORE_NAMED = /\.dreamcontext[\\/]+(?:grants\b|automations\.json)/i;

/**
 * The agent-writable roots a grant's script form is judged against (grants `EligibleCtx.roots`):
 * the project, its linked repos and their worktrees, and the temp folders. ONE list for the
 * writer of a grant and both enforcers: a script outside it, or an interpreter inside it, is
 * Allow once only. A root that cannot be read is left out, which only asks again, never allows more.
 */
export function grantRoots(project: string, o: { home?: string; tmp?: readonly string[] } = {}): string[] {
  const out: string[] = [];
  const add = (p: string | null | undefined): void => {
    if (!p || !isAbsolute(p)) return;
    let real = p;
    try { real = realpathSync.native(p); } catch { return; }
    if (!out.includes(real)) out.push(real);
  };
  add(project);
  try { for (const r of linkedWritableRoots(project, o.home ? { home: o.home } : {})) add(r); } catch { /* the project alone */ }
  for (const t of o.tmp ?? ['/tmp', '/private/tmp', tmpdir()]) add(t);
  return out;
}

/** Normalize anything the client may send to one of our five modes (unknown → `default`). */
export function normalizeMode(mode: string): ChatPermissionMode {
  return mode === 'acceptEdits' || mode === 'plan' || mode === 'auto' || mode === 'bypassPermissions' ? mode : 'default';
}

/** The path flavour a check runs in: the host's, or `path.win32` / `path.posix` in a test. */
export type PathApi = Pick<typeof nodePath, 'isAbsolute' | 'resolve' | 'join' | 'parse' | 'sep'>;
/** Windows paths compare without case (`C:\Users\X\.DreamContext` is the same folder). */
const pathKey = (p: PathApi, s: string): string => (p.sep === '\\' ? s.toLowerCase() : s);

/** True when `p` is `~/.dreamcontext` or inside it: never a writable root for a sandboxed tool. */
export function isUnderDreamcontextHome(p: string, home: string = homedir(), paths: PathApi = nodePath): boolean {
  const base = pathKey(paths, paths.resolve(paths.join(home, '.dreamcontext')));
  const abs = pathKey(paths, paths.resolve(p));
  return abs === base || abs.startsWith(base + paths.sep);
}

/** The writable roots for a sandboxed (auto / acceptEdits) Codex turn. */
export function writableRoots(input: PolicyInput, paths: PathApi = nodePath): string[] {
  const home = input.home ?? homedir();
  const roots = [input.cwd, ...(input.extraRoots ?? []), ...(input.privateTmp ? [input.privateTmp] : [])];
  const out: string[] = [];
  for (const r of roots) {
    if (!r || !paths.isAbsolute(r)) continue;
    const abs = paths.resolve(r);
    if (isUnderDreamcontextHome(abs, home, paths)) continue;
    // A root that wide is no sandbox at all: `/`, a Windows drive (`C:\`) or share root, the home.
    if (abs === paths.parse(abs).root || pathKey(paths, abs) === pathKey(paths, paths.resolve(home))) continue;
    if (!out.some((o) => pathKey(paths, o) === pathKey(paths, abs))) out.push(abs);
  }
  return out;
}

export function codexRuntimePolicy(input: PolicyInput): CodexRuntimePolicy {
  const mode = normalizeMode(input.mode);
  const cwd = input.cwd || null;
  switch (mode) {
    case 'bypassPermissions':
      // The same trust as Claude bypass: full access, no approvals.
      return { runtimeMode: 'full-access', interactionMode: 'default', cwd };
    case 'auto':
    case 'acceptEdits':
      return {
        runtimeMode: 'auto-accept-edits',
        interactionMode: 'default',
        cwd,
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: writableRoots(input),
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      };
    case 'plan':
      return { runtimeMode: 'approval-required', interactionMode: 'plan', cwd };
    default:
      return { runtimeMode: 'approval-required', interactionMode: 'default', cwd };
  }
}
