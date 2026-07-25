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
 * Empty state (1), stream-error (12), reconnecting chip (12), session-ended (12).
 * No "idle" status word anywhere (redesign rule 6).
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
