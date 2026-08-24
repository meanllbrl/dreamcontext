import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeAuthStatus, resetClaudeAuthCache, type ClaudeAuthStatus } from './claude-auth.js';

/**
 * Notice when the user signs into a DIFFERENT Claude account, while the app is running.
 *
 * WHY this exists: every agent surface spawns the user's own `claude` binary, and that
 * process reads its credentials ONCE, at startup. So `claude auth login` into another
 * account changes nothing for a session that is already open — it keeps talking to the API
 * as the old account until it is restarted. The observed symptom (reported by the
 * maintainer, who switches accounts often): *"I change my auth, but the chats I already
 * have open are still on the old one."* The only fix that exists is a process restart, and
 * the only thing missing was something that KNOWS when one is due. This is that thing.
 *
 * ── Why the file is the trigger and the CLI is the judge ───────────────────────────────
 * `claude auth status --json` is authoritative but SLOW — measured at 4.8s cold on the
 * maintainer's machine (the 0.6s in claude-auth.ts's header is a warm run). Polling it is
 * out of the question.
 *
 * `~/.claude.json`'s `oauthAccount` is the CLI's own cached profile of whoever is signed
 * in, and it is rewritten on login. Verified 2026-08-24 on CLI 2.1.x: its `emailAddress`
 * matches what `claude auth status --json` reports. Reading it costs one `stat` plus (only
 * when the mtime moved) one JSON parse.
 *
 * So the two are combined by their strengths: the file mirror is a cheap TRIGGER, and the
 * CLI probe is the authoritative JUDGE that runs only after the trigger fires. A stale or
 * lying mirror therefore cannot produce a false "your account changed" — the probe has to
 * agree before anything is broadcast.
 *
 * ── The fingerprint is an ALLOWLIST, deliberately ──────────────────────────────────────
 * `oauthAccount` also carries `profileFetchedAt`, and the surrounding blob carries
 * `numStartups`, `tipsHistory`, usage caches — all of which move constantly. Hashing the
 * object (or trusting the mtime) would fire on every idle heartbeat. Only the three fields
 * that ACTUALLY identify an account are read: `accountUuid`, `emailAddress`,
 * `organizationUuid` — the last one because switching between two orgs on the same email
 * is a real account switch with real, different rate limits.
 *
 * ── Epochs, not timestamps ─────────────────────────────────────────────────────────────
 * A session records {@link ClaudeAuthWatcher.epoch} at spawn — synchronously, for free, no
 * probe. When the epoch advances past what a session recorded, that session predates the
 * change and is running on the old credentials. A session spawned AFTER the switch already
 * has the new ones and must never be told to restart, which a "time of last change"
 * comparison gets wrong at exactly the moment it matters (a tab opened mid-switch).
 */

/** How the account is identified. Everything else in `~/.claude.json` is noise — see the
 *  allowlist note above. */
interface MirrorIdentity {
  accountUuid: string;
  emailAddress: string;
  organizationUuid: string;
}

/** No `oauthAccount` at all — signed out, or a machine that authenticates some other way. */
export const MIRROR_ABSENT = 'absent';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The identity fingerprint of a parsed `~/.claude.json` blob. `absent` when the blob has no
 * `oauthAccount` (signed out, or never signed in) — which is itself a fingerprint, so a
 * logout is detected exactly like a switch.
 *
 * Exported pure: the shapes this must survive (a switch, a logout, a heartbeat that only
 * moved `profileFetchedAt`, garbage) are pinned by tests rather than by a live CLI.
 */
export function mirrorFingerprint(blob: unknown): string {
  const b = blob && typeof blob === 'object' ? blob as Record<string, unknown> : null;
  const oa = b?.oauthAccount && typeof b.oauthAccount === 'object'
    ? b.oauthAccount as Record<string, unknown>
    : null;
  if (!oa) return MIRROR_ABSENT;
  const id: MirrorIdentity = {
    accountUuid: str(oa.accountUuid),
    emailAddress: str(oa.emailAddress),
    organizationUuid: str(oa.organizationUuid),
  };
  // An `oauthAccount` with none of the three identifying fields is indistinguishable from
  // no account at all, and must not read as "a different account" every time it is seen.
  if (!id.accountUuid && !id.emailAddress && !id.organizationUuid) return MIRROR_ABSENT;
  return `${id.accountUuid}|${id.emailAddress}|${id.organizationUuid}`;
}

/**
 * The identity fingerprint of an authoritative probe result.
 *
 * `loggedIn: null` (an old CLI, Bedrock/Vertex, a failed probe) collapses to a single
 * `unknown` fingerprint rather than to the fields underneath it. That is what stops a
 * flaky probe from reading as a parade of account switches: two consecutive "I can't tell"
 * answers are the SAME answer, and comparing them must produce no change.
 *
 * Exported pure for tests.
 */
