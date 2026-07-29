import { useEffect, useRef, useState } from 'react';
import type { ChatSession } from '../chatSession';

/**
 * ORGANISM — the message queue: the strip of messages submitted while Claude was working,
 * docked directly above the composer, each editable and removable until it goes out.
 *
 * What lands here, since 07-29: only what the user CHOSE to hold — the composer's ⇡. ⏎ steers
 * into the running turn instead (Composer.tsx's `commit`), which is what the terminal's own
 * readline does and what this strip's first cut got wrong: every ⏎ came here and waited out
 * the whole turn, so a correction meant for the next tool call arrived after the last one.
 *
 * So these rows are a deliberate "not this turn, the next one", and each keeps a Send now that
 * changes its mind — cutting that one message into the turn in flight while the rest keep
 * their place in line.
 *
 * Why DOCKED rather than inline in the transcript (the BackgroundShellsTray precedent): a
 * queued message is not part of the conversation yet — it is pending input, it belongs beside
 * the composer that produced it, and it must not scroll away while you decide whether to edit
 * it. It also stays mounted when the session ENDS, which is deliberate: the rows are the only
 * copy of that text, and dropping them because the process exited would destroy work the user
 * can still recover with Resume.
 *
 * Height is bounded the same way the shells tray is (its own scroller, capped) — docked
 * furniture takes its height straight out of the transcript, and a queue has no natural
 * ceiling.
 */

function QueuedRow({
  index, text, sendNowTitle, onSendNow, onSave, onRemove,
}: {
  index: number;
  text: string;
  /** Why "Send now" is unavailable, or `null` when it is available — the row renders it as
   *  the button's tooltip rather than just greying out with no reason given. */
  sendNowTitle: string | null;
  onSendNow: () => void;
  onSave: (next: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Opening the editor starts from what is queued NOW, not from whatever was typed into a
  // previous edit that was cancelled.
  useEffect(() => {
    if (!editing) return;
    setValue(text);
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editing, text]);

  if (editing) {
    return (
      <li className="chat-queue-row chat-queue-row-editing">
        <span className="chat-queue-num" aria-hidden>{index + 1}</span>
        <textarea
          ref={taRef}
          className="chat-queue-edit"
          value={value}
          rows={Math.min(6, value.split('\n').length + 1)}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // ⏎ saves and ⇧⏎ adds a line — the same contract as the composer this row came
            // from, so the muscle memory carries over.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSave(value);
              setEditing(false);
              return;
            }
            if (e.key === 'Escape') {
              // Stopped here: Esc in this pane also collapses the whole agent overlay, and
              // cancelling an edit must not take the surface with it.
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
            }
          }}
          aria-label={`Edit queued message ${index + 1}`}
        />
        <span className="chat-queue-actions">
          <button type="button" className="chat-queue-btn" onClick={() => { onSave(value); setEditing(false); }}>Save</button>
          <button type="button" className="chat-queue-btn" onClick={() => setEditing(false)}>Cancel</button>
        </span>
      </li>
    );
  }

  return (
    <li className="chat-queue-row">
      <span className="chat-queue-num" aria-hidden>{index + 1}</span>
      {/* The whole text IS the edit affordance — a pencil icon beside a click target that
          does nothing else is just a smaller version of the same button. */}
      <button
        type="button"
        className="chat-queue-text"
        onClick={() => setEditing(true)}
        title="Edit this queued message"
      >{text}</button>
      <span className="chat-queue-actions">
        {/* Jump the line. First in the row because it is the action a queued message most
            often wants once you have re-read it — "actually, say this now" — and because the
            two beside it (Edit, ✕) are already reachable by clicking the text itself. */}
        <button
          type="button"
          className="chat-queue-btn accent"
          disabled={!!sendNowTitle}
          title={sendNowTitle ?? 'Send this one into the running turn now'}
          aria-label={`Send queued message ${index + 1} now`}
          onClick={onSendNow}
        >Send now</button>
        <button type="button" className="chat-queue-btn" onClick={() => setEditing(true)}>Edit</button>
        <button
          type="button"
          className="chat-cmp-chip-x"
          aria-label={`Remove queued message ${index + 1}`}
          onClick={onRemove}
        >✕</button>
      </span>
    </li>
  );
}

