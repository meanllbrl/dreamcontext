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
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

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

/** Normalize anything the client may send to one of our five modes (unknown → `default`). */
export function normalizeMode(mode: string): ChatPermissionMode {
  return mode === 'acceptEdits' || mode === 'plan' || mode === 'auto' || mode === 'bypassPermissions' ? mode : 'default';
}

/** True when `p` is `~/.dreamcontext` or inside it: never a writable root for a sandboxed tool. */
export function isUnderDreamcontextHome(p: string, home: string = homedir()): boolean {
  const base = resolve(join(home, '.dreamcontext'));
  const abs = resolve(p);
  return abs === base || abs.startsWith(base + sep);
}

/** The writable roots for a sandboxed (auto / acceptEdits) Codex turn. */
export function writableRoots(input: PolicyInput): string[] {
  const home = input.home ?? homedir();
  const roots = [input.cwd, ...(input.extraRoots ?? []), ...(input.privateTmp ? [input.privateTmp] : [])];
  const out: string[] = [];
  for (const r of roots) {
    if (!r || !isAbsolute(r)) continue;
    const abs = resolve(r);
    if (isUnderDreamcontextHome(abs, home)) continue;
    if (abs === '/' || abs === resolve(home)) continue; // a root that wide is no sandbox at all
    if (!out.includes(abs)) out.push(abs);
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
