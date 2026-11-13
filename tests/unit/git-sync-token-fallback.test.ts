import { describe, it, expect } from 'vitest';
import {
  GitHubAuthSession,
  isPerProjectToken,
  type GitHubAuthSessionDeps,
} from '../../src/lib/git-sync/token-fallback.js';
import type { GitHubCredential } from '../../src/lib/git-sync/auth-store.js';

type TokenFallbackDeps = GitHubAuthSessionDeps;
type ResolvedToken = GitHubCredential;
/** The brain-sync session, as it was built before github-baglanti (same contract). */
class BrainSyncTokenSession extends GitHubAuthSession {
  constructor(initial: GitHubCredential, root: string, deps: Partial<GitHubAuthSessionDeps>) { super(initial, 'brain', root, deps); }
  get activeToken(): GitHubCredential { return this.current; }
}

/**
 * Unit tests for the stale-per-project-token self-heal session. Fully injected:
 * `withGitCredentials` threads the token into the callback env (mirroring the
 * real askpass contract — the op reads which token it ran with), so a fake "git
 * op" can succeed/fail per token WITHOUT any real git/network/fs.
 */

const PROJECT: ResolvedToken = { token: 'stale-project-token', source: 'project', via: 'token', fingerprint: 'p' };
const GLOBAL: ResolvedToken = { token: 'fresh-global-token', source: 'global', via: 'sign-in', fingerprint: 'g' };
const ENV_TOKEN: ResolvedToken = { token: 'env-token', source: 'env', via: 'GITHUB_TOKEN', fingerprint: 'e' };

/** A `withGitCredentials` fake that exposes the active token to the op via env. */
const withCreds: TokenFallbackDeps['withGitCredentials'] = async (token, fn) => fn({ DC_TOKEN: token });

interface HarnessOpts {
  global?: ResolvedToken | null;
  /** Tokens that make the op THROW `throwMessage` (a rejected credential). */
  badTokens: string[];
  throwMessage?: string;
}

function harness(opts: HarnessOpts) {
  const demoted: Array<[string, string]> = [];
  const deps: TokenFallbackDeps = {
    withGitCredentials: withCreds,
    readGlobalGitHubCredential: () => opts.global ?? null,
    demoteProjectGitHubToken: (root: string, token: string) => { demoted.push([root, token]); },
    reportGitHubAuthOutcome: () => {},
  };
  let opCalls = 0;
  const tokensSeen: string[] = [];
  const op = (env: NodeJS.ProcessEnv) => {
    opCalls += 1;
    const token = String(env.DC_TOKEN);
    tokensSeen.push(token);
    if (opts.badTokens.includes(token)) throw new Error(opts.throwMessage ?? 'remote: Permission to o/r.git denied.');
    return `ok:${token}`;
  };
  return {
    deps,
    op,
    demoted,
    tokensSeen,
    get opCalls() { return opCalls; },
  };
}

describe('git-sync/token-fallback — isPerProjectToken', () => {
  it('is true for the per-project default + user slots, false for global/env/null', () => {
    expect(isPerProjectToken(PROJECT)).toBe(true);
    expect(isPerProjectToken({ source: 'project' })).toBe(true);
    expect(isPerProjectToken(GLOBAL)).toBe(false);
    expect(isPerProjectToken(ENV_TOKEN)).toBe(false);
    expect(isPerProjectToken(null)).toBe(false);
  });
});

