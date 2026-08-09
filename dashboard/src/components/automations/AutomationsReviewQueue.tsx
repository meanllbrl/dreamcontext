import { useState } from 'react';
import { useAnswerReviewCard, useReviewQueue, type ReviewCard } from '../../hooks/useAutomations';
import './AutomationsReviewQueue.css';

/**
 * The review queue — everything a run stopped to ask about, above the board.
 *
 * It sits ABOVE the grid rather than inside it because it answers a different
 * question. The grid answers "what automations do I have"; this answers "what
 * am I holding up", and every card in it is blocking that automation from
 * running again. A queue folded into the grid would be a state you scroll past.
 *
 * The reading surface is the point. The three buttons are small and the
 * proposal is large, because a verdict given without reading is precisely the
 * failure this whole feature exists to prevent — the same reason the CLI's
 * `automations review <slug>` prints the proposal and makes the flags opt-in.
 */
function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function CardRow({ card, onToast }: { card: ReviewCard; onToast: (t: string) => void }) {
  const answer = useAnswerReviewCard();
  const [steer, setSteer] = useState('');
  const [expanded, setExpanded] = useState(false);

  // A card whose proposing run left no session cannot be resumed, so approve
  // and correct cannot work. Saying so beats offering buttons that fail.
  const resumable = card.sessionId !== null;
  const busy = answer.isPending;

  const send = (payload: { verdict?: 'approve' | 'discard' | 'drop'; steer?: string }) => {
    answer.mutate(
      { id: card.id, ...payload },
      {
        onSuccess: (res) => {
          if (payload.steer) {
            setSteer('');
            onToast(res.lesson ? `Rewritten · 🧠 learned: ${res.lesson}` : 'Rewritten — have another look.');
          } else {
            onToast(
              res.card.resolutionError
                ? `${res.card.state}, but it did not finish cleanly: ${res.card.resolutionError}`
                : `${res.card.state}${res.card.resolutionNote ? ` — ${res.card.resolutionNote}` : ''}`,
            );
          }
        },
        onError: (err) => onToast((err as Error).message || 'That card could not be answered.'),
      },
    );
  };

  const body = expanded || card.body.length <= 700 ? card.body : `${card.body.slice(0, 700).trimEnd()}…`;

  return (
    <div className="arq-card">
      <div className="arq-card-head">
        <span className="arq-slug">{card.slug}</span>
        <span className="arq-title">{card.title}</span>
        <span className="arq-age">{timeAgo(card.createdAt)}</span>
      </div>

      <pre className="arq-body">{body}</pre>
      {card.body.length > 700 && (
        <button type="button" className="arq-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'show less' : 'show the whole proposal'}
        </button>
      )}

      {card.steers.length > 0 && (
        <div className="arq-steers">
          {card.steers.map((s, i) => (
            <div key={i} className="arq-steer">
              <span className="arq-steer-text">“{s.text}”</span>
              {s.lesson && <span className="arq-steer-lesson">🧠 {s.lesson}</span>}
            </div>
          ))}
        </div>
      )}

      {!resumable && (
        <div className="arq-warn">
          The run that proposed this left no session to reply to — it can be rejected, but not approved or corrected.
        </div>
      )}

      <div className="arq-steer-row">
        <input
          className="arq-steer-input"
          // A placeholder is not a label: it disappears the moment you type and
          // is exposed inconsistently across screen readers.
          aria-label={`Correct the proposal "${card.title}" in plain language — it is rewritten and comes back to you, never sent`}
          placeholder="Correct it in plain language — it gets rewritten and comes back to you"
          value={steer}
          disabled={busy || !resumable}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && steer.trim() && !busy) send({ steer: steer.trim() });
          }}
        />
        <button
          type="button"
          className="arq-btn arq-btn--steer"
          disabled={busy || !resumable || !steer.trim()}
          onClick={() => send({ steer: steer.trim() })}
        >
          Rewrite
        </button>
      </div>

      <div className="arq-actions">
        <button
          type="button"
          className="arq-btn arq-btn--approve"
          disabled={busy || !resumable}
          title={resumable ? 'Carry it out' : 'No session to resume'}
          onClick={() => send({ verdict: 'approve' })}
        >
          ✅ Approve
        </button>
        <button type="button" className="arq-btn" disabled={busy} onClick={() => send({ verdict: 'discard' })}>
          🚫 Reject
        </button>
        <button
          type="button"
          className="arq-btn arq-btn--drop"
          disabled={busy}
          title="Rejects it AND teaches the automation never to propose this kind again"
          onClick={() => send({ verdict: 'drop' })}
        >
          🗑 Never again
        </button>
        {busy && <span className="arq-busy">working…</span>}
      </div>
    </div>
  );
}

export function AutomationsReviewQueue({ onToast }: { onToast: (t: string) => void }) {
  const { data: cards } = useReviewQueue();
  if (!cards || cards.length === 0) return null;

  return (
    <div className="arq">
      <div className="arq-head">
        <span className="arq-heading">Waiting for your verdict</span>
        <span className="arq-count">{cards.length}</span>
        <span className="arq-note">
          These automations do not run again until you answer.
        </span>
      </div>
      {cards.map((card) => (
        <CardRow key={card.id} card={card} onToast={onToast} />
      ))}
    </div>
  );
}
