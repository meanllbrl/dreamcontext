import { useState } from 'react';
import type { ChatSession, PendingQuestion } from '../chatSession';
import type { QuestionSpec } from '../../../lib/chatProtocol';
import {
  OTHER_TOKEN, allValues, answeredCount, isComplete, isOtherChosen, pickFor,
  resolveAnswers, setOtherText, togglePick, type SurveyPicks,
} from './surveyAnswers';

/**
 * AskUserQuestion, state 5 — wider and fuller than a plain message: a `❓ Survey`
 * header, a `k / n` answered-progress readout when multiple questions are asked in
 * one card, display-weight question titles, and large select rows (checkbox for
 * multiSelect, radio for single). Width is the one shared `--chat-card-width`
 * (redesign rule 7 — the same value `PermissionCard`/`SubAgentCard` use).
 *
 * Every question also gets an "Other" row the card appends itself, because the tool
 * contract guarantees free text is always available and the model never ships that
 * option (see `surveyAnswers.ts` for why it is a sentinel token and not the label
 * "Other"). Selecting it reveals a real textarea whose TEXT — not the word "Other" —
 * becomes that question's answer; the row is otherwise a normal option, so under
 * single-select it replaces the listed pick and under multiSelect it rides alongside.
 * Submit stays disabled while a chosen "Other" box is still empty: that is an
 * unfinished answer, not a skip.
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
  const [picks, setPicks] = useState<SurveyPicks>({});
  const [submitted, setSubmitted] = useState(false);

  const answered = answeredCount(item.questions, picks);
  const complete = isComplete(item.questions, picks);
  const values = allValues(item.questions, picks);

  const submit = () => {
    if (!complete || submitted) return;
    setSubmitted(true);
    session.answerQuestion(item.requestId, item.questions, resolveAnswers(item.questions, picks));
  };

  const optionRow = (q: QuestionSpec, label: string, title: string, desc: string | undefined, on: boolean) => (
    <button
      key={label}
      type="button"
      className={`chat-surveycard-opt${on ? ' on' : ''}`}
      aria-pressed={on}
      onClick={() => setPicks((prev) => togglePick(prev, q, label))}
    >
      <span className={`chat-surveycard-opt-mark${q.multiSelect ? ' box' : ' radio'}`} aria-hidden>
        {on ? (q.multiSelect ? '✓' : '●') : ''}
      </span>
      <span className="chat-surveycard-opt-body">
        <span className="chat-surveycard-opt-title">{title}</span>
        {desc && <span className="chat-surveycard-opt-desc">{desc}</span>}
      </span>
    </button>
  );

  return (
    <div className="chat-surveycard">
      <div className="chat-surveycard-head">
        <span className="chat-surveycard-pill"><span aria-hidden>❓</span> Survey</span>
        {item.questions.length > 1 && (
          <span className="chat-surveycard-progress">{answered} / {item.questions.length}</span>
        )}
      </div>

      {submitted ? (
        <div className="chat-surveycard-receipt">
          <span className="chat-surveycard-receipt-check" aria-hidden>✓</span>
          <span>You chose: {values.join(', ') || '—'}</span>
        </div>
      ) : (
        <>
          {item.questions.map((q) => {
            const pick = pickFor(picks, q.question);
            const otherOn = isOtherChosen(picks, q.question);
            return (
              <div key={q.question} className="chat-surveycard-block">
                {q.header && <span className="chat-surveycard-helper">{q.header}</span>}
                <p className="chat-surveycard-title">{q.question}</p>
                <div className="chat-surveycard-options">
                  {q.options.map((o) => optionRow(q, o.label, o.label, o.description, pick.chosen.includes(o.label)))}
                  {optionRow(q, OTHER_TOKEN, 'Other', 'Write your own answer instead.', otherOn)}
                  {otherOn && (
                    <div className="chat-surveycard-other">
                      <textarea
                        className="chat-surveycard-otherinput"
                        // The row was just clicked in order to type here — focusing the box
                        // is the click's whole point; anything else costs a second click.
                        autoFocus
                        rows={2}
                        value={pick.otherText}
                        placeholder="Type your answer…"
                        aria-label={`Your own answer — ${q.question}`}
                        onChange={(e) => setPicks((prev) => setOtherText(prev, q, e.target.value))}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
                        }}
                      />
                      <span className="chat-surveycard-otherhint">⌘ / Ctrl + Enter to submit</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div className="chat-surveycard-foot">
            <span className="chat-surveycard-count">{values.length} selected</span>
            <button type="button" className="chat-btn primary" disabled={!complete} onClick={submit}>
              Submit <span aria-hidden>→</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