export function statusFingerprint(s: ClaudeAuthStatus): string {
  if (s.loggedIn !== true) return s.loggedIn === false ? 'signed-out' : 'unknown';
  return `in|${s.email ?? ''}|${s.orgId ?? ''}|${s.method ?? ''}|${s.subscription ?? ''}`;
}

/** "someone@example.com · team", or '' when the probe knows no name for it. */
export function describeIdentity(s: ClaudeAuthStatus): string {
  return [s.email, s.subscription].filter(Boolean).join(' · ');
}

/**
 * May a LIVE session be restarted onto this status?
 *
 * Only a confirmed sign-in. The two rejected cases are rejected for the same reason —
 * restarting would make things strictly worse:
 *   • `signed-out`: the restarted process fails its very first turn. The one already
 *     running may still be holding a valid token and finishing real work; killing it to
 *     replace it with a session that cannot talk to the API helps nobody. The user gets
 *     told, and the existing sign-in banner catches the turn that eventually does fail.
 *   • `unknown`: the probe could not answer, so there is no evidence a switch happened at
 *     all — only that the mirror file moved. Never restart on a guess.
 *
 * Exported pure for tests.
 */
export function isRestartable(s: ClaudeAuthStatus): boolean {
  return s.loggedIn === true;
}

/** What a subscriber is handed when the account changes. */
export interface ClaudeAuthChange {
  /** The watcher's epoch AFTER this change. A session whose recorded epoch is lower than
   *  this predates the switch. */
  epoch: number;
  /** The authoritative status the CLI reported after the change. */
  status: ClaudeAuthStatus;
  /** Display label — `describeIdentity`, possibly ''. */
  identity: string;
  /** Whether a live session should actually be restarted onto it — see `isRestartable`. */
  restartable: boolean;
}

export interface ClaudeAuthWatcher {
  /** Register interest. Starts the poll on the first subscriber, stops it after the last
   *  unsubscribes — an app with no live chat costs nothing. */
  subscribe: (cb: (change: ClaudeAuthChange) => void) => () => void;
  /** The current epoch. Record this at spawn; compare it against `change.epoch`. */
  epoch: () => number;
  /** Run one check right now. The poll calls this; tests drive it directly instead of
   *  waiting on a timer. Never throws, never runs concurrently with itself. */
  check: () => Promise<void>;
  /**
   * Feed in an authoritative status somebody else already paid for, and advance the epoch if
   * it names a different account.
   *
   * `/api/agent/capabilities` runs the very same probe every 30s for its own reasons, and
   * throwing that answer away would leave TWO notions of "the current account" free to
   * disagree. It also makes the epoch correct on a machine with no live chat at all: nothing
   * is subscribed, so the file poll is not even running, but a surface that only polls
   * capabilities still learns that the account moved.
   */
  observe: (status: ClaudeAuthStatus) => void;
  /** Subscriber count — for tests asserting the poll is refcounted. */
  subscriberCount: () => number;
}

