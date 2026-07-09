import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeGlobalGitHubToken,
  readGlobalGitHubNeedsReconnect,
  setGlobalGitHubAuthValid,
} from '../../src/lib/git-sync/auth-store.js';
import { writeGitHubToken } from '../../src/lib/task-backend/secrets.js';
import {
  reconcileBrainSyncSuccess,
  reconcileBrainSyncFailure,
  AUTH_OK_ACTIONS,
} from '../../src/lib/git-sync/auth-reconcile.js';

/**
 * The regression these guard: the global `needsReconnect` flag used to be
 * reconciled ONLY by the server sync route. A valid per-project token synced
 * cleanly forever via the CLI while the desktop banner (which reads this flag)
 * screamed "reconnect" — a permanent false alarm. reconcileBrainSync* is the
 * shared reconciler every entry point now calls.
 */
describe('git-sync/auth-reconcile — shared reconciler for every sync entry point', () => {
  let projectRoot: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-proj-'));
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    // Global tier + the flag both read os.homedir() — isolate it.
    originalHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), 'dc-home-'));
    process.env.HOME = fakeHome;
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('a successful sync clears a stale reconnect flag (the core bug)', () => {
    writeGlobalGitHubToken('gho_globaltoken');
    setGlobalGitHubAuthValid(false); // a prior op flagged the session invalid
    expect(readGlobalGitHubNeedsReconnect()).toBe(true);

    reconcileBrainSyncSuccess('pushed'); // any CLI/autoSync sync that reached the remote
    expect(readGlobalGitHubNeedsReconnect()).toBe(false);
  });

  it('every AUTH_OK action clears the flag; a pre-network action does not', () => {
    for (const action of AUTH_OK_ACTIONS) {
      writeGlobalGitHubToken('gho_t');
      setGlobalGitHubAuthValid(false);
      reconcileBrainSyncSuccess(action);
      expect(readGlobalGitHubNeedsReconnect(), `${action} should clear`).toBe(false);
    }
    // A pre-network outcome proves nothing about the token → must NOT clear.
    writeGlobalGitHubToken('gho_t');
    setGlobalGitHubAuthValid(false);
    reconcileBrainSyncSuccess('no-remote');
    expect(readGlobalGitHubNeedsReconnect()).toBe(true);
  });

  it('a PER-PROJECT token failing auth does NOT raise the global reconnect banner', () => {
    // Per-project token wins resolution; reconnecting the global sign-in cannot
    // fix it, so the global banner must stay quiet.
    writeGitHubToken(projectRoot, 'gho_perproject');
    writeGlobalGitHubToken('gho_global');
    reconcileBrainSyncFailure('fatal: Authentication failed for https://github.com/o/r.git', projectRoot);
    expect(readGlobalGitHubNeedsReconnect()).toBe(false);
  });

  it('the GLOBAL token failing auth DOES raise the reconnect banner', () => {
    // No per-project token → sync resolves the global token → an auth failure is
    // genuinely a "reconnect your sign-in" problem.
    writeGlobalGitHubToken('gho_global');
    reconcileBrainSyncFailure('remote: Invalid credentials\nfatal: Authentication failed', projectRoot);
    expect(readGlobalGitHubNeedsReconnect()).toBe(true);
  });

  it('a permission error keeps the session valid (GitHub accepted the credential)', () => {
    writeGlobalGitHubToken('gho_global');
    setGlobalGitHubAuthValid(false);
    reconcileBrainSyncFailure('remote: Permission to o/r.git denied to user.', projectRoot);
    expect(readGlobalGitHubNeedsReconnect()).toBe(false);
  });

  it('a network error leaves validity untouched', () => {
    writeGlobalGitHubToken('gho_global');
    setGlobalGitHubAuthValid(false);
    reconcileBrainSyncFailure('fatal: unable to access ... Could not resolve host: github.com', projectRoot);
    // Untouched: still invalid (a transient network blip is not a fresh success).
    expect(readGlobalGitHubNeedsReconnect()).toBe(true);
  });
});
