import { useEffect, useState } from 'react';
import { BotMark } from '../AgentSetup';
import { AlertIcon } from './atoms';

/** The banner states one sentence: what broke, then the reassurance. Keeps the CLI's own
 *  wording, adds the period it usually lacks. */
function reasonSentence(message: string): string {
  const m = message.trim();
  if (!m) return 'The connection dropped mid-response.';
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/**
 * Empty state (1), working indicator, stream-error (12), reconnecting chip (12),
 * session-ended (12). No "idle" status word anywhere (redesign rule 6).
 */

export function EmptyState() {
  return (
    <div className="chat-banner-empty">
      <BotMark />
      <h3 className="chat-banner-empty-title">Say something to start</h3>
      <p className="chat-banner-empty-sub">Ask a question, hand off a task, or just say hi.</p>
    </div>
  );
}

/**
 * The turn is running but has nothing on screen yet — the gap between sending a message and
 * the CLI's first frame (process spawn + SessionStart brain preload: seconds on the first
 * turn), and every later gap between a tool result and the next block. Without it the pane
 * looks idle while it is working, which is how a live session reads as a hung one.
 *
 * The elapsed clock is the point: it is the difference between "waiting" and "stuck". Ticks
 * only while mounted, and mounts only during those gaps.
 */
export function WorkingIndicator({ label, startedAt }: { label: string; startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // No `startedAt` (a turn that was already running when this view attached) → the clock
  // starts from mount rather than showing a number that would be a guess.
  const [base] = useState(() => startedAt ?? Date.now());
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? base)) / 1000));

  return (
    <div className="chat-working" role="status" aria-live="polite">
      <span className="chat-working-dots" aria-hidden>
        <span /><span /><span />
      </span>
      <span className="chat-working-label">{label}</span>
      {seconds > 0 && <span className="chat-working-elapsed">{seconds}s</span>}
    </div>
  );
}

export function StreamErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="chat-banner-error" role="alert">
      <AlertIcon />
      <div className="chat-banner-error-body">
        <span className="chat-banner-error-title">The model stream was interrupted</span>
        <p className="chat-banner-error-sub">{reasonSentence(message)} Your message is safe.</p>
      </div>
      <button type="button" className="chat-btn pill danger" onClick={onRetry}>
        <span aria-hidden>⟳</span> Retry
      </button>
    </div>
  );
}

/**
 * What the fresh-session branch guard did to the working tree, or declined to do
 * (src/lib/session-start-branch.ts).
 *
 * A banner rather than a transcript item because it is a property of how the session STARTED,
 * not a turn in it — and a `git checkout` nobody asked for in this turn must not be something
 * the user only discovers by scrolling. `warn` is the refusal ("staying on feat/x, the tree is
 * dirty"), which is the arm that leaves the session somewhere the user was told new sessions
 * would not start; `info` is a move that was made. Dismissable, because it reports a one-time
 * event: once read, it is history.
 */
export function BranchStartBanner({ tone, message, onDismiss }: {
  tone: 'info' | 'warn';
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className={`chat-banner-branch${tone === 'warn' ? ' is-warn' : ''}`} role="status">
      <span className="chat-banner-branch-mark" aria-hidden>{tone === 'warn' ? '⚠' : '⑂'}</span>
      <p className="chat-banner-branch-sub">{message}</p>
      <button
        type="button"
        className="chat-banner-branch-x"
        aria-label="Dismiss this notice"
        title="Dismiss"
        onClick={onDismiss}
      >×</button>
    </div>
  );
}

/**
 * The account move, SHOWN. The billed account never changes silently — that is a constraint of
 * this feature, not a nicety — so every automatic switch is drawn and NAMES the account it
 * moved to, along with why.
 *
 * Three shapes, because the three outcomes mean different things to the user:
 *   • switched          — "moved to <account>, its session window is at N%". Reassurance: the
 *                         turn went through, on a named account.
 *   • all_exhausted     — every account is out. This one says WHEN work resumes rather than
 *                         only that it failed, which is the difference between an error and
 *                         information the user can act on.
 *   • auto_switch_disabled — the limit is close and the setting is OFF, so nothing changed.
 *                         Reporting without acting is exactly what "off" was asked to mean.
 */
