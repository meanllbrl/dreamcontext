/**
 * Unit tests for the Claude ACCOUNT WATCHER (src/lib/claude-auth-watch.ts) — the thing that
 * notices `claude auth login` landed on a different account while sessions were already open.
 *
 * Why it exists: a spawned `claude` reads its credentials once, at startup. Switching
 * accounts therefore changes nothing for a chat that is already running — it keeps talking to
 * the API as the account the user thinks they left, and nothing in the stream says so. The
 * watcher is what turns that invisible state into a restart.
 *
 * What these tests are really defending is the set of things that must NOT fire a restart,
 * because every false positive kills a live session for no reason:
 *   • `~/.claude.json` being rewritten (which the CLI does constantly, for tips, counters and
 *     usage caches) when the account underneath is unchanged;
 *   • `profileFetchedAt` moving inside `oauthAccount` itself;
 *   • a probe that flaps between "signed in" and "can't tell";
 *   • the FIRST reading of anything, which is a baseline, not a change.
 *
 * The fixtures are the real shapes: `~/.claude.json` as it exists on a signed-in machine
 * (verified 2026-08-24 — its `oauthAccount.emailAddress` matches what `claude auth status
 * --json` reports, which is what makes the file usable as a cheap trigger at all), and probe
 * payloads in the shape `parseAuthStatus` produces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudeAuthWatcher, mirrorFingerprint, statusFingerprint, describeIdentity,
  isRestartable, MIRROR_ABSENT, type ClaudeAuthChange,
} from '../../src/lib/claude-auth-watch.js';
import type { ClaudeAuthStatus } from '../../src/lib/claude-auth.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────────────

/** The identifying half of a real `~/.claude.json` — plus the noise that surrounds it. */
function claudeJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numStartups: 412,
    tipsHistory: { 'shift-enter': 3 },
    cachedUsageUtilization: { fetchedAtMs: 1_700_000_000_000 },
    oauthAccount: {
      accountUuid: '93447308-0000-4000-8000-000000000001',
      emailAddress: 'someone@example.com',
      organizationUuid: '8d100b57-0000-4000-8000-000000000002',
      // Moves on its own schedule, has nothing to do with WHO is signed in.
      profileFetchedAt: '2026-08-24T10:01:07.571Z',
      organizationName: 'Example Inc',
      seatTier: 'team_tier_1',
    },
    ...overrides,
  };
}

function signedIn(over: Partial<ClaudeAuthStatus> = {}): ClaudeAuthStatus {
  return {
    loggedIn: true,
    supported: true,
    loginCommand: 'claude auth login',
    method: 'claude.ai',
    email: 'someone@example.com',
    orgId: '8d100b57-0000-4000-8000-000000000002',
    subscription: 'team',
    ...over,
  };
}

const SIGNED_OUT: ClaudeAuthStatus = { loggedIn: false, supported: true, loginCommand: 'claude auth login' };
const UNKNOWN: ClaudeAuthStatus = {
  loggedIn: null, supported: true, loginCommand: 'claude auth login', error: 'The sign-in check timed out.',
};

// ── The pure halves ───────────────────────────────────────────────────────────────────

