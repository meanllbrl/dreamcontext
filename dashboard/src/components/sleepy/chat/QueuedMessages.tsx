import { useEffect, useRef, useState } from 'react';
import type { ChatSession } from '../chatSession';

/**
 * ORGANISM — the message queue: the strip of messages submitted while Claude was working,
 * docked directly above the composer, each editable and removable until it goes out.
 *
 * Why this surface exists at all: the terminal pane gets queueing for free from the CLI's own
 * readline (type while it works, press ⏎, it runs next). The Chat pane drives the same engine
 * headlessly, where no such buffer exists — its composer used to hard-return on `busy`, so ⏎
 * did nothing and the one thing you do constantly (line up the next instruction while a long
 * turn runs) was impossible on the surface that is now the default.
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
  index, text, onSave, onRemove,
}: {
  index: number;
  text: string;
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

export function QueuedMessages({ session }: { session: ChatSession }) {
  const conv = session.getModel();
  const queued = conv.queued;
  if (queued.length === 0) return null;

  const paused = !!conv.queuePaused;

  return (
    <div className="chat-queue" data-paused={paused || undefined}>
      <div className="chat-queue-head">
        {/* Monochrome dingbats, not ⏳/⏸: the agent surface deliberately carries no colour
            emoji (see the 07-25 glyph pass — ◆/◇/>_/⚡/⚠), and an amber hourglass beside a
            neutral strip reads as a warning rather than as "waiting its turn". */}
        <span className="chat-queue-glyph" aria-hidden>{paused ? '‖' : '◷'}</span>
        <span className="chat-queue-title">
          {queued.length} message{queued.length === 1 ? '' : 's'} queued
          {/* Says WHEN, because a queue that looks stalled and a queue that is waiting its turn
              are indistinguishable from the rows alone. */}
          <span className="chat-queue-when">{paused ? ' · paused' : ' · sends when this turn ends'}</span>
        </span>
        {paused && (
          <button type="button" className="chat-queue-btn accent" onClick={() => session.flushQueue()}>Send now</button>
        )}
        <button type="button" className="chat-queue-btn" onClick={() => session.removeQueued()}>Clear</button>
      </div>
      <ul className="chat-queue-rows">
        {queued.map((q, i) => (
          <QueuedRow
            key={q.id}
            index={i}
            text={q.text}
            onSave={(next) => session.editQueued(q.id, next)}
            onRemove={() => session.removeQueued(q.id)}
          />
        ))}
      </ul>
    </div>
  );
}
