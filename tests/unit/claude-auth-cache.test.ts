/**
 * The sign-in probe's memo (src/lib/claude-auth.ts) — task: the desktop app stays light on an
 * 8GB MacBook Air (AC4).
 *
 * `/api/agent/capabilities` polls every 30 s per window and each poll used to spawn
 * `claude auth status` (a 5 s memo under a 30 s poll always misses). A definite answer is now
 * held while the account mirror (`<configDir>/.claude.json`'s identity fields) is unchanged;
 * a sign-in, sign-out or switch rewrites the mirror and the next call re-probes.
 *
 * Isolation: HOME points at a temp dir (the probe's default config dir is `homedir()`), and
 * the CLI spawn is replaced by a counter — no real `claude`, no real `~/.claude.json`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeAuthStatus, resetClaudeAuthCache, setClaudeAuthProbeForTests, type ClaudeAuthStatus,
} from '../../src/lib/claude-auth.js';

const SIGNED_IN: ClaudeAuthStatus = { loggedIn: true, supported: true, loginCommand: 'claude auth login', email: 'someone@example.com' };
const FAILED: ClaudeAuthStatus = { loggedIn: null, supported: true, loginCommand: 'claude auth login', error: 'timed out' };

let home: string;
let prevHome: string | undefined;
let spawns = 0;
let answer: ClaudeAuthStatus = SIGNED_IN;

function writeMirror(email: string, mtimeSec: number): void {
  const file = join(home, '.claude.json');
  writeFileSync(file, JSON.stringify({
    numStartups: Math.floor(Math.random() * 1000),
    oauthAccount: { accountUuid: `uuid-${email}`, emailAddress: email, organizationUuid: 'org-1', profileFetchedAt: Date.now() },
  }));
  utimesSync(file, mtimeSec, mtimeSec);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-auth-cache-'));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  spawns = 0;
  answer = SIGNED_IN;
  resetClaudeAuthCache();
  setClaudeAuthProbeForTests(async () => { spawns += 1; return answer; });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  setClaudeAuthProbeForTests(null);
  resetClaudeAuthCache();
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('claudeAuthStatus memo', () => {
  it('20 polls over 10 minutes with an unchanged account spawn the probe at most once', async () => {
    writeMirror('someone@example.com', 1_000);
    for (let i = 0; i < 20; i++) {
      expect((await claudeAuthStatus()).loggedIn).toBe(true);
      vi.setSystemTime(Date.now() + 30_000);
    }
    expect(spawns).toBeLessThanOrEqual(1);
  });

  it('a heartbeat that rewrites the mirror without changing the account does not re-probe', async () => {
    writeMirror('someone@example.com', 1_000);
    await claudeAuthStatus();
    writeMirror('someone@example.com', 2_000); // new mtime, new noise fields, same identity
    await claudeAuthStatus();
    expect(spawns).toBe(1);
  });

  it('an account switch in the mirror re-probes on the next call', async () => {
    writeMirror('someone@example.com', 1_000);
    await claudeAuthStatus();
    writeMirror('other@example.com', 2_000);
    answer = { ...SIGNED_IN, email: 'other@example.com' };
    expect((await claudeAuthStatus()).email).toBe('other@example.com');
    expect(spawns).toBe(2);
  });

  it('a sign-out (mirror loses its account) re-probes', async () => {
    writeMirror('someone@example.com', 1_000);
    await claudeAuthStatus();
    rmSync(join(home, '.claude.json'));
    answer = { loggedIn: false, supported: true, loginCommand: 'claude auth login' };
    expect((await claudeAuthStatus()).loggedIn).toBe(false);
    expect(spawns).toBe(2);
  });

  it('a probe that could not answer is retried after a minute, not held', async () => {
    writeMirror('someone@example.com', 1_000);
    answer = FAILED;
    await claudeAuthStatus();
    vi.setSystemTime(Date.now() + 30_000);
    await claudeAuthStatus();
    expect(spawns).toBe(1);
    vi.setSystemTime(Date.now() + 31_000);
    await claudeAuthStatus();
    expect(spawns).toBe(2);
  });

  it('concurrent callers share one probe', async () => {
    writeMirror('someone@example.com', 1_000);
    await Promise.all([claudeAuthStatus(), claudeAuthStatus(), claudeAuthStatus()]);
    expect(spawns).toBe(1);
  });

  it('a reset (the watcher saw a switch) forces the next call to re-probe', async () => {
    writeMirror('someone@example.com', 1_000);
    await claudeAuthStatus();
    resetClaudeAuthCache();
    await claudeAuthStatus();
    expect(spawns).toBe(2);
  });
});
