import type { SyncAction } from './sync-engine.js';
import { setGlobalGitHubAuthValid } from './auth-store.js';
import { resolveBrainSyncToken } from './brain-repo.js';
import { classifySyncError } from './failure.js';

/**
 * Reconcile the GLOBAL GitHub session's `needsReconnect` flag off a REAL sync
 * outcome — the ONE place every sync entry point (the server route, the
 * `brain sync` CLI, AND `sleep done`'s autoSync) funnels its auth-health signal
 * through, so the desktop "sign-in expired / Sync failed" banner can never
 * disagree with whether sync actually works.
 *
 * The bug this closes: the flag was reconciled ONLY from the server route. A
 * valid PER-PROJECT token therefore synced cleanly forever via the CLI (agents,
 * autoSync, session-start pull) while the desktop banner — which reads this
 * global flag, cleared by nothing on the CLI path — screamed "reconnect"
 * indefinitely. Two credentials (per-project + global) that can diverge, plus a
 * flag only one code path ever cleared, made a permanent false alarm.
 */

/**
 * Sync outcomes that could only follow a successful fetch/push handshake with the
 * remote — proof the RESOLVED token authenticated. Pre-network outcomes
 * (`no-remote`, `disabled`, `locked`, `invalid-flag`, `skipped-in-tree`,
 * `detached-head`, `user-merge-in-progress`, `already-awaiting-agent`) prove
 * nothing about the token and must never clear a real reconnect flag.
 */
export const AUTH_OK_ACTIONS: ReadonlySet<SyncAction> = new Set<SyncAction>([
  'pulled',
  'pushed',
  'noop',
  'merged',
  'blocked-scrub',
  'awaiting-agent',
  'code-conflict',
]);

/**
 * A sync REACHED the remote ⇒ clear the reconnect flag. A working sync means the
 * user is NOT blocked on auth, whatever token it used — a lingering banner would
 * be a pure false alarm. (Same semantics the server route always had; now every
 * entry point shares it, so a CLI-driven sync clears a stale flag too.)
 */
export function reconcileBrainSyncSuccess(action: SyncAction): void {
  if (AUTH_OK_ACTIONS.has(action)) setGlobalGitHubAuthValid(true);
}

/**
 * A sync FAILED. Raise the global reconnect flag ONLY when the token sync
 * actually resolves to is the GLOBAL one — a per-project or env token failing
 * auth is not something reconnecting the global GitHub sign-in would fix (the fix
 * is `dreamcontext config github-token`), so it must not raise the global banner.
 * A permission error means GitHub ACCEPTED the credential (it just lacks a scope)
 * ⇒ the session is still valid. network / no-token / unknown leave validity
 * untouched.
 */
export function reconcileBrainSyncFailure(rawMessage: string, projectRoot: string, repoHint?: string): void {
  const failure = classifySyncError(rawMessage, repoHint);
  if (failure.kind === 'permission') {
    setGlobalGitHubAuthValid(true);
    return;
  }
  if (failure.kind !== 'auth') return;
  if (resolveBrainSyncToken(projectRoot)?.via === 'global') setGlobalGitHubAuthValid(false);
}