/**
 * What the strip is waiting FOR — the two kinds of row wait for different things, and saying
 * "sends when this turn ends" over a row that is actually owed the next opening would be the
 * same wrong promise this whole change is undoing.
 *
 * @param owed how many rows are `steerWhenPossible` — parked by a ⏎ that could not steer.
 */
function whenLabel(paused: boolean, total: number, owed: number): string {
  if (paused) return ' · paused';
  if (owed === 0) return ' · sends when this turn ends';
  if (owed === total) return ' · sends at the first opening';
  return ` · ${owed} at the first opening, the rest when this turn ends`;
}

export function QueuedMessages({ session }: { session: ChatSession }) {
  const conv = session.getModel();
  const queued = conv.queued;
  if (queued.length === 0) return null;

  const paused = !!conv.queuePaused;
  const ended = !!conv.exited || !!conv.authRequired;
  const owed = queued.filter((q) => q.steerWhenPossible).length;

  /**
   * Why a row's "Send now" is unavailable, or null when it isn't — one place, so the tooltip
   * and the disabled state can never disagree about it.
   *
   * The `asking` case is the interesting one: a card is open, so the CLI is parked on that
   * answer and a message written now would be talking over it — and the thing the user
   * actually wants (say no, and say why) is the card's own deny-with-a-message. Deliberately
   * NOT blocked by `paused`: Stop held the queue from draining BY ITSELF, and clicking this
   * button is the opposite of by itself.
   */
  const sendNowTitle = ended || session.status === 'closed'
    ? 'This session has ended — Resume it first'
    : session.asking
      ? 'Answer the open card first — this would talk over it'
      : session.busy && !session.canSteer()
        ? 'Not connected'
        : null;

  return (
    <div className="chat-queue" data-paused={paused || undefined}>
      <div className="chat-queue-head">
        {/* Monochrome dingbats, not ⏳/⏸: the agent surface deliberately carries no colour
            emoji (see the 07-25 glyph pass — ◆/◇/>_/⚡/⚠), and an amber hourglass beside a
            neutral strip reads as a warning rather than as "waiting its turn". */}
        <span className="chat-queue-glyph" aria-hidden>{paused ? '‖' : '◷'}</span>
        <span className="chat-queue-title">
          {queued.length} message{queued.length === 1 ? '' : 's'} held
          {/* Says WHEN, because a queue that looks stalled and a queue that is waiting its turn
              are indistinguishable from the rows alone — and the two kinds of row genuinely
              wait for different things, so a single "sends when this turn ends" would be a
              lie about half of them the moment a card forced a ⏎ in here. */}
          <span className="chat-queue-when">{whenLabel(paused, queued.length, owed)}</span>
        </span>
        {/* "Resume", not "Send now": every ROW now has a Send now that means one specific
            message, and this one means something else entirely — lift the Stop pause and let
            the queue go back to draining on its own. Two buttons reading "Send now" a few
            pixels apart and doing different things is the confusion worth spending a word on. */}
        {paused && (
          <button
            type="button"
            className="chat-queue-btn accent"
            title="Lift the pause Stop put on this queue and let it drain again"
            onClick={() => session.flushQueue()}
          >Resume</button>
        )}
        <button type="button" className="chat-queue-btn" onClick={() => session.removeQueued()}>Clear</button>
      </div>
      <ul className="chat-queue-rows">
        {queued.map((q, i) => (
          <QueuedRow
            key={q.id}
            index={i}
            text={q.text}
            sendNowTitle={sendNowTitle}
            onSendNow={() => session.sendQueuedNow(q.id)}
            onSave={(next) => session.editQueued(q.id, next)}
            onRemove={() => session.removeQueued(q.id)}
          />
        ))}
      </ul>
    </div>
  );
}
