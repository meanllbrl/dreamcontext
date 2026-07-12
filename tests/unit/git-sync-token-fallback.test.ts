import { describe, it, expect } from 'vitest';
import type { ResolvedToken } from '../../src/lib/task-backend/secrets.js';
import {
  BrainSyncTokenSession,
  isPerProjectToken,
  type TokenFallbackDeps,
} from '../../src/lib/git-sync/token-fallback.js';

/**
 * Unit tests for the stale-per-project-token self-heal session. Fully injected:
 * `withGitCredentials` threads the token into the callback env (mirroring the
 * real askpass contract — the op reads which token it ran with), so a fake "git
 * op" can succeed/fail per token WITHOUT any real git/network/fs.
 */

const PROJECT = { token: 'stale-project-token', source: 'secrets', via: 'token' } as ResolvedToken;
const GLOBAL = { token: 'fresh-global-token', source: 'secrets', via: 'global' } as ResolvedToken;
const ENV_TOKEN = { token: 'env-token', source: 'env', via: 'GITHUB_TOKEN' } as ResolvedToken;

/** A `withGitCredentials` fake that exposes the active token to the op via env. */
const withCreds: TokenFallbackDeps['withGitCredentials'] = async (token, fn) => fn({ DC_TOKEN: token });

interface HarnessOpts {
  global?: ResolvedToken | null;
  /** Tokens that make the op THROW `throwMessage` (a rejected credential). */
  badTokens: string[];
  throwMessage?: string;
}

function harness(opts: HarnessOpts) {
  const removed: string[] = [];
  const deps: TokenFallbackDeps = {
    withGitCredentials: withCreds,
    readGlobalGitHubToken: () => opts.global ?? null,
    removeProjectGitHubToken: (root: string) => { removed.push(root); },
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
    removed,
    tokensSeen,
    get opCalls() { return opCalls; },
  };
}

describe('git-sync/token-fallback — isPerProjectToken', () => {
  it('is true for the per-project default + user slots, false for global/env/null', () => {
    expect(isPerProjectToken(PROJECT)).toBe(true);
    expect(isPerProjectToken({ token: 't', source: 'secrets', via: 'users.alice' })).toBe(true);
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
    expect(h.removed).toEqual([]);
    expect(h.opCalls).toBe(1);
  });

  it('per-project auth/permission failure → retries ONCE with global, heals, and removes the stale token', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['stale-project-token'], throwMessage: 'remote: Permission to o/r.git denied.' });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    const r = await s.run(h.op);
    expect(r).toBe('ok:fresh-global-token'); // retried with the global token
    expect(s.healedStaleProjectToken).toBe(true);
    expect(s.activeToken.via).toBe('global'); // whole run continues on global now
    expect(h.removed).toEqual(['/proj']); // stale project token removed
    // The failing per-project op, then the successful global retry.
    expect(h.tokensSeen).toEqual(['stale-project-token', 'fresh-global-token']);
  });

  it('after a heal, subsequent ops use the global token directly (no second fallback attempt)', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['stale-project-token'] });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    await s.run(h.op); // heals
    const r2 = await s.run(h.op);
    expect(r2).toBe('ok:fresh-global-token');
    expect(h.removed).toEqual(['/proj']); // removed exactly once
  });

  it('retry ALSO fails (global rejected too) → surfaces the ORIGINAL error and removes NOTHING', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['stale-project-token', 'fresh-global-token'], throwMessage: 'remote: Permission to o/r.git denied.' });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    await expect(s.run(h.op)).rejects.toThrow(/denied/);
    expect(s.healedStaleProjectToken).toBe(false);
    expect(h.removed).toEqual([]); // stale token NOT removed
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
    expect(h.removed).toEqual([]);
  });

  it('global token identical to the per-project one → no retry (reconnecting cannot help)', async () => {
    const h = harness({ global: { token: 'stale-project-token', source: 'secrets', via: 'global' }, badTokens: ['stale-project-token'] });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    await expect(s.run(h.op)).rejects.toThrow();
    expect(h.tokensSeen).toEqual(['stale-project-token']);
    expect(h.removed).toEqual([]);
  });

  it('a NON-auth failure (network) never triggers the fallback', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['stale-project-token'], throwMessage: 'fatal: unable to access: Could not resolve host: github.com' });
    const s = new BrainSyncTokenSession(PROJECT, '/proj', h.deps);
    await expect(s.run(h.op)).rejects.toThrow(/resolve host/);
    expect(h.tokensSeen).toEqual(['stale-project-token']); // no global retry
    expect(h.removed).toEqual([]);
  });

  it('an ENV token failing auth never triggers the fallback (only per-project qualifies)', async () => {
    const h = harness({ global: GLOBAL, badTokens: ['env-token'], throwMessage: 'fatal: Authentication failed' });
    const s = new BrainSyncTokenSession(ENV_TOKEN, '/proj', h.deps);
    await expect(s.run(h.op)).rejects.toThrow();
    expect(h.tokensSeen).toEqual(['env-token']);
    expect(h.removed).toEqual([]);
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
