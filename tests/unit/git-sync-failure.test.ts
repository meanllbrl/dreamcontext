import { describe, it, expect } from 'vitest';
import { classifySyncError } from '../../src/lib/git-sync/failure.js';

/**
 * Every failure class maps to its OWN message + a concrete recovery affordance —
 * never a generic "sync failed" (github-cloud-collaboration-brain-repo-sync
 * hardening, items 5 & 8). Inputs mirror real git stderr the engine's GitSyncError
 * carries.
 */
describe('git-sync/failure — classifySyncError', () => {
  it('non-fast-forward twice → push-rejected + retry', () => {
    const f = classifySyncError('Push rejected (non-fast-forward) twice — the remote is still ahead after a merge + one retry.');
    expect(f.kind).toBe('push-rejected');
    expect(f.recovery).toBe('retry');
    expect(f.message).toMatch(/retry/i);
  });

  it('expired/invalid token → auth + reconnect-github', () => {
    const f = classifySyncError("fatal: Authentication failed for 'https://github.com/acme/brain.git/'");
    expect(f.kind).toBe('auth');
    expect(f.recovery).toBe('reconnect-github');
    expect(f.message).toMatch(/reconnect github/i);
  });

  it('terminal prompts disabled (no usable credential) → auth', () => {
    const f = classifySyncError('fatal: could not read Username for https://github.com: terminal prompts disabled');
    expect(f.kind).toBe('auth');
    expect(f.recovery).toBe('reconnect-github');
  });

  it('no token configured → no-token (NOT auth), and never says "expired"', () => {
    // The engine's `no-remote` note — a state check, not a rejected git op. It
    // must not read like an EXPIRED sign-in (which would falsely alarm a
    // signed-in user whose token is fine).
    const f = classifySyncError('No GitHub token found for the brain repo (per-project secrets or GITHUB_TOKEN/GH_TOKEN env).');
    expect(f.kind).toBe('no-token');
    expect(f.recovery).toBe('reconnect-github');
    expect(f.message).not.toMatch(/expired|invalid/i);
    expect(f.message).toMatch(/connect github/i);
  });

  it('offline / DNS failure → network + wait-online, and says nothing was lost', () => {
    const f = classifySyncError("fatal: unable to access 'https://github.com/acme/brain.git/': Could not resolve host: github.com");
    expect(f.kind).toBe('network');
    expect(f.recovery).toBe('wait-online');
    expect(f.message).toMatch(/offline/i);
    expect(f.message).toMatch(/nothing was lost/i);
  });

  it('missing Contents write → permission, and NAMES the repo + the scope', () => {
    const f = classifySyncError('remote: Permission to acme/brain.git denied to someone.', 'https://github.com/acme/brain.git');
    expect(f.kind).toBe('permission');
    expect(f.recovery).toBe('check-permissions');
    expect(f.repo).toBe('acme/brain');
    expect(f.message).toMatch(/acme\/brain/);
    expect(f.message).toMatch(/contents/i);
  });

  it('empty-remote push failure (mentions Contents read/write) → permission and names the repo hint', () => {
    const f = classifySyncError(
      'Push to the empty brain remote failed — check the token has Contents read/write on that repo and the remote URL is correct.',
      'https://github.com/acme/brain.git',
    );
    expect(f.kind).toBe('permission');
    expect(f.repo).toBe('acme/brain');
  });

  it('unrelated histories → manual recovery, never auto-merged', () => {
    const f = classifySyncError('The brain and its remote have unrelated histories — the remote already contains content …');
    expect(f.recovery).toBe('manual');
  });

  it('an unknown failure still yields a non-empty message + a retry default (never a dead end)', () => {
    const f = classifySyncError('git merge exploded in some novel way');
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.recovery).toBe('retry');
  });

  // ── tier-aware messages (stale per-project token shadowing the signed-in account) ──
  describe('perProjectToken tier awareness', () => {
    it('an AUTH failure with a per-project token NAMES the shadowing stale project token', () => {
      const f = classifySyncError("fatal: Authentication failed for 'https://github.com/o/r.git'", undefined, { perProjectToken: true });
      expect(f.kind).toBe('auth');
      expect(f.recovery).toBe('reconnect-github');
      expect(f.message).toMatch(/its own github token/i);
      expect(f.message).toMatch(/stale/i);
      // Still carries the base copy — the tier note is APPENDED, not a replacement.
      expect(f.message).toMatch(/expired or is invalid/i);
    });

    it('a PERMISSION failure with a per-project token also appends the tier note', () => {
      const f = classifySyncError('remote: Permission to acme/brain.git denied to someone.', 'https://github.com/acme/brain.git', { perProjectToken: true });
      expect(f.kind).toBe('permission');
      expect(f.message).toMatch(/acme\/brain/);
      expect(f.message).toMatch(/its own github token/i);
    });

    it('perProjectToken:false is identical to the 2-arg call (backward compatible)', () => {
      const base = classifySyncError("fatal: Authentication failed for 'https://github.com/o/r.git'");
      const withFalse = classifySyncError("fatal: Authentication failed for 'https://github.com/o/r.git'", undefined, { perProjectToken: false });
      expect(withFalse).toEqual(base);
      expect(withFalse.message).not.toMatch(/its own github token/i);
    });

    it('the tier note is NOT appended to non-auth/permission kinds (network stays clean)', () => {
      const f = classifySyncError("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com", undefined, { perProjectToken: true });
      expect(f.kind).toBe('network');
      expect(f.message).not.toMatch(/its own github token/i);
    });
  });
});
