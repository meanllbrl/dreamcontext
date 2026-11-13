import {
  demoteProjectGitHubToken,
  readGlobalGitHubCredential,
  reportGitHubAuthOutcome,
  type GitHubAuthOutcomeKind,
  type GitHubCredential,
  type GitHubPurpose,
} from './auth-store.js';
import { withGitCredentials } from './credentials.js';
import { classifySyncError } from './failure.js';

/**
 * C2, the ONE dead-credential heal (github-baglanti D2), for git (brain sync) and REST
 * (the task backend, app share) alike.
 *
 * The bug it closes: a per-project `github.token` wins resolution, so once it dies (revoked,
 * expired) it shadows the working sign-in forever, and every sync fails while Settings is
 * green. The session holds the current credential; when GitHub rejects a per-project token
 * that differs from the sign-in, it retries ONCE with the sign-in, swaps the token in place
 * for the rest of the run and demotes the project token:
 *  - `auth` (401): dead for every purpose (`all`);
 *  - `forbidden` (a 403 that is not a rate limit): demoted for THIS purpose only, since a
 *    repo-scoped PAT may still serve the task backend;
 *  - `rate_limited`: never a retry on another token, never a demotion.
 * The demotion is written only once the retry with the sign-in worked; if it failed too,
 * nothing is demoted and the run keeps its own token. Nothing is ever deleted. Every outcome of the sign-in (the retry's included) goes to the
 * one flag writer (C3) as `('global', …)`; other tokens' outcomes say nothing about it.
 *
 * Token hygiene: values flow only through `withGitCredentials` (askpass) or the request
 * header the caller builds; never into a message, note or error.
 */

/** The kinds the heal decides on. */
export type GitHubRejectKind = 'auth' | 'forbidden' | 'rate_limited' | 'other';

/** True when the credential is this project's own token (the slot that can shadow the sign-in). */
export function isPerProjectToken(t: { source: string } | null | undefined): boolean {
  return !!t && t.source === 'project';
}

/** git-sync's classification, in the session's terms. */
export function classifyGitReject(err: unknown): GitHubRejectKind {
  const kind = classifySyncError((err as Error)?.message ?? String(err)).kind;
  if (kind === 'auth') return 'auth';
  if (kind === 'permission') return 'forbidden';
  if (kind === 'rate_limited') return 'rate_limited';
  return 'other';
}

/** The longest a GitHub rate-limit 403 makes one request wait before its retry. */
const GITHUB_RATE_LIMIT_WAIT_CAP_MS = 60_000;

/**
 * C4: GitHub answers rate limits with a 403 too. A 403 with `x-ratelimit-remaining: 0`,
 * `retry-after`, or a body naming a (secondary) rate limit / abuse detection is a wait,
 * never a dead credential; any other 403 is `forbidden` (SSO, an org's OAuth-app policy,
 * no access) and carries GitHub's own reason.
 */
export function classifyGitHubReject(
  status: number,
  headers: Headers,
  body: string,
): { kind: 'auth' | 'forbidden' | 'rate_limited'; retryAfterMs?: number | null } | null {
  if (status === 401) return { kind: 'auth' };
  if (status !== 403) return null;
  const remaining = headers.get('x-ratelimit-remaining');
  const retryAfter = Number(headers.get('retry-after'));
  if (remaining === '0' || (Number.isFinite(retryAfter) && retryAfter > 0) || /rate limit|abuse detection/i.test(body)) {
    let wait: number | null = null;
    if (Number.isFinite(retryAfter) && retryAfter > 0) wait = retryAfter * 1000;
    else {
      const reset = Number(headers.get('x-ratelimit-reset'));
      if (Number.isFinite(reset) && reset > 0) wait = Math.max(1000, reset * 1000 - Date.now());
    }
    return { kind: 'rate_limited', retryAfterMs: wait === null ? null : Math.min(wait, GITHUB_RATE_LIMIT_WAIT_CAP_MS) };
  }
  if (/bad credentials/i.test(body)) return { kind: 'auth' };
  return { kind: 'forbidden' };
}

/** Injectable deps so tests need no real git, network or fs. */
export interface GitHubAuthSessionDeps {
  withGitCredentials: typeof withGitCredentials;
  readGlobalGitHubCredential: () => GitHubCredential | null;
  demoteProjectGitHubToken: typeof demoteProjectGitHubToken;
  reportGitHubAuthOutcome: (o: { source: GitHubCredential['source']; fingerprint: string; kind: GitHubAuthOutcomeKind }) => void;
}

const defaultDeps: GitHubAuthSessionDeps = {
  withGitCredentials,
  readGlobalGitHubCredential: () => readGlobalGitHubCredential(),
  demoteProjectGitHubToken,
  reportGitHubAuthOutcome: (o) => reportGitHubAuthOutcome(o),
};

