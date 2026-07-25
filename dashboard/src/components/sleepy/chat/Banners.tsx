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

export function ReconnectingChip() {
  return (
    <div className="chat-banner-reconnecting">
      <span className="chat-banner-reconnecting-dot" aria-hidden />
      Reconnecting…
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