describe('mirrorFingerprint', () => {
  it('is stable across the noise the CLI writes on every heartbeat', () => {
    const a = mirrorFingerprint(claudeJson());
    const b = mirrorFingerprint(claudeJson({ numStartups: 999, tipsHistory: {} }));
    expect(b).toBe(a);
  });

  it('ignores profileFetchedAt moving inside oauthAccount', () => {
    const base = claudeJson();
    const moved = claudeJson();
    (moved.oauthAccount as Record<string, unknown>).profileFetchedAt = '2026-08-25T04:00:00.000Z';
    expect(mirrorFingerprint(moved)).toBe(mirrorFingerprint(base));
  });

  it('changes when the account changes', () => {
    const other = claudeJson();
    (other.oauthAccount as Record<string, unknown>).accountUuid = 'aaaaaaaa-0000-4000-8000-000000000009';
    (other.oauthAccount as Record<string, unknown>).emailAddress = 'other@example.com';
    expect(mirrorFingerprint(other)).not.toBe(mirrorFingerprint(claudeJson()));
  });

  it('changes when only the ORGANIZATION changes — same email, different seat and limits', () => {
    const otherOrg = claudeJson();
    (otherOrg.oauthAccount as Record<string, unknown>).organizationUuid = 'ffffffff-0000-4000-8000-00000000000a';
    expect(mirrorFingerprint(otherOrg)).not.toBe(mirrorFingerprint(claudeJson()));
  });

  it('reads a missing, empty or non-object oauthAccount as absent', () => {
    expect(mirrorFingerprint(claudeJson({ oauthAccount: undefined }))).toBe(MIRROR_ABSENT);
    expect(mirrorFingerprint({ oauthAccount: {} })).toBe(MIRROR_ABSENT);
    expect(mirrorFingerprint({ oauthAccount: 'nope' })).toBe(MIRROR_ABSENT);
    expect(mirrorFingerprint(null)).toBe(MIRROR_ABSENT);
    expect(mirrorFingerprint([])).toBe(MIRROR_ABSENT);
  });
});

describe('statusFingerprint', () => {
  it('collapses every unknown answer to ONE fingerprint', () => {
    // Two consecutive "I can't tell"s are the same answer. If they compared as different,
    // a flaky probe would read as a parade of account switches and restart live sessions.
    expect(statusFingerprint(UNKNOWN)).toBe(statusFingerprint({ ...UNKNOWN, error: 'something else' }));
    expect(statusFingerprint({ ...UNKNOWN, email: 'ghost@example.com' })).toBe(statusFingerprint(UNKNOWN));
  });

  it('separates signed-in, signed-out and unknown', () => {
    const three = new Set([statusFingerprint(signedIn()), statusFingerprint(SIGNED_OUT), statusFingerprint(UNKNOWN)]);
    expect(three.size).toBe(3);
  });

  it('separates two orgs on the same email', () => {
    expect(statusFingerprint(signedIn({ orgId: 'other-org' }))).not.toBe(statusFingerprint(signedIn()));
  });
});

describe('isRestartable / describeIdentity', () => {
  it('restarts a live session only onto a CONFIRMED sign-in', () => {
    expect(isRestartable(signedIn())).toBe(true);
    // Restarting onto these makes things strictly worse — see the function's note.
    expect(isRestartable(SIGNED_OUT)).toBe(false);
    expect(isRestartable(UNKNOWN)).toBe(false);
  });

  it('labels the account, and degrades to empty rather than to "undefined"', () => {
    expect(describeIdentity(signedIn())).toBe('someone@example.com · team');
    expect(describeIdentity(SIGNED_OUT)).toBe('');
  });
});

// ── The watcher ───────────────────────────────────────────────────────────────────────

