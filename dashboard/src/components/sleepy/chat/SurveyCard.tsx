import { useState } from 'react';
import type { ChatSession, PendingQuestion } from '../chatSession';
import type { QuestionSpec } from '../../../lib/chatProtocol';

/**
 * AskUserQuestion, state 5 — wider and fuller than a plain message: a `❓ Survey`
 * header, a `k / n` answered-progress readout when multiple questions are asked in
 * one card, display-weight question titles, and large select rows (checkbox for
 * multiSelect, radio for single). Width is the one shared `--chat-card-width`
 * (redesign rule 7 — the same value `PermissionCard`/`SubAgentCard` use).
 *
 * NOTE on the "answered receipt" the design brief describes: `ChatSession` (T4,
 * frozen — not owned by this task) removes an answered question from
 * `conv.pending` optimistically with no ack frame and no retained record, so a
 * TRUE persistent receipt row is a data-model change outside T5's file ownership.
 * This component instead shows a brief local "submitted" confirmation the moment
 * `answerQuestion` fires — real feedback for the click, honest about what the
 * current engine can retain (the card itself unmounts on the next tick once the
 * item leaves `pending`).
 */

export function SurveyCard({ item, session }: { item: PendingQuestion; session: ChatSession }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [submitted, setSubmitted] = useState(false);

  const toggle = (q: QuestionSpec, label: string) => {
    setSelected((prev) => {
      const cur = prev[q.question] ?? [];
      const next = q.multiSelect
        ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label])
        : [label];
      return { ...prev, [q.question]: next };
    });
  };

  const answeredCount = item.questions.filter((q) => (selected[q.question] ?? []).length > 0).length;
  const allAnswered = answeredCount === item.questions.length;
  const selectedLabels = item.questions.flatMap((q) => selected[q.question] ?? []);

  const submit = () => {
    const picked: Record<string, string> = {};
    for (const q of item.questions) {
      const chosen = selected[q.question] ?? [];
      if (chosen.length) picked[q.question] = chosen.join(', ');
    }
    setSubmitted(true);
    session.answerQuestion(item.requestId, item.questions, picked);
  };

  return (
    <div className="chat-surveycard">
      <div className="chat-surveycard-head">
        <span className="chat-surveycard-pill"><span aria-hidden>❓</span> Survey</span>
        {item.questions.length > 1 && (
          <span className="chat-surveycard-progress">{answeredCount} / {item.questions.length}</span>
        )}
      </div>

      {submitted ? (
        <div className="chat-surveycard-receipt">
          <span className="chat-surveycard-receipt-check" aria-hidden>✓</span>
          <span>You chose: {selectedLabels.join(', ') || '—'}</span>
        </div>
      ) : (
        <>
          {item.questions.map((q) => (
            <div key={q.question} className="chat-surveycard-block">
              {q.header && <span className="chat-surveycard-helper">{q.header}</span>}
              <p className="chat-surveycard-title">{q.question}</p>
              <div className="chat-surveycard-options">
                {q.options.map((o) => {
                  const on = (selected[q.question] ?? []).includes(o.label);
                  return (
                    <button
                      key={o.label}
                      type="button"
                      className={`chat-surveycard-opt${on ? ' on' : ''}`}
                      onClick={() => toggle(q, o.label)}
                    >
                      <span className={`chat-surveycard-opt-mark${q.multiSelect ? ' box' : ' radio'}`} aria-hidden>
                        {on ? (q.multiSelect ? '✓' : '●') : ''}
                      </span>
                      <span className="chat-surveycard-opt-body">
                        <span className="chat-surveycard-opt-title">{o.label}</span>
                        {o.description && <span className="chat-surveycard-opt-desc">{o.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="chat-surveycard-foot">
            <span className="chat-surveycard-count">{selectedLabels.length} selected</span>
            <button type="button" className="chat-btn primary" disabled={!allAnswered} onClick={submit}>
              Submit <span aria-hidden>→</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