export class GitHubAuthSession {
  private active: GitHubCredential;
  /** The one fallback attempt is consumed on first use, success or failure: never a loop. */
  private fallbackConsumed = false;
  private healed = false;
  /** Fingerprints whose success was already reported (one write per token per run). */
  private reportedOk = new Set<string>();
  /** Set once the current credential got a 401 nothing could heal: the run should stop. */
  private deadReject: GitHubRejectKind | null = null;
  /** The swap waiting for its retry: demoted only once the sign-in actually worked. */
  private pending: { failed: GitHubCredential; scope: GitHubPurpose | 'all' } | null = null;
  private readonly deps: GitHubAuthSessionDeps;

  constructor(
    initial: GitHubCredential,
    private readonly purpose: GitHubPurpose,
    private readonly projectRoot: string | undefined,
    deps: Partial<GitHubAuthSessionDeps> = {},
  ) {
    this.active = initial;
    this.deps = { ...defaultDeps, ...deps };
  }

  /** True once a dead/forbidden project token was replaced by a WORKING sign-in (and demoted, kept on disk). */
  get healedStaleProjectToken(): boolean {
    return this.healed;
  }

  /** The credential every request currently uses: read it per request, it swaps after a heal. */
  get current(): GitHubCredential {
    return this.active;
  }

  /** The token the session is currently authenticating with (a value for headers/askpass only). */
  get token(): string {
    return this.active.token;
  }

  /** True after a 401 that no fallback could heal: further requests with this token are pointless. */
  get authDead(): boolean {
    return this.deadReject === 'auth';
  }

  /** Report a success of the current credential (once per token). */
  noteSuccess(): void {
    if (this.pending) {
      // The retry with the sign-in worked: the project token was the culprit. Demote it
      // (machine-local hash marker), never delete it: it may be another purpose's credential.
      const { failed, scope } = this.pending;
      this.pending = null;
      this.healed = true;
      try {
        if (this.projectRoot) this.deps.demoteProjectGitHubToken(this.projectRoot, failed.token, scope);
      } catch {
        // An unwritable state dir never turns a recovered run into a failure.
      }
    }
    const c = this.active;
    if (this.reportedOk.has(c.fingerprint)) return;
    this.reportedOk.add(c.fingerprint);
    this.deps.reportGitHubAuthOutcome({ source: c.source, fingerprint: c.fingerprint, kind: 'ok' });
  }

  /**
   * A request with the current credential was rejected. Returns true when the caller should
   * retry it once (the session switched to the sign-in); false = surface the error.
   */
  handleReject(kind: GitHubRejectKind): boolean {
    const failed = this.active;
    const global = this.fallbackCandidate(kind);
    if (!global) {
      this.deps.reportGitHubAuthOutcome({ source: failed.source, fingerprint: failed.fingerprint, kind });
      if (kind === 'auth') this.deadReject = 'auth';
      return false;
    }
    this.fallbackConsumed = true;
    this.active = global;
    this.pending = { failed, scope: kind === 'auth' ? 'all' : this.purpose };
    return true;
  }

  /**
   * The retry after {@link handleReject} also failed: report the sign-in's own outcome
   * (a 401 on the retry raises the flag) and mark the run dead on a 401.
   */
  handleRetryReject(kind: GitHubRejectKind): void {
    const c = this.active;
    this.deps.reportGitHubAuthOutcome({ source: c.source, fingerprint: c.fingerprint, kind });
    // The sign-in failed too: nothing is demoted and the run goes on with what it had.
    if (this.pending) {
      this.active = this.pending.failed;
      this.pending = null;
    }
    if (kind === 'auth') this.deadReject = 'auth';
  }

  /**
   * Run one credentialed git network op through askpass, with the heal. On a retry that
   * also fails, the ORIGINAL error surfaces and nothing more is demoted.
   */
  async run<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T> | T): Promise<T> {
    let result: T;
    try {
      result = await this.deps.withGitCredentials(this.active.token, fn);
    } catch (err) {
      if (!this.handleReject(classifyGitReject(err))) throw err;
      // `handleReject` swapped to the sign-in; the demotion waits for this retry to work.
      try {
        result = await this.deps.withGitCredentials(this.active.token, fn);
      } catch (retryErr) {
        this.handleRetryReject(classifyGitReject(retryErr));
        throw err;
      }
    }
    this.noteSuccess();
    return result;
  }

  /**
   * Guards, in order: the one attempt not used → the failing token is the project's own →
   * the reject is `auth` or `forbidden` (never `rate_limited`) → a sign-in exists whose value
   * differs.
   */
  private fallbackCandidate(kind: GitHubRejectKind): GitHubCredential | null {
    if (this.fallbackConsumed) return null;
    if (!isPerProjectToken(this.active)) return null;
    if (kind !== 'auth' && kind !== 'forbidden') return null;
    const global = this.deps.readGlobalGitHubCredential();
    if (!global || global.token === this.active.token) return null;
    return global;
  }
}