describe('createClaudeAuthWatcher', () => {
  let home: string;
  let file: string;
  /** Probe answers, consumed in order; the last one repeats. */
  let answers: ClaudeAuthStatus[];
  let probeCalls: number;
  let invalidated: number;
  let seen: ClaudeAuthChange[];

  function write(blob: Record<string, unknown>): void {
    writeFileSync(file, JSON.stringify(blob), 'utf-8');
  }

  function watcher() {
    return createClaudeAuthWatcher({
      home,
      probe: () => {
        probeCalls += 1;
        return Promise.resolve(answers.length > 1 ? answers.shift()! : answers[0]);
      },
      invalidate: () => { invalidated += 1; },
      // Long enough that no test can be rescued (or broken) by the timer — every test drives
      // `check()` by hand.
      intervalMs: 1_000_000,
    });
  }

  // `subscribe()` baselines the MIRROR synchronously and for free, but leaves the
  // AUTHORITATIVE baseline to the first tick — a probe is a CLI spawn, and `subscribe()` runs
  // on the chat-spawn path with a user waiting on a pane. So every test below is explicit
  // about it: subscribe, then one `check()` to baseline, then the scenario.

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dc-authwatch-'));
    file = join(home, '.claude.json');
    answers = [signedIn()];
    probeCalls = 0;
    invalidated = 0;
    seen = [];
  });

  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  /** A `~/.claude.json` for a DIFFERENT account than the default fixture's. */
  function otherAccount(uuid: string, email = 'other@example.com'): Record<string, unknown> {
    const blob = claudeJson();
    Object.assign(blob.oauthAccount as Record<string, unknown>, { accountUuid: uuid, emailAddress: email });
    return blob;
  }

  it('the first check baselines both halves, paying for exactly ONE probe', async () => {
    write(claudeJson());
    const w = watcher();
    w.subscribe((c) => seen.push(c));
    await w.check();
    expect(seen).toEqual([]);
    expect(w.epoch()).toBe(0);
    // One, not zero: the module has to learn which account it STARTED on, or the very first
    // switch would be swallowed as its baseline. One spawn per watcher lifetime.
    expect(probeCalls).toBe(1);
  });

  it('skips the startup probe entirely when the capabilities route already answered', async () => {
    // Production order: the app mounts and polls /api/agent/capabilities long before the
    // user opens a chat, so the authoritative baseline is already in by the time anything
    // subscribes — and the watcher must not pay for a second probe to learn what it knows.
    write(claudeJson());
    const w = watcher();
    w.observe(signedIn());
    w.subscribe((c) => seen.push(c));
    await w.check();
    expect(probeCalls).toBe(0);
    expect(seen).toEqual([]);
  });

  it('does not probe when the file is rewritten but the account is unchanged', async () => {
    write(claudeJson());
    const w = watcher();
    w.observe(signedIn());
    w.subscribe((c) => seen.push(c));
    await w.check();
    // Exactly what the CLI does all day: same account, different counters, new mtime.
    write(claudeJson({ numStartups: 413, tipsHistory: { x: 1 } }));
    await w.check();
    expect(probeCalls).toBe(0);
    expect(seen).toEqual([]);
  });

  it('announces the FIRST switch after startup — the case the feature exists for', async () => {
    write(claudeJson());
    answers = [signedIn(), signedIn({ email: 'other@example.com', orgId: 'org-2', subscription: 'max' })];
    const w = watcher();
    w.subscribe((c) => seen.push(c));
    await w.check();                        // baselines on account A
    expect(seen).toEqual([]);

    write(otherAccount('bbbb0000-0000-4000-8000-00000000000b'));
    await w.check();

    expect(seen).toHaveLength(1);
    expect(seen[0].epoch).toBe(1);
    expect(seen[0].identity).toBe('other@example.com · max');
    expect(seen[0].restartable).toBe(true);
    expect(w.epoch()).toBe(1);
    // Dropping claude-auth.ts's 5s memo is what makes /api/agent/capabilities report the new
    // account on its very next poll instead of up to 5s of the old one.
    expect(invalidated).toBe(1);
  });

  it('reports a sign-OUT but refuses to restart on it', async () => {
    write(claudeJson());
    answers = [signedIn(), SIGNED_OUT];
    const w = watcher();
    w.subscribe((c) => seen.push(c));
    await w.check();

    write(claudeJson({ oauthAccount: undefined }));   // logout clears the block
    await w.check();

    expect(seen).toHaveLength(1);
    expect(seen[0].status.loggedIn).toBe(false);
    // Never kill a working session to replace it with one that cannot talk to the API.
    expect(seen[0].restartable).toBe(false);
    expect(seen[0].identity).toBe('');
  });

  it('does not announce when the mirror moved but the CLI reports the same account', async () => {
    write(claudeJson());
    answers = [signedIn()];               // the probe keeps saying the same thing
    const w = watcher();
    w.subscribe((c) => seen.push(c));
    await w.check();

    write(otherAccount('dddd0000-0000-4000-8000-00000000000d'));
    await w.check();

    expect(probeCalls).toBe(2);           // it looked…
    expect(seen).toEqual([]);             // …and found nothing worth restarting for
    expect(w.epoch()).toBe(0);
  });

  it('a probe that cannot answer is INERT — it neither announces nor poisons the baseline', async () => {
    write(claudeJson());
    answers = [signedIn(), UNKNOWN, signedIn()];
    const w = watcher();
    w.subscribe((c) => seen.push(c));
    await w.check();                                               // baseline: account A

    write(otherAccount('1111aaaa-0000-4000-8000-000000000011'));
    await w.check();                                              // probe times out
    expect(seen).toEqual([]);

    // The account never actually moved. If the timeout had been remembered as the state,
    // this next successful probe would read as a switch and restart every live session.
    write(otherAccount('2222aaaa-0000-4000-8000-000000000022'));
    await w.check();
    expect(seen).toEqual([]);
    expect(w.epoch()).toBe(0);
  });

  it('observe() advances the epoch from a status somebody else already paid for', async () => {
    write(claudeJson());
    const w = watcher();
    w.observe(signedIn());                                   // baselines
    w.subscribe((c) => seen.push(c));
    await w.check();
    expect(w.epoch()).toBe(0);
    w.observe(signedIn());                                   // same account, no news
    expect(w.epoch()).toBe(0);
    w.observe(signedIn({ email: 'third@example.com' }));     // a real switch
    expect(w.epoch()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].identity).toBe('third@example.com · team');
    // `observe` is fed by the capabilities poll, which already paid for its probe.
    expect(probeCalls).toBe(0);
  });

  it('shares ONE epoch between the file poll and observe(), so the two cannot disagree', async () => {
    write(claudeJson());
    answers = [signedIn(), signedIn({ email: 'fourth@example.com' })];
    const w = watcher();
    w.subscribe((c) => seen.push(c));
    await w.check();                                          // baseline

    write(otherAccount('ffff0000-0000-4000-8000-00000000000f', 'fourth@example.com'));
    await w.check();                                         // the poll sees it first
    expect(w.epoch()).toBe(1);

    // The capabilities poll then reports the SAME account a beat later. It must not be
    // counted as a second switch, or every change would restart sessions twice.
    w.observe(signedIn({ email: 'fourth@example.com' }));
    expect(w.epoch()).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it('an absent ~/.claude.json is a fingerprint, not a crash', async () => {
    answers = [UNKNOWN];
    const w = watcher();               // nothing written at all
    w.subscribe((c) => seen.push(c));
    await w.check();
    await expect(w.check()).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('malformed JSON reads as absent rather than throwing out of the poll', async () => {
    writeFileSync(file, '{ this is not json', 'utf-8');
    const w = watcher();
    w.subscribe((c) => seen.push(c));
    w.observe(signedIn());
    await w.check();
    await expect(w.check()).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('a throwing subscriber does not stop the others being told', async () => {
    write(claudeJson());
    answers = [signedIn(), signedIn({ email: 'fifth@example.com' })];
    const w = watcher();
    w.subscribe(() => { throw new Error('boom'); });
    w.subscribe((c) => seen.push(c));
    await w.check();

    write(otherAccount('a1aaaaaa-0000-4000-8000-0000000000a1', 'fifth@example.com'));
    await w.check();

    expect(seen).toHaveLength(1);
    expect(seen[0].identity).toBe('fifth@example.com · team');
  });

  it('unsubscribing is idempotent and refcounts back to zero', async () => {
    const w = watcher();
    const off1 = w.subscribe(() => {});
    const off2 = w.subscribe(() => {});
    expect(w.subscriberCount()).toBe(2);
    off1(); off1();                    // a double-unsubscribe must not decrement twice
    expect(w.subscriberCount()).toBe(1);
    off2();
    expect(w.subscriberCount()).toBe(0);
  });
});