export interface AuthWatcherDeps {
  /** Honours `$HOME` by default, exactly like claude-usage.ts — so a scratch-HOME verify
   *  run reads its own fixture and never the developer's real profile. */
  home?: string;
  /** The authoritative probe. Injected for tests; production uses the real CLI spawn. */
  probe?: () => Promise<ClaudeAuthStatus>;
  /** Drop claude-auth.ts's 5s memo so `/api/agent/capabilities` reports the new account on
   *  its very next poll instead of up to 5s of the old one. */
  invalidate?: () => void;
  /** Poll cadence. One `statSync` per tick — the JSON is re-parsed only when the mtime
   *  actually moved, and the CLI probe runs only when the fingerprint actually changed. */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 2_000;

/**
 * Build a watcher. Production uses the {@link claudeAuthWatcher} singleton below; tests
 * build their own with a fixture HOME and a fake probe, and drive `check()` by hand so no
 * test depends on a timer or on the developer's real credentials.
 */
export function createClaudeAuthWatcher(deps: AuthWatcherDeps = {}): ClaudeAuthWatcher {
  const home = deps.home ?? homedir();
  const probe = deps.probe ?? claudeAuthStatus;
  const invalidate = deps.invalidate ?? resetClaudeAuthCache;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const file = join(home, '.claude.json');

  const listeners = new Set<(change: ClaudeAuthChange) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let epoch = 0;
  /** The mirror fingerprint we have already accounted for. `null` = not yet baselined. */
  let knownMirror: string | null = null;
  /** The authoritative fingerprint of the account in force. Only set once a probe has run,
   *  so the first real change compares against the probe rather than against nothing. */
  let knownStatus: string | null = null;
  /** Whether the one-off startup probe has been ATTEMPTED (not whether it succeeded). A probe
   *  that answers "can't tell" leaves `knownStatus` null by design, and without this the poll
   *  would re-spawn the CLI every tick forever trying to fill it. */
  let baselineProbed = false;
  let lastMtimeMs = -1;
  let checking = false;

  /** The mirror's fingerprint right now, re-parsing only when the file actually moved.
   *  An unreadable/absent file is `MIRROR_ABSENT`, the same as a signed-out one: both mean
   *  "no account is named here", and the probe decides what that is worth. */
  function readMirror(): string {
    let mtimeMs: number;
    try { mtimeMs = statSync(file).mtimeMs; }
    catch { lastMtimeMs = -1; return MIRROR_ABSENT; }
    if (mtimeMs === lastMtimeMs && knownMirror !== null) return knownMirror;
    lastMtimeMs = mtimeMs;
    try { return mirrorFingerprint(JSON.parse(readFileSync(file, 'utf-8'))); }
    catch { return MIRROR_ABSENT; }
  }

  /**
   * The one place the epoch can advance, whichever feed produced the status. Synchronous, so
   * a capabilities-driven `observe` racing the poll's own probe can only ever land before or
   * after it — never half-way through.
   *
   * Two rules do the real work here:
   *
   *   AN UNKNOWN ANSWER IS INERT. It neither announces nor baselines. "I couldn't tell" is
   *   not evidence of anything, and letting it become the remembered state would make the
   *   NEXT successful probe look like a switch — so one timed-out probe would restart every
   *   live session on a machine where nothing changed at all.
   *
   *   THE FIRST KNOWN ANSWER BASELINES. There is nothing to compare it against, and the app
   *   has to learn which account it started on somehow.
   */
  function applyStatus(status: ClaudeAuthStatus): void {
    const fingerprint = statusFingerprint(status);
    if (fingerprint === 'unknown') return;
    if (knownStatus === null) { knownStatus = fingerprint; return; }
    if (fingerprint === knownStatus) return;
    knownStatus = fingerprint;

    epoch += 1;
    const change: ClaudeAuthChange = {
      epoch,
      status,
      identity: describeIdentity(status),
      restartable: isRestartable(status),
    };
    // A throwing listener must not stop the others from being told, nor kill the poll.
    for (const cb of [...listeners]) {
      try { cb(change); } catch { /* a subscriber's problem, not the watcher's */ }
    }
  }

  async function check(): Promise<void> {
    // A probe takes seconds; a tick takes milliseconds. Without this the poll would stack
    // probes on top of each other during a slow one.
    if (checking) return;
    checking = true;
    try {
      const mirror = readMirror();
      const firstLook = knownMirror === null;
      if (firstLook) knownMirror = mirror;

      if (!firstLook && mirror !== knownMirror) {
        knownMirror = mirror;
        // The mirror moved. Now find out what actually happened, authoritatively.
        // Invalidating first is what makes the probe a fresh one rather than claude-auth.ts's
        // 5s memo, and also what makes `/api/agent/capabilities` report the new account on
        // its next poll.
        invalidate();
        applyStatus(await probe());
        return;
      }

      // Nothing moved. Pay for ONE probe, ever, to learn which account we started on — and
      // only if nobody has already told us (`observe`, from the capabilities route, almost
      // always has by now).
      //
      // This is what makes the module self-sufficient rather than dependent on another route
      // having run first. Without it, `knownStatus` would still be null when the user's FIRST
      // switch arrived, that probe would silently become the baseline, and the one change the
      // whole feature exists for would be the one it swallowed.
      if (!baselineProbed && knownStatus === null) {
        baselineProbed = true;
        applyStatus(await probe());
      }
    } finally {
      checking = false;
    }
  }

  function start(): void {
    if (timer) return;
    // Take the MIRROR baseline synchronously — it costs one `stat` and one parse, and it has
    // to be taken NOW: a switch made two seconds into the session must compare against the
    // account we actually started on, not against the one it moved to.
    if (knownMirror === null) knownMirror = readMirror();
    timer = setInterval(() => { void check(); }, intervalMs);
    // Never hold the process open on this — a `dreamcontext` CLI run that happens to touch
    // the watcher must still exit.
    timer.unref?.();
    // The AUTHORITATIVE baseline is deliberately NOT taken here. `start()` runs on the chat
    // spawn path, with a user waiting on a pane, and a probe is a CLI process spawn measured
    // at ~4.8s cold. It rides the first tick instead.
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    subscribe(cb) {
      listeners.add(cb);
      start();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        listeners.delete(cb);
        if (listeners.size === 0) stop();
      };
    },
    epoch: () => epoch,
    check,
    observe: applyStatus,
    subscriberCount: () => listeners.size,
  };
}

/** The process-wide watcher every live chat session subscribes to. */
export const claudeAuthWatcher = createClaudeAuthWatcher();
