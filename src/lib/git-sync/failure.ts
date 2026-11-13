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
  /** GitHub is limiting requests: wait, nothing to fix. */
  | 'rate_limited'
  /** git could not run the credential helper (askpass): not a sign-in problem. */
  | 'helper'
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

/** The one place a user fixes GitHub (github-baglanti D5). */
export const RECONNECT_PATH_EN = 'Settings → GitHub → Reconnect';

/** Extra classification context — kept optional so every existing 2-arg call is unchanged. */
export interface ClassifyOpts {
  /**
   * The token that produced this failure is the project's OWN token, which no fallback
   * could heal (no sign-in, or the sign-in failed too). The message then names it and the
   * one place to fix it, instead of "your sign-in expired" about a sign-in never used.
   */
  perProjectToken?: boolean;
}

/**
 * Classify a thrown sync error. `repoHint` (e.g. from `brain status`) names the repo
 * when git's own message doesn't. `opts.perProjectToken` appends a tier-aware note
 * for auth/permission failures. Order matters: the most specific, actionable
 * signals win before the generic network/unknown fallbacks.
 *
 * Pure + deterministic. Backward compatible: `classifySyncError(msg)` and
 * `classifySyncError(msg, hint)` behave exactly as before.
 */
export function classifySyncError(rawMessage: string, repoHint?: string, opts?: ClassifyOpts): SyncFailure {
  const failure = classifyBase(rawMessage, repoHint);
  // A per-project token failing auth/permission: name the shadowing token so the
  // user fixes the RIGHT thing. Never touches network/no-token/push-rejected copy.
  if (opts?.perProjectToken && (failure.kind === 'auth' || failure.kind === 'permission')) {
    return {
      ...failure,
      message:
        failure.kind === 'auth'
          ? `GitHub refused this project's own token and no working sign-in could take over. Sign in with GitHub in ${RECONNECT_PATH_EN.replace(' → Reconnect', '')}.`
          : `${failure.message} This project uses its own GitHub token; you can remove it under ${RECONNECT_PATH_EN.replace(' → Reconnect', '')} → Advanced.`,
    };
  }
  return failure;
}

function classifyBase(rawMessage: string, repoHint?: string): SyncFailure {
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

  // Rate limit: GitHub is slowing requests down (a 403 or 429 carrying a limit). Wait.
  if (/rate limit|secondary rate|abuse detection|\b429\b/i.test(m)) {
    return {
      kind: 'rate_limited',
      recovery: 'retry',
      repo,
      message: 'GitHub is limiting requests right now. Sync retries on its own in a few minutes; nothing was lost.',
    };
  }

  // Permission: authenticated but the token can't write Contents (or the branch is protected).
  if (/Contents\b.*write|permission to .* denied|protected branch|not authorized|remote: Permission|must have push access|403\b/i.test(m)) {
    return {
      kind: 'permission',
      recovery: 'check-permissions',
      repo,
      message: `GitHub refused write access (Contents read & write) to${named || ' this repo'}. Ask the repo's owner for access, then retry.`,
    };
  }

  // The credential helper (askpass) did not run: git fell back to prompting, which is off.
  // This is a local problem, never "your sign-in expired".
  if (/could not read Username|could not read Password|terminal prompts disabled|askpass/i.test(m)) {
    return {
      kind: 'helper',
      recovery: 'retry',
      repo,
      message: 'dreamcontext could not hand your GitHub sign-in to git on this Mac. Retry; if it repeats, restart the app.',
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
      message: 'Cloud sync needs a GitHub account. Sign in with GitHub in Settings → GitHub.',
    };
  }

  // Auth: a real git op authenticated and GitHub REJECTED the credential
  // (expired/revoked/invalid). This is the only path that should say "sign-in expired".
  if (/authentication failed|bad credentials|invalid credentials|401\b|Support for password authentication/i.test(m)) {
    return {
      kind: 'auth',
      recovery: 'reconnect-github',
      repo,
      message: `GitHub no longer accepts your sign-in. Reconnect in ${RECONNECT_PATH_EN}.`,
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

// ─── C5: the GitHub error every dashboard surface reads ─────────────────────

export type GitHubErrorKind = 'auth' | 'forbidden' | 'rate_limited' | 'helper' | 'no_token' | 'desktop_only';

/**
 * One shape for every GitHub failure the dashboard shows (launcher, app share, brain sync,
 * task sync, auth status): the kind, whether ONE click on "Reconnect" fixes it, and a
 * sentence. `reconnect` is true only when the app's sign-in is the credential at fault
 * (a 401 on it) or there is none at all; a project's own token, a 403, a rate limit or a
 * local helper problem is never fixed by signing in again.
 */
export interface GitHubErrorPayload {
  kind: GitHubErrorKind;
  reconnect: boolean;
  message: string;
  detail?: string;
}

const GITHUB_ERROR_MESSAGES: Record<GitHubErrorKind, string> = {
  auth: `GitHub no longer accepts your sign-in. Reconnect in ${RECONNECT_PATH_EN}.`,
  forbidden: 'GitHub accepted your sign-in but refused this request.',
  rate_limited: 'GitHub is limiting requests right now. It retries on its own in a few minutes.',
  helper: 'dreamcontext could not hand your GitHub sign-in to git on this Mac. Retry; if it repeats, restart the app.',
  no_token: 'Sign in with GitHub in Settings → GitHub.',
  desktop_only: 'GitHub is managed in the dreamcontext app.',
};

export function githubErrorPayload(
  kind: GitHubErrorKind,
  source?: 'project' | 'global' | 'env' | null,
  detail?: string,
): GitHubErrorPayload {
  const reconnect = (kind === 'auth' && (source === 'global' || source == null)) || kind === 'no_token';
  const message = kind === 'forbidden' ? githubForbiddenReason(detail) : GITHUB_ERROR_MESSAGES[kind];
  return { kind, reconnect, message, ...(detail ? { detail: detail.slice(0, 300) } : {}) };
}

/**
 * A 403 in plain words, from GitHub's own reason in the response body: the org's SSO, the
 * org's OAuth-app approval, or plain no access. Never "sign in again": none of these is fixed
 * by reconnecting.
 */
export function githubForbiddenReason(detail?: string): string {
  const d = detail ?? '';
  if (/SAML|single sign-on|\bSSO\b/i.test(d)) {
    return 'GitHub refused: this organization requires single sign-on. Authorize dreamcontext for it on GitHub (your Settings → Applications → dreamcontext → Grant), then try again.';
  }
  if (/OAuth App access restrictions|third-party application access|OAuth App.*restrict/i.test(d)) {
    return "GitHub refused: this organization has not approved the dreamcontext app. An owner of the organization approves it once on GitHub.";
  }
  return "GitHub refused: your account has no access to this repository or organization.";
}