export function AccountSwitchBanner({ move, onDismiss }: {
  move: {
    switched: boolean;
    reason: 'limit_near' | 'needs_relogin' | 'all_exhausted' | 'auto_switch_disabled';
    accountId: string;
    email?: string;
    sessionPercent?: number;
    earliestResetAt?: number;
    rejected?: Array<{ id: string; why: string }>;
  };
  onDismiss: () => void;
}) {
  const who = move.email || move.accountId;
  const tone = move.switched ? 'info' : move.reason === 'all_exhausted' ? 'warn' : 'info';
  const when = move.earliestResetAt
    ? new Date(move.earliestResetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const message = move.switched
    ? (move.reason === 'needs_relogin'
        ? `Moved to ${who} — the previous account needs to sign in again.`
        : `Moved to ${who}${move.sessionPercent === undefined ? '' : ` · its 5-hour window is at ${Math.round(move.sessionPercent)}%`}.`)
    : move.reason === 'all_exhausted'
      ? (when
          ? `Every account is at its limit. The first one frees up at ${when} — this message went out on the current account, so you will see its own limit error if it lands.`
          : 'Every account is at its limit. This message went out on the current account.')
      : 'This account is close to its limit. Auto-switch is off, so nothing was changed.';

  return (
    <div className={`chat-banner-branch${tone === 'warn' ? ' is-warn' : ''}`} role="status">
      <span className="chat-banner-branch-mark" aria-hidden>{move.switched ? '⇄' : '⚠'}</span>
      <div className="chat-banner-branch-sub">
        <p>{message}</p>
        {move.rejected && move.rejected.length > 0 && (
          <p className="chat-banner-branch-why">
            {move.rejected.map((r) => `${r.id}: ${r.why}`).join(' · ')}
          </p>
        )}
      </div>
      <button
        type="button"
        className="chat-banner-branch-x"
        aria-label="Dismiss this notice"
        title="Dismiss"
        onClick={onDismiss}
      >×</button>
    </div>
  );
}

export function ReconnectingChip() {
  return (
    <div className="chat-banner-reconnecting">
      <span className="chat-banner-reconnecting-dot" aria-hidden />
      Reconnecting…
    </div>
  );
}

/**
 * The CLI has no usable credentials (chatProtocol's `auth-required`). Replaces the composer,
 * because every message typed into an unauthenticated session comes straight back as the same
 * notice — and because the fix is not on this surface: the headless engine answers `/login`
 * with "/login isn't available in this environment.", so the OAuth flow can only run in the
 * interactive TUI. `canSignInInApp` is whether that TUI can run in-app at all (node-pty + the
 * CLI); without it the honest answer is the command to run in a real terminal, not a button
 * that would open a pane that can't start.
 *
 * "Retry" respawns this same conversation (`--resume`), which is the recovery path whether the
 * CLI stayed alive after the failed turn or exited — a signed-in respawn picks the transcript
 * up where it stopped.
 */
export function SignInBanner({ canSignInInApp, command, onSignIn, onRetry }: {
  canSignInInApp: boolean;
  /** The sign-in command the INSTALLED CLI actually has (`claude auth login` on 2.1.x; plain
   *  `claude` on one too old for the subcommand). Server-probed rather than hardcoded, so this
   *  text can never name a command this machine doesn't have. */
  command: string;
  onSignIn: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="chat-banner-signin" role="alert">
      <div className="chat-banner-signin-head">
        <AlertIcon />
        <span className="chat-banner-signin-title">Not signed in to Claude</span>
      </div>
      <p className="chat-banner-signin-sub">
        {canSignInInApp
          ? `Chat runs Claude headlessly, and the sign-in flow needs a real terminal. Opening one here runs ${command} — Claude Code takes it from there.`
          : 'The in-app terminal isn’t available on this machine, so sign in from a real terminal:'}
      </p>
      {!canSignInInApp && <code className="chat-banner-signin-cmd">{command}</code>}
      <div className="chat-card-actions">
        {canSignInInApp && (
          <button type="button" className="chat-btn primary" onClick={onSignIn}>Sign in in Terminal</button>
        )}
        <button type="button" className="chat-btn pill" onClick={onRetry}>Signed in — retry</button>
      </div>
    </div>
  );
}

export function SessionEndedBanner({ onResume }: { onResume: () => void }) {
  return (
    <div className="chat-banner-ended">
      <div className="chat-banner-ended-mark" aria-hidden>💤</div>
      <h3 className="chat-banner-ended-title">Session ended</h3>
      <p className="chat-banner-ended-sub">The process behind this chat exited. Your conversation is saved — resume it any time.</p>
      <button type="button" className="chat-btn primary" onClick={onResume}>Resume session</button>
    </div>
  );
}
