/**
 * Failure classification for the brain-repo sync engine. Network/auth/remote-state
 * failures can never be made impossible — the bar (github-cloud-collaboration-brain-repo-sync
 * hardening) is that EVERY failure is surfaced clearly, loses no local work, and
 * offers a CONCRETE recovery. This maps a raw `GitSyncError` message (which carries
 * git's stderr) — or a `no-remote` engine note — to a specific, user-facing failure
 * with a named recovery affordance the dashboard renders.
 *
 * Pure + deterministic (regex over the message). Never leaks the token: the engine's
 * GitSyncError messages are already token-free (credentials never touch the URL/argv).
 */

export type SyncFailureKind =
  /** Expired/invalid token — the account is connected but GitHub rejected it; reconnect. */
  | 'auth'
  /** No token is configured at all — not signed in yet (distinct from an EXPIRED one). */
  | 'no-token'
  /** Authenticated, but the token lacks Contents write on the repo (or a protected branch). */
  | 'permission'
  /** Offline / DNS / unreachable host — transient; retry later. */
  | 'network'
  /** Two pushes rejected as non-fast-forward — the remote is still ahead. */
  | 'push-rejected'
  /** Histories diverged / another operational error we can't auto-recover. */
  | 'unknown';

export type SyncRecovery =
  /** Re-authenticate with GitHub (reuse the GitHubLogin surface). */
  | 'reconnect-github'
  /** Fix the token's repo permissions (Contents write). */
  | 'check-permissions'
  /** Nothing to do now — it will retry when back online / on next sync. */
  | 'wait-online'
  /** Re-run the sync (a transient race — non-fast-forward). */
  | 'retry'
  /** Needs a human to resolve manually (unrelated histories, etc). */
  | 'manual';

export interface SyncFailure {
  kind: SyncFailureKind;
  recovery: SyncRecovery;
  /** Concise, user-facing sentence. Names the repo + scope where we can. */
  message: string;
  /** `owner/repo`, when we could name it (permission errors). */
  repo?: string;
}

/** `owner/repo` out of a github.com URL/SSH form, or null. */
function githubSlug(s: string): string | undefined {
  const m = s.match(/github\.com[/:]([^/\s]+\/[^/\s'".]+)/i);
  return m ? m[1].replace(/\.git$/, '') : undefined;
}

/** Pull an `owner/repo` out of git's "Permission to owner/repo.git denied" phrasing, a URL, or the hint. */
function extractRepo(message: string, fallbackRepo?: string): string | undefined {
  const perm = message.match(/Permission to ([^\s]+?)(?:\.git)? denied/i);
  if (perm) return perm[1];
  const fromMsg = githubSlug(message);
  if (fromMsg) return fromMsg;
  if (fallbackRepo) return githubSlug(fallbackRepo) ?? fallbackRepo;
  return undefined;
}

/**
 * Classify a thrown sync error. `repoHint` (e.g. from `brain status`) names the repo
 * when git's own message doesn't. Order matters: the most specific, actionable
 * signals win before the generic network/unknown fallbacks.
 */
export function classifySyncError(rawMessage: string, repoHint?: string): SyncFailure {
  const m = rawMessage || '';
  const repo = extractRepo(m, repoHint);
  const named = repo ? ` on ${repo}` : '';

  // Two failed pushes in a row (the engine's C4 loud error) — a transient race; retry.
  if (/non-fast-forward.*twice|rejected.*non-fast-forward|Push rejected \(non-fast-forward\) twice/i.test(m)) {
    return {
      kind: 'push-rejected',
      recovery: 'retry',
      repo,
      message: 'The team pushed while your sync was in flight. Retry — dreamcontext will merge their changes and push again.',
    };
  }

  // Permission: authenticated but the token can't write Contents (or the branch is protected).
  if (/Contents\b.*write|permission to .* denied|protected branch|not authorized|remote: Permission|must have push access|403\b/i.test(m)) {
    return {
      kind: 'permission',
      recovery: 'check-permissions',
      repo,
      message: `Your GitHub token can't write to${named || ' this repo'}. Give it Contents (read & write) access${repo ? ` on ${repo}` : ''}, then retry.`,
    };
  }

  // No token configured at all — NOT an expired sign-in. This comes from the
  // engine's `no-remote` note ("No GitHub token found …"), a state check, never a
  // rejected git op. It must not read "expired or invalid" (which would falsely
  // alarm a signed-in user); it's simply "not connected yet".
  if (/no github token found|no token found for the brain/i.test(m)) {
    return {
      kind: 'no-token',
      recovery: 'reconnect-github',
      repo,
      message: 'Cloud sync needs a GitHub account. Connect GitHub to start syncing.',
    };
  }

  // Auth: a real git op authenticated and GitHub REJECTED the credential
  // (expired/revoked/invalid). This is the only path that should say "sign-in expired".
  if (/authentication failed|could not read Username|bad credentials|invalid credentials|401\b|terminal prompts disabled|Support for password authentication/i.test(m)) {
    return {
      kind: 'auth',
      recovery: 'reconnect-github',
      repo,
      message: 'Your GitHub sign-in expired or is invalid. Reconnect GitHub to keep syncing.',
    };
  }

  // Network: offline / DNS / unreachable.
  if (/could ?n[o']t resolve host|could not resolve host|connection timed out|failed to connect|network is unreachable|temporary failure in name resolution|unable to access .*(?:Could not resolve|timed out|Failed to connect)|getaddrinfo|ENOTFOUND|ETIMEDOUT/i.test(m)) {
    return {
      kind: 'network',
      recovery: 'wait-online',
      repo,
      message: "You're offline — sync will retry automatically when you're back online. Nothing was lost.",
    };
  }

  // Unrelated histories (attach mismatch) — a genuine human decision.
  if (/unrelated histories/i.test(m)) {
    return {
      kind: 'unknown',
      recovery: 'manual',
      repo,
      message: 'The remote contains content that did not come from this brain (e.g. a README). Attach an empty repo or reconcile the histories manually.',
    };
  }

  return {
    kind: 'unknown',
    recovery: 'retry',
    repo,
    message: rawMessage.trim() || 'Sync failed. Retry, or check your connection and GitHub access.',
  };
}