describe('git-sync/token-fallback — BrainSyncTokenSession', () => {
  it('a clean op just runs with the active token — no fallback, no heal', async () => {
    const h = harness({ global: GLOBAL, badTokens: [] });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    const r = await s.run(h.op);
    expect(r).toBe('ok:stale-project-token');
    expect(s.healedStaleProjectToken).toBe(false);
    expect(h.demoted).toEqual([]);
    expect(h.opCalls).toBe(1);
  });

  it('per-project auth/permission failure → retries ONCE with global, heals, and removes the stale token', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['stale-project-token'], throwMessage: 'remote: Permission to o/r.git denied.' });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    const r = await s.run(h.op);
    expect(r).toBe('ok:fresh-global-token'); // retried with the global token
    expect(s.healedStaleProjectToken).toBe(true);
    expect(s.activeToken.source).toBe('global'); // whole run continues on global now
    expect(h.demoted).toEqual([['/proj', 'stale-project-token']]); // stale token demoted, never deleted
    // The failing per-project op, then the successful global retry.
    expect(h.tokensSeen).toEqual(['stale-project-token', 'fresh-global-token']);
  });

  it('after a heal, subsequent ops use the global token directly (no second fallback attempt)', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['stale-project-token'] });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    await s.run(h.op); // heals
    const r2 = await s.run(h.op);
    expect(r2).toBe('ok:fresh-global-token');
    expect(h.demoted).toHaveLength(1); // demoted exactly once
  });

  it('retry ALSO fails (global rejected too) → surfaces the ORIGINAL error and removes NOTHING', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['stale-project-token', 'fresh-global-token'], throwMessage: 'remote: Permission to o/r.git denied.' });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    await expect(s.run(h.op)).rejects.toThrow(/denied/);
    expect(s.healedStaleProjectToken).toBe(false);
    expect(h.demoted).toEqual([]); // stale token NOT removed
    expect(h.tokensSeen).toEqual(['stale-project-token', 'fresh-global-token']); // exactly one retry
  });

  it('the single fallback attempt is consumed even when the retry fails — a later op does NOT retry again', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['stale-project-token', 'fresh-global-token'], throwMessage: 'fatal: Authentication failed' });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    await expect(s.run(h.op)).rejects.toThrow();
    // Second op: fallback already consumed → one attempt with the (still) active per-project token.
    const before = h.tokensSeen.length;
    await expect(s.run(h.op)).rejects.toThrow();
    expect(h.tokensSeen.slice(before)).toEqual(['stale-project-token']); // no further fallback
  });

  it('no global token configured → no retry, original error surfaced', async () => {
    const h = harness({ global: null, badTokens: ['stale-project-token'] });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    await expect(s.run(h.op)).rejects.toThrow();
    expect(h.tokensSeen).toEqual(['stale-project-token']); // no fallback attempted
    expect(h.demoted).toEqual([]);
  });

  it('global token identical to the per-project one → no retry (reconnecting cannot help)', async () => {
    const h = harness({ global: { token: 'stale-project-token', source: 'global', via: 'sign-in', fingerprint: 'p' }, badTokens: ['stale-project-token'] });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    await expect(s.run(h.op)).rejects.toThrow();
    expect(h.tokensSeen).toEqual(['stale-project-token']);
    expect(h.demoted).toEqual([]);
  });

  it('a NON-auth failure (network) never triggers the fallback', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['stale-project-token'], throwMessage: 'fatal: unable to access: Could not resolve host: github.com' });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    await expect(s.run(h.op)).rejects.toThrow(/resolve host/);
    expect(h.tokensSeen).toEqual(['stale-project-token']); // no global retry
    expect(h.demoted).toEqual([]);
  });

  it('an ENV token failing auth never triggers the fallback (only per-project qualifies)', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['env-token'], throwMessage: 'fatal: Authentication failed' });
    const s = new BrainSyncTokenSession(ENV_TOKEN, '/proj', h.deps);
    await expect(s.run(h.op)).rejects.toThrow();
    expect(h.tokensSeen).toEqual(['env-token']);
    expect(h.demoted).toEqual([]);
  });

  it('askpass hygiene: neither token value ever appears in the surfaced error message', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['stale-project-token', 'fresh-global-token'], throwMessage: 'remote: Permission to o/r.git denied.' });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    await s.run(h.op).catch((e: Error) => {
      expect(e.message).not.toContain('stale-project-token');
      expect(e.message).not.toContain('fresh-global-token');
    });
  });
});
