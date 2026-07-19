import type { ResolvedToken } from '../task-backend/secrets.js';
import { demoteProjectGitHubToken } from './brain-repo.js';
import { readGlobalGitHubToken } from './auth-store.js';
import { withGitCredentials } from './credentials.js';
import { classifySyncError } from './failure.js';

/**
 * Stale-per-project-token self-heal for the brain sync engine.
 *
 * The bug this closes: `resolveBrainSyncToken` resolves the token per-project
 * (`_dream_context/state/.secrets.json`) → global (`~/.dreamcontext/.secrets.json`)
 * → env. A STALE per-project token (e.g. weeks old, since revoked for the
 * connected repo) keeps WINNING resolution and shadowing the fresh token the
 * user just re-signed-in with (which only ever lands in the GLOBAL tier). Every
 * sync then fails auth/permission forever, and re-signing-in does nothing —
 * misleading and unrecoverable from the UI.
 *
 * The fix: wrap every credentialed git NETWORK op in a `BrainSyncTokenSession`.
 * When an op fails AND the failure classifies as `auth`/`permission` AND the
 * ACTIVE token came from the per-project tier AND a DIFFERING global token
 * exists, retry that ONE op once with the global token. On success: switch the
 * whole run to the global token and SELF-HEAL by DEMOTING the per-project
 * `github.token` (a machine-local hash marker — see `demoteProjectGitHubToken`),
 * NEVER deleting it: the same token is often the task backend's credential (a
 * PAT scoped to the tasks repo, not the origin), and deleting it forced users to
 * re-enter their API key after every sync. On failure (global also rejected):
 * surface the ORIGINAL error, demote nothing. Exactly one fallback attempt per
 * run — never loops.
 *
 * Token hygiene is preserved end-to-end: values only ever flow through
 * `withGitCredentials` (askpass tmp file) or a one-way hash, never into any
 * message/note/error.
 */

/** True when the token was resolved from the per-project secrets tier (the shadowing slot). */
export function isPerProjectToken(t: ResolvedToken | null | undefined): boolean {
  // Global also has `source: 'secrets'` — the `via: 'global'` sentinel is what
  // distinguishes it. Per-project is the default `token` slot or a `users.<slug>` slot.
  return !!t && t.source === 'secrets' && t.via !== 'global';
}

/** Injectable deps — mirror the sync-engine's fakes so tests need no real git/network/fs. */
export interface TokenFallbackDeps {
  withGitCredentials: typeof withGitCredentials;
  readGlobalGitHubToken: typeof readGlobalGitHubToken;
  demoteProjectGitHubToken: typeof demoteProjectGitHubToken;
}

const defaultTokenFallbackDeps: TokenFallbackDeps = {
  withGitCredentials,
  readGlobalGitHubToken,
  demoteProjectGitHubToken,
};

export class BrainSyncTokenSession {
  /** The token every op currently runs with — swaps to global after a successful heal. */
  private active: ResolvedToken;
  /** The single fallback attempt is consumed on first use, success OR failure — never loop. */
  private fallbackConsumed = false;
  private healed = false;

  constructor(
    initial: ResolvedToken,
    private readonly projectRoot: string,
    private readonly deps: TokenFallbackDeps = defaultTokenFallbackDeps,
  ) {
    this.active = initial;
  }

  /** True once the stale per-project token was replaced by the global one AND demoted (kept on disk). */
  get healedStaleProjectToken(): boolean {
    return this.healed;
  }

  /** The token the session is currently authenticating with. */
  get activeToken(): ResolvedToken {
    return this.active;
  }

  /**
   * Run one credentialed git network op. Transparently falls back to the global
   * token + self-heals on a per-project auth/permission failure (see module doc).
   */
  async run<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T> | T): Promise<T> {
    try {
      return await this.deps.withGitCredentials(this.active.token, fn);
    } catch (err) {
      const global = this.fallbackCandidate(err);
      if (!global) throw err;

      // Consume the one attempt up-front so a throw inside the retry can never
      // re-enter the fallback on a later op (single attempt per run, no loop).
      this.fallbackConsumed = true;
      let result: T;
      try {
        result = await this.deps.withGitCredentials(global.token, fn);
      } catch {
        // Global token ALSO rejected — surface the ORIGINAL failure, heal nothing.
        throw err;
      }

      // Retry succeeded: the per-project token was the stale culprit for THIS
      // origin. Switch the rest of the run to the global token and demote the
      // project token (machine-local hash marker) — never delete it: it may be
      // the task backend's own credential.
      const stale = this.active;
      this.active = global;
      this.healed = true;
      try {
        this.deps.demoteProjectGitHubToken(this.projectRoot, stale.token);
      } catch {
        // Best-effort: an unwritable state dir must never turn a recovered sync
        // into a failure. Worst case the token is demoted on a later run.
      }
      return result;
    }
  }

  /**
   * Whether a failed op qualifies for the one-shot global fallback, returning the
   * global token to retry with (or null when it does not qualify). Guards, in order:
   * fallback not already used → active token is per-project → failure is auth/permission
   * → a global token exists whose VALUE differs from the (stale) per-project one.
   */
  private fallbackCandidate(err: unknown): ResolvedToken | null {
    if (this.fallbackConsumed) return null;
    if (!isPerProjectToken(this.active)) return null;
    const kind = classifySyncError((err as Error)?.message ?? String(err)).kind;
    if (kind !== 'auth' && kind !== 'permission') return null;
    const global = this.deps.readGlobalGitHubToken();
    if (!global || global.token === this.active.token) return null;
    return global;
  }
}
