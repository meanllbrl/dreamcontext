import { useLayoutEffect, useRef, useState } from 'react';
import type { ChatSession, PendingQuestion } from '../chatSession';
import type { QuestionSpec } from '../../../lib/chatProtocol';
import {
  OTHER_TOKEN, allValues, answeredCount, firstUnansweredIndex, isAnswered, isComplete,
  isOtherChosen, pickFor, resolveAnswers, setOtherText, togglePick, type SurveyPicks,
} from './surveyAnswers';

/**
 * AskUserQuestion, state 5 — wider and fuller than a plain message: a `❓ Survey`
 * header, a `k / n` answered-progress readout when multiple questions are asked in
 * one card, display-weight question titles, and large select rows (checkbox for
 * multiSelect, radio for single). Width is the one shared `--chat-card-width`
 * (redesign rule 7 — the same value `PermissionCard`/`SubAgentCard` use).
 *
 * MULTI-QUESTION CARDS PAGE HORIZONTALLY, one question per page (owner call, 2026-07-26).
 * Stacking every question vertically made a 2-question card taller than the pane: the
 * second question's options sat below the fold, the Submit button below THAT, and the
 * card read as a wall rather than as something being asked. Paging means one question
 * owns the card at a time, and the answer to "how much is left" moves into chrome that
 * is always visible (the dots, the `n left` jump) instead of into scroll distance.
 * Single-question cards render exactly as before — no arrows, no dots, no pager.
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
  const [page, setPage] = useState(0);

  const questions = item.questions;
  const total = questions.length;
  // Clamped rather than trusted: `page` is the only piece of card state that can outrun
  // the data it indexes, and an out-of-range page would translate the track into blank.
  const current = Math.min(page, Math.max(0, total - 1));
  const onLastPage = current >= total - 1;

  const answered = answeredCount(questions, picks);
  const complete = isComplete(questions, picks);
  const values = allValues(questions, picks);
  const nextGap = firstUnansweredIndex(questions, picks);   // -1 once nothing is left

  const pageEls = useRef<Array<HTMLDivElement | null>>([]);
  const paged = useRef(false);
  const [viewportH, setViewportH] = useState<number | null>(null);

  /**
   * The viewport is sized to the ACTIVE page. The track holds every question side by side,
   * so left alone the card would stand as tall as its TALLEST question and every shorter
   * page would sit under dead space. Observing the live page (rather than measuring once
   * per page change) is what keeps the height honest when the page grows underneath us —
   * the "Other" box opening, or the user dragging its resize handle.
   *
   * No feedback loop: the track is `align-items: flex-start`, so a page's own height never
   * depends on the height we write onto the viewport.
   */
  useLayoutEffect(() => {
    const el = pageEls.current[current];
    if (!el) return;
    setViewportH(el.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;    // jsdom / no-RO: height stays auto
    const ro = new ResizeObserver(() => setViewportH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [current, submitted]);

  // Keyboard users must land ON the new question, not keep focus on a Next button that may
  // have just become disabled. `preventScroll` because this card lives in an auto-scrolling
  // transcript — focusing must never yank the conversation.
  useLayoutEffect(() => {
    if (!paged.current) return;
    paged.current = false;
    pageEls.current[current]?.focus({ preventScroll: true });
  }, [current]);

  const go = (next: number) => {
    const target = Math.max(0, Math.min(total - 1, next));
    if (target === current) return;
    paged.current = true;
    setPage(target);
  };

  const submit = () => {
    if (!complete || submitted) return;
    setSubmitted(true);
    session.answerQuestion(item.requestId, questions, resolveAnswers(questions, picks));
  };

  /** ⌘/Ctrl+Enter out of the free-text box: send when nothing is left to answer, otherwise
   *  move to what IS left — the same "I'm done with this page" gesture either way. */
  const commit = () => {
    if (complete) submit();
    else if (nextGap >= 0) go(nextGap);
  };

  // ← / → page the card, but never while the caret is in the free-text box, where those
  // keys are ordinary text navigation.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (total < 2 || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(current + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(current - 1); }
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
    <div className="chat-surveycard" onKeyDown={onKeyDown}>
      <div className="chat-surveycard-head">
        <span className="chat-surveycard-pill"><span aria-hidden>❓</span> Survey</span>
        {total > 1 && (
          <span className="chat-surveycard-progress">{answered} / {total}</span>
        )}
      </div>

      {submitted ? (
        <div className="chat-surveycard-receipt">
          <span className="chat-surveycard-receipt-check" aria-hidden>✓</span>
          <span>You chose: {values.join(', ') || '—'}</span>
        </div>
      ) : (
        <>
          <div
            className="chat-surveycard-viewport"
            style={viewportH != null ? { height: viewportH } : undefined}
          >
            <div className="chat-surveycard-track" style={{ transform: `translateX(-${current * 100}%)` }}>
              {questions.map((q, i) => {
                const pick = pickFor(picks, q.question);
                const otherOn = isOtherChosen(picks, q.question);
                return (
                  <div
                    key={q.question}
                    ref={(el) => { pageEls.current[i] = el; }}
                    className="chat-surveycard-block chat-surveycard-page"
                    tabIndex={-1}
                    // An off-screen page still has real buttons in it. `inert` is what keeps
                    // Tab, the a11y tree and click targets inside the page you can see.
                    inert={i !== current}
                  >
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
                              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commit(); }
                            }}
                          />
                          <span className="chat-surveycard-otherhint">
                            ⌘ / Ctrl + Enter to {complete ? 'submit' : 'continue'}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="chat-surveycard-foot">
            {total > 1 ? (
              <div className="chat-surveycard-pager">
                <button
                  type="button"
                  className="chat-surveycard-arrow"
                  onClick={() => go(current - 1)}
                  disabled={current === 0}
                  aria-label="Previous question"
                >‹</button>
                <div className="chat-surveycard-dots">
                  {questions.map((q, i) => (
                    <button
                      key={q.question}
                      type="button"
                      className={`chat-surveycard-dot${i === current ? ' on' : ''}${isAnswered(q, picks) ? ' done' : ''}`}
                      aria-label={`Question ${i + 1} of ${total}${isAnswered(q, picks) ? ' — answered' : ''}`}
                      aria-current={i === current || undefined}
                      onClick={() => go(i)}
                    >
                      <span className="chat-surveycard-dot-i" aria-hidden />
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="chat-surveycard-arrow"
                  onClick={() => go(current + 1)}
                  disabled={onLastPage}
                  aria-label="Next question"
                >›</button>
              </div>
            ) : (
              <span className="chat-surveycard-count">{values.length} selected</span>
            )}

            <div className="chat-surveycard-actions">
              {/* What's left is only worth a JUMP when it is off screen. When the gap is the
                  page you are looking at, the same text stays as a plain readout — a button
                  that navigates to where you already are is a dead click. */}
              {total > 1 && nextGap >= 0 && (
                nextGap === current ? (
                  <span className="chat-surveycard-count">{total - answered} left</span>
                ) : (
                  <button
                    type="button"
                    className="chat-surveycard-jump"
                    onClick={() => go(nextGap)}
                  >{total - answered} left</button>
                )
              )}
              {complete || onLastPage ? (
                <button type="button" className="chat-btn primary" disabled={!complete} onClick={submit}>
                  Submit <span aria-hidden>→</span>
                </button>
              ) : (
                <button type="button" className="chat-btn primary" onClick={() => go(current + 1)}>
                  Next <span aria-hidden>→</span>
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
