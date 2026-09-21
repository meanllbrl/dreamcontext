import { AgentAvatar } from './AgentAvatar';
import type { FeedMessage, FeedStatus } from '../../hooks/useAutomations';

/**
 * ONE RUN, AS ONE MESSAGE — the shape this whole step exists to get approved.
 *
 * Reading order is the design: who, when, how it went, then what it said. The
 * first three are one line of small type; the agent's own words get the room.
 *
 * A message is NOT a card. It has no border and no fill — it is a row in a
 * channel, the way Slack's is, because fifty bordered cards in a column read as
 * fifty things to deal with rather than a conversation to catch up on. The only
 * message that gets a surface of its own is an unread one, and that is an
 * accent BAR on the left edge, not a tint across the whole row (K8: the accent
 * budget is spent on pointing, never on decorating).
 */

/** The status WORD (K26/K40) — never a coloured pill. `needs-you` is the only
 *  one that is a call to action rather than a report, and it is the only one
 *  that earns a colour. */
const STATUS_WORD: Record<FeedStatus, string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  timeout: 'timed out',
  'needs-you': 'needs you',
  skipped: "didn't run",
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "4m 12s" / "41s". Matches the runner's own wording in the thread's system
 *  rows, so the same run never reports its length two different ways. */
function duration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** Cost is shown to the cent below a dollar and to the cent above it — an
 *  automation's run is a few cents and `$0.3100000004` is not a number a human
 *  reads. Null (a run that never reported one) shows nothing at all rather
 *  than `$0.00`, which would claim it was free. */
function cost(usd: number | null): string | null {
  return usd === null || !Number.isFinite(usd) ? null : `$${usd.toFixed(2)}`;
}

export function AgentMessage({
  message,
  onOpenThread,
  onOpenFile,
  onOpenAgent,
  showHead = true,
}: {
  message: FeedMessage;
  onOpenThread: (m: FeedMessage) => void;
  onOpenFile: (path: string) => void;
  onOpenAgent: (slug: string) => void;
  /** False inside the thread panel, where the message is the root and its
   *  header is already the panel's own. */
  showHead?: boolean;
}) {
  const meta = [duration(message.durationMs), cost(message.costUsd)].filter(Boolean).join(' · ');

  return (
    <>
      {/* THE ASK. A run the owner started by typing opens with their own words,
          as their own row — the exchange reads the way it happened, question
          then answer, rather than burying the question in a thread nobody
          opens. Not repeated inside the thread panel (`showHead === false`):
          the panel lists every entry already, this one included. */}
      {showHead && message.ask && (
        <article className="agent-msg agent-msg--you">
          <div className="agent-msg-av">
            <span className="agent-you-av" aria-hidden="true">You</span>
          </div>
          <div className="agent-msg-body">
            <div className="agent-msg-head">
              <span className="agent-msg-name agent-msg-name--plain">You</span>
              <span className="agent-msg-time">{hhmm(message.ask.at)}</span>
              <span className="agent-msg-meta">asked {message.title}</span>
            </div>
            <p className="agent-msg-text">{message.ask.text}</p>
          </div>
        </article>
      )}
    <article className={`agent-msg${message.unread ? ' agent-msg--unread' : ''}`}>
      <div className="agent-msg-av">
        <AgentAvatar
          slug={message.slug}
          title={message.title}
          hasPhoto={message.hasPhoto}
          size={36}
          version={message.runId}
        />
      </div>

      <div className="agent-msg-body">
        {showHead && (
          <div className="agent-msg-head">
            {/* The name opens the agent — the prototype's "click an agent's
                name" affordance. A button, not a link: it changes what this
                page shows, it does not navigate anywhere. */}
            <button type="button" className="agent-msg-name" onClick={() => onOpenAgent(message.slug)}>
              {message.title}
            </button>
            <span className="agent-msg-time">{hhmm(message.at)}</span>
            <span className={`agent-msg-status agent-msg-status--${message.status}`}>
              {STATUS_WORD[message.status]}
            </span>
            {meta && <span className="agent-msg-meta">{meta}</span>}
          </div>
        )}

        {message.text ? (
          <p className={`agent-msg-text${message.textFrom === 'error' ? ' agent-msg-text--error' : ''}`}>
            {message.text}
          </p>
        ) : message.status === 'running' ? (
          // A run in flight has nothing to say YET. Saying so is the honest
          // state; an empty row reads as a message that failed to load.
          <p className="agent-msg-text agent-msg-text--quiet">Working…</p>
        ) : (
          <p className="agent-msg-text agent-msg-text--quiet">Nothing to report.</p>
        )}

        {/* WHERE THE WORDS CAME FROM. An agent that chose to post and an agent
            that said nothing (so we are showing its document's opening line)
            are different claims, and a reader deciding whether to open the
            thread is entitled to know which one they are looking at. */}
        {message.textFrom === 'result' && message.text && (
          <p className="agent-msg-from">from its document — it posted nothing</p>
        )}
        {message.textFrom === 'error' && message.text && (
          <p className="agent-msg-from">the run's own error — it never published</p>
        )}

        {message.files.length > 0 && (
          <div className="agent-msg-files">
            {message.files.map((f) => (
              <button
                key={f.path}
                type="button"
                className="agent-msg-file"
                onClick={() => onOpenFile(f.path)}
                title={f.path}
              >
                <span className="agent-msg-file-glyph" aria-hidden="true">◧</span>
                <span className="agent-msg-file-name">{f.name}</span>
              </button>
            ))}
          </div>
        )}

        {showHead && (
          message.replyCount > 0 ? (
            <button type="button" className="agent-msg-replies" onClick={() => onOpenThread(message)}>
              <strong>
                {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
              </strong>
              {message.lastReplyAt && <span>last {hhmm(message.lastReplyAt)}</span>}
            </button>
          ) : (
            // Not "Reply in thread" — replying does not exist until step 4, and
            // a control that names an action it cannot perform is worse than
            // one that names what it can.
            <button type="button" className="agent-msg-replies agent-msg-replies--quiet" onClick={() => onOpenThread(message)}>
              Open thread
            </button>
          )
        )}
      </div>
    </article>
    </>
  );
}
