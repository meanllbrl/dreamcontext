import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSession, PendingQuestion } from '../chatSession';
import type { QuestionSpec } from '../../../lib/chatProtocol';
import { HtmlView } from './HtmlView';
import { loneMedia, usePreviewHtml } from './previewImages';
import { MediaEmbed } from './MediaEmbed';
import { Lightbox } from './Lightbox';
import { FullscreenOverlay } from '../../layout/FullscreenOverlay';
import { agentFileUrl } from '../../../api/client';
import { useVault } from '../../../context/VaultContext';
import {
  allValues, answeredCount, choose, firstUnansweredIndex, isAnswered, isBoard, isComplete,
  isSwipeDeck, numberValue, optionLetter, pickFor, resolveAnswers, resolveNotes, setText,
  setValue, textRole, toggleOther, togglePick, unclearMessage, type SurveyPicks,
} from './surveyAnswers';

/**
 * AskUserQuestion, state 5 — a card built to be answered COLD.
 *
 * The owner runs several sessions at once and reaches a question from a notification, not
 * from reading the turn that led to it (report 2026-09-26: "soruyu tam olarak anlayamıyor").
 * So the card leads with CONTEXT before the question: the call's `title` as a strip ("what
 * we were doing"), then the question, then its `description` ("why I am asking"). Both
 * fields exist only because the chat spawn switches the CLI's extended questions on
 * (`CHAT_QUESTION_ENV` in `agent-chat.ts`); the briefing tells the agent to always fill them.
 *
 * WHAT A QUESTION LOOKS LIKE follows what it asks:
 *   • options as rows — the default;
 *   • options with a `preview` — an A/B/C BOARD of tiles, each drawing its preview in the
 *     `dream-html` sandbox (project pictures inlined by `previewImages.ts`), each with a
 *     fullscreen door, because "this one or that one" is answered by LOOKING;
 *   • `metadata.source: "swipe"` over two-way questions — a SWIPE DECK: drag right for the
 *     first option, left for the second, ←/→ or the two buttons for the same thing;
 *   • `kind: "text"` — a text box; `kind: "number"` — a slider with its value.
 *
 * ONE FREE-TEXT FIELD, ALWAYS VISIBLE, under every choice: a note on the pick, or — with
 * nothing picked, or "Other" picked — the answer itself (see `surveyAnswers.ts`). The old
 * "Other" row GREW a textarea on click; the card sits at the foot of a transcript that
 * follows the bottom, so that growth shoved the question up and away mid-answer. The row is
 * back, but picking it only re-labels and focuses the field that is already there. Nothing
 * on this card changes height because of a click — only because of typing.
 *
 * Every preview has a FULLSCREEN door — an HTML one through `HtmlView`, a picture through the
 * shared `Lightbox`, a clip through a full-window player. Those overlays are PORTALED, and
 * React bubbles a portal's events through the component tree, so every handler here that
 * votes, drags or pages first checks the event came from its own DOM.
 *
 * MULTI-QUESTION CARDS PAGE HORIZONTALLY, one question per page (owner call, 2026-07-26):
 * stacking made a two-question card taller than the pane. The dots and the `n left` jump
 * carry "how much is left" instead of scroll distance.
 *
 * "UNCLEAR — ASK AGAIN" answers the call with a deny whose message tells the agent how to
 * re-ask (see `unclearMessage`): a card nobody can parse should cost one click, not a guess.
 *
 * The receipt after Submit is local and brief: `ChatSession` removes the answered item from
 * `pending` optimistically, so the card unmounts on the next tick.
 */

/** What the card needs from its host: an answer, and a way to decline. A chat session is one;
 *  the #agents channel mounts the same card over an automation's question with an adapter
 *  (`AgentQuestionBlock`), so an agent asks exactly the way Chat asks. */
export type SurveyHost = Pick<ChatSession, 'answer' | 'answerQuestion'>;

export function SurveyCard({ item, session }: { item: PendingQuestion; session: SurveyHost }) {
  const [picks, setPicks] = useState<SurveyPicks>({});
  const [submitted, setSubmitted] = useState<null | 'answered' | 'unclear'>(null);
  const [page, setPage] = useState(0);

  const questions = item.questions;
  const total = questions.length;
  const swipe = isSwipeDeck(questions, item.source);
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
   * page would sit under dead space. Observing the live page keeps the height honest when
   * the page grows underneath us — a preview frame reporting its height, or a note wrapping
   * onto a second line.
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
    setSubmitted('answered');
    session.answerQuestion(item.requestId, questions, resolveAnswers(questions, picks), resolveNotes(questions, picks));
  };

  const unclear = () => {
    if (submitted) return;
    setSubmitted('unclear');
    session.answer(item.requestId, { behavior: 'deny', message: unclearMessage(questions, picks) });
  };

  /** ⌘/Ctrl+Enter out of a text field: send when nothing is left to answer, otherwise move
   *  to what IS left — the same "I'm done with this page" gesture either way. */
  const commit = () => {
    if (complete) submit();
    else if (nextGap >= 0) go(nextGap);
  };

  // The swipe decides AFTER its throw animation, from a timer — read the latest picks, not
  // the ones this render closed over (a note typed mid-throw must not be dropped).
  const picksRef = useRef(picks);
  picksRef.current = picks;

  /** "Other" re-labels the field under it and puts the caret there — typing is the point. */
  const pickOther = (q: QuestionSpec) => {
    const turningOn = !pickFor(picksRef.current, q.question).other;
    setPicks((prev) => toggleOther(prev, q));
    if (turningOn) {
      const page = pageEls.current[questions.indexOf(q)];
      requestAnimationFrame(() => page?.querySelector<HTMLTextAreaElement>('.chat-surveycard-fieldinput')?.focus({ preventScroll: true }));
    }
  };

  /** A swipe decides the question and moves on to whatever is still open. */
  const decide = (q: QuestionSpec, label: string) => {
    const next = choose(picksRef.current, q, label);
    setPicks(next);
    const gap = firstUnansweredIndex(questions, next);
    if (gap >= 0) go(gap);
  };

  // Keys never fire while the caret is in a text field, where they are ordinary typing.
  //   ← / →  — page the card, or in the swipe deck: pick the second / first option;
  //   1-4    — pick that option on the page you are looking at.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!ownEvent(e)) return;   // a key pressed inside an open fullscreen preview
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    const q = questions[current];
    if (swipe && q && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      decide(q, q.options[e.key === 'ArrowRight' ? 0 : 1].label);
      return;
    }
    if (total > 1 && e.key === 'ArrowRight') { e.preventDefault(); go(current + 1); return; }
    if (total > 1 && e.key === 'ArrowLeft') { e.preventDefault(); go(current - 1); return; }
    const n = Number(e.key);
    if (!q || (q.kind ?? 'choice') !== 'choice' || !Number.isInteger(n) || n < 1) return;
    if (n <= q.options.length) {
      e.preventDefault();
      setPicks((prev) => togglePick(prev, q, q.options[n - 1].label));
    } else if (n === q.options.length + 1 && !swipe) {
      e.preventDefault();
      pickOther(q);
    }
  };

  if (submitted) {
    return (
      <div className="chat-surveycard" data-state="submitted">
        {item.title && <div className="chat-surveycard-context"><span className="chat-surveycard-context-label">Context</span>{item.title}</div>}
        <div className="chat-surveycard-receipt">
          <span className="chat-surveycard-receipt-check" aria-hidden>{submitted === 'unclear' ? '↺' : '✓'}</span>
          <span>{submitted === 'unclear'
            ? 'Asked Claude to ask again, more clearly.'
            : `You chose: ${values.join(', ') || '—'}`}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`chat-surveycard${swipe ? ' swipe' : ''}`} onKeyDown={onKeyDown}>
      <div className="chat-surveycard-head">
        <span className="chat-surveycard-pill"><span aria-hidden>❓</span> {swipe ? 'Swipe' : 'Question'}</span>
        {total > 1 && (
          <span className="chat-surveycard-progress">{answered} / {total}</span>
        )}
      </div>

      {item.title && (
        <div className="chat-surveycard-context">
          <span className="chat-surveycard-context-label">Context</span>
          {item.title}
        </div>
      )}

      <div
        className="chat-surveycard-viewport"
        style={viewportH != null ? { height: viewportH } : undefined}
      >
        <div className="chat-surveycard-track" style={{ transform: `translateX(-${current * 100}%)` }}>
          {questions.map((q, i) => (
            <div
              key={q.question}
              ref={(el) => { pageEls.current[i] = el; }}
              className="chat-surveycard-block chat-surveycard-page"
              tabIndex={-1}
              // An off-screen page still has real controls in it. `inert` is what keeps
              // Tab, the a11y tree and click targets inside the page you can see.
              inert={i !== current}
            >
              {q.header && <span className="chat-surveycard-helper">{q.header}</span>}
              <p className="chat-surveycard-title">{q.question}</p>
              {q.description && <p className="chat-surveycard-desc">{q.description}</p>}
              <QuestionBody
                q={q}
                picks={picks}
                swipe={swipe}
                onPicks={setPicks}
                onDecide={(label) => decide(q, label)}
                onOther={() => pickOther(q)}
                onCommit={commit}
                complete={complete}
              />
            </div>
          ))}
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
          <button type="button" className="chat-surveycard-unclear" onClick={unclear}>
            Unclear? Ask again
          </button>
        )}

        <div className="chat-surveycard-actions">
          {total > 1 && (
            <button type="button" className="chat-surveycard-unclear" onClick={unclear}>
              Unclear? Ask again
            </button>
          )}
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
          {complete || onLastPage || swipe ? (
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
    </div>
  );
}

// ─── One question's answering surface ───────────────────────────────────────────────

/** True when a React event started in this element's own DOM — not in a portaled overlay
 *  (a fullscreen preview) that React bubbles through the component tree anyway. */
function ownEvent(e: React.SyntheticEvent<HTMLElement>): boolean {
  return e.currentTarget.contains(e.target as Node);
}

function QuestionBody({ q, picks, swipe, onPicks, onDecide, onOther, onCommit, complete }: {
  q: QuestionSpec;
  picks: SurveyPicks;
  swipe: boolean;
  onPicks: (update: (prev: SurveyPicks) => SurveyPicks) => void;
  onDecide: (label: string) => void;
  onOther: () => void;
  onCommit: () => void;
  complete: boolean;
}) {
  const kind = q.kind ?? 'choice';
  const pick = pickFor(picks, q.question);

  if (kind === 'number') {
    const value = numberValue(q, picks);
    const min = q.min ?? 0;
    const max = q.max ?? Math.max(min + 10, value);
    return (
      <div className="chat-surveycard-number">
        <input
          type="range"
          className="chat-surveycard-range"
          min={min}
          max={max}
          step={q.step ?? 1}
          value={value}
          aria-label={q.question}
          onChange={(e) => onPicks((prev) => setValue(prev, q, Number(e.target.value)))}
        />
        <span className="chat-surveycard-numvalue">
          {value}{q.unit ? <span className="chat-surveycard-unit"> {q.unit}</span> : null}
        </span>
      </div>
    );
  }

  const field = (
    <FreeField
      q={q}
      value={pick.text}
      role={kind === 'text' ? 'answer' : textRole(q, picks)}
      other={!!pick.other}
      pickedLabel={pick.chosen.join(', ')}
      onChange={(text) => onPicks((prev) => setText(prev, q, text))}
      onCommit={onCommit}
      complete={complete}
    />
  );

  if (kind === 'text') return field;

  if (swipe) {
    return (
      <>
        <SwipeFace q={q} chosen={pick.chosen[0]} onDecide={onDecide} />
        {field}
      </>
    );
  }

  if (isBoard(q)) {
    return (
      <>
        <div className="chat-surveycard-board" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
          {q.options.map((o, i) => (
            <BoardTile
              key={o.label}
              letter={optionLetter(i)}
              label={o.label}
              description={o.description}
              preview={o.preview}
              multi={!!q.multiSelect}
              on={pick.chosen.includes(o.label)}
              onToggle={() => onPicks((prev) => togglePick(prev, q, o.label))}
            />
          ))}
        </div>
        <OtherRow q={q} on={!!pick.other} keyHint={q.options.length + 1} onToggle={onOther} />
        {field}
      </>
    );
  }

  return (
    <>
      <div className="chat-surveycard-options">
        {q.options.map((o, i) => {
          const on = pick.chosen.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              className={`chat-surveycard-opt${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onPicks((prev) => togglePick(prev, q, o.label))}
            >
              <span className={`chat-surveycard-opt-mark${q.multiSelect ? ' box' : ' radio'}`} aria-hidden>
                {on ? (q.multiSelect ? '✓' : '●') : ''}
              </span>
              <span className="chat-surveycard-opt-body">
                <span className="chat-surveycard-opt-title">{o.label}</span>
                {o.description && <span className="chat-surveycard-opt-desc">{o.description}</span>}
              </span>
              <span className="chat-surveycard-opt-key" aria-hidden>{i + 1}</span>
            </button>
          );
        })}
        <OtherRow q={q} on={!!pick.other} keyHint={q.options.length + 1} onToggle={onOther} />
      </div>
      {field}
    </>
  );
}

/** The "Other" row: same shape as an option, so picking it changes no height. */
function OtherRow({ q, on, keyHint, onToggle }: {
  q: QuestionSpec;
  on: boolean;
  keyHint: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`chat-surveycard-opt other${on ? ' on' : ''}`}
      aria-pressed={on}
      onClick={onToggle}
    >
      <span className={`chat-surveycard-opt-mark${q.multiSelect ? ' box' : ' radio'}`} aria-hidden>
        {on ? (q.multiSelect ? '✓' : '●') : ''}
      </span>
      <span className="chat-surveycard-opt-body">
        <span className="chat-surveycard-opt-title">Other</span>
        <span className="chat-surveycard-opt-desc">Write your own answer below</span>
      </span>
      <span className="chat-surveycard-opt-key" aria-hidden>{keyHint}</span>
    </button>
  );
}

/**
 * The always-on text field. Its placeholder says what the text will MEAN — a note on the
 * pick, or the answer itself — so the one field never reads as ambiguous. It grows only as
 * the user types past a line; a click never resizes it.
 */
function FreeField({ q, value, role, other, pickedLabel, onChange, onCommit, complete }: {
  q: QuestionSpec;
  value: string;
  role: 'note' | 'answer';
  other: boolean;
  pickedLabel: string;
  onChange: (text: string) => void;
  onCommit: () => void;
  complete: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Auto-grow to the content, from one line. Measured in a layout effect so the new height
  // lands in the same frame as the keystroke that needed it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const placeholder = role === 'note'
    ? `Add a note to “${pickedLabel}” (optional)`
    : (q.kind === 'text'
      ? (q.placeholder ?? 'Type your answer…')
      : other
        ? (q.multiSelect && pickedLabel ? `Your own answer, next to “${pickedLabel}”…` : 'Write your own answer…')
        : 'None of these? Write your own answer…');

  return (
    <div className={`chat-surveycard-field${role === 'note' ? ' note' : ''}`}>
      <span className="chat-surveycard-field-tag" aria-hidden>{role === 'note' ? 'Note' : 'Answer'}</span>
      <textarea
        ref={ref}
        className="chat-surveycard-fieldinput"
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={role === 'note' ? `Note on your answer — ${q.question}` : `Your own answer — ${q.question}`}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onCommit(); }
        }}
      />
      {value.trim() && (
        <span className="chat-surveycard-fieldhint">⌘ / Ctrl + Enter to {complete ? 'submit' : 'continue'}</span>
      )}
    </div>
  );
}

// ─── The A/B/C board ────────────────────────────────────────────────────────────────

/**
 * One option's preview: a lone project picture or clip drawn natively (a clip plays in
 * place — the sandbox has no way to), anything else in the `dream-html` sandbox with its
 * project pictures inlined.
 */
function PreviewSurface({ preview }: { preview: string | undefined }) {
  const { vault } = useVault();
  const media = loneMedia(preview);
  const html = usePreviewHtml(preview);
  if (media) return <MediaPreview kind={media.kind} path={media.src} src={agentFileUrl(vault, media.src, { raw: true })} />;
  return html
    ? <HtmlView html={html} />
    : <span className="chat-surveycard-tile-empty">No preview</span>;
}

/**
 * A lone picture or clip, with the same fullscreen door an HTML preview has. It wears
 * `chat-htmlview-full-btn` on purpose: the tile and the swipe face already exempt that class
 * from voting and dragging, and its look is the one the reader learned on the HTML tiles.
 */
function MediaPreview({ kind, path, src }: { kind: 'image' | 'video'; path: string; src: string }) {
  const [full, setFull] = useState(false);
  return (
    <div className="chat-surveycard-mediabox">
      {kind === 'video'
        ? <MediaEmbed kind="video" src={src} className="chat-surveycard-media" />
        : <img className="chat-surveycard-media" src={src} alt="" draggable={false} />}
      <button
        type="button"
        className="chat-htmlview-full-btn"
        onClick={() => setFull(true)}
        aria-label="Open full screen"
        title="Open full screen"
      >
        <span aria-hidden>⛶</span>
      </button>
      {full && (kind === 'video'
        ? <VideoFullscreen src={src} path={path} onClose={() => setFull(false)} />
        : <Lightbox src={src} path={path} caption={path.split('/').pop()} onClose={() => setFull(false)} />)}
    </div>
  );
}

/** A clip filling the window. Portaled for the reason `HtmlFullscreen` is: the chat surface's
 *  `contain: layout paint` would otherwise clip a fixed overlay to the pane. */
function VideoFullscreen({ src, path, onClose }: { src: string; path: string; onClose: () => void }) {
  return createPortal(
    <FullscreenOverlay label={path.split('/').pop() ?? 'Video'} onClose={onClose}>
      <div className="chat-surveycard-videofull">
        <MediaEmbed kind="video" src={src} className="chat-surveycard-videofull-media" />
      </div>
    </FullscreenOverlay>,
    document.body,
  );
}

function BoardTile({ letter, label, description, preview, multi, on, onToggle }: {
  letter: string;
  label: string;
  description?: string;
  preview?: string;
  multi: boolean;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`chat-surveycard-tile${on ? ' on' : ''}`}
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={on}
      aria-label={`${letter}: ${label}`}
      tabIndex={0}
      onClick={(e) => {
        // The preview's own fullscreen door is a button INSIDE the tile, and a clip has its
        // own controls — looking closer, or pressing play, is not a vote for this option.
        // Nor is anything clicked in the fullscreen overlay that door opened.
        if (!ownEvent(e)) return;
        if ((e.target as HTMLElement).closest('.chat-htmlview-full-btn, video')) return;
        onToggle();
      }}
      onKeyDown={(e) => {
        // Only a key on the tile itself votes: Enter on its fullscreen door opens the door.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggle(); }
      }}
    >
      <div className="chat-surveycard-tile-preview">
        <PreviewSurface preview={preview} />
      </div>
      <div className="chat-surveycard-tile-foot">
        <span className="chat-surveycard-tile-letter" aria-hidden>{on ? '✓' : letter}</span>
        <span className="chat-surveycard-opt-body">
          <span className="chat-surveycard-opt-title">{label}</span>
          {description && <span className="chat-surveycard-opt-desc">{description}</span>}
        </span>
      </div>
    </div>
  );
}

// ─── The swipe deck ─────────────────────────────────────────────────────────────────

/** How far (px) a drag must travel to count as a decision rather than a wobble. */
const SWIPE_DECIDE_PX = 90;

/**
 * One two-way question as a card you throw. Right = the FIRST option, left = the second —
 * the briefing tells the agent to put the "yes / keep" option first. The face shows the
 * first preview on offer (the thing being judged); without one it shows the question's two
 * outcomes, so the gesture is never a guess.
 */
function SwipeFace({ q, chosen, onDecide }: {
  q: QuestionSpec;
  chosen: string | undefined;
  onDecide: (label: string) => void;
}) {
  const [yes, no] = q.options;
  const preview = q.options.find((o) => o.preview)?.preview;
  const [dx, setDx] = useState(0);
  const [flying, setFlying] = useState<0 | 1 | -1>(0);
  const drag = useRef<{ x: number; id: number } | null>(null);

  const throwTo = (dir: 1 | -1) => {
    setFlying(dir);
    // Long enough to read as a throw; the decision itself is not delayed by the animation
    // longer than that. Reduced motion skips the flight in CSS, not here.
    window.setTimeout(() => {
      setFlying(0);
      setDx(0);
      onDecide(dir === 1 ? yes.label : no.label);
    }, 220);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ownEvent(e)) return;
    if ((e.target as HTMLElement).closest('.chat-htmlview-full-btn, video')) return;
    drag.current = { x: e.clientX, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    setDx(e.clientX - drag.current.x);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    if (dx > SWIPE_DECIDE_PX) throwTo(1);
    else if (dx < -SWIPE_DECIDE_PX) throwTo(-1);
    else setDx(0);
  };

  const offset = flying ? flying * 480 : dx;
  const lean = Math.max(-1, Math.min(1, offset / SWIPE_DECIDE_PX));
  const settled = chosen === yes.label ? 1 : chosen === no.label ? -1 : 0;

  return (
    <div className="chat-swipe">
      <div
        className={`chat-swipe-face${drag.current ? ' dragging' : ''}${flying ? ' flying' : ''}${settled === 1 ? ' yes' : settled === -1 ? ' no' : ''}`}
        style={{ transform: `translateX(${offset}px) rotate(${offset / 24}deg)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="chat-swipe-stamp yes" style={{ opacity: Math.max(0, lean) }} aria-hidden>{yes.label}</span>
        <span className="chat-swipe-stamp no" style={{ opacity: Math.max(0, -lean) }} aria-hidden>{no.label}</span>
        {preview ? (
          <div className="chat-swipe-preview"><PreviewSurface preview={preview} /></div>
        ) : (
          <div className="chat-swipe-outcomes">
            <span><b>→</b> {yes.label}{yes.description ? ` — ${yes.description}` : ''}</span>
            <span><b>←</b> {no.label}{no.description ? ` — ${no.description}` : ''}</span>
          </div>
        )}
      </div>
      <div className="chat-swipe-buttons">
        <button
          type="button"
          className={`chat-swipe-btn no${settled === -1 ? ' on' : ''}`}
          aria-pressed={settled === -1}
          onClick={() => throwTo(-1)}
        ><span aria-hidden>←</span> {no.label}</button>
        <span className="chat-swipe-hint">drag or ← →</span>
        <button
          type="button"
          className={`chat-swipe-btn yes${settled === 1 ? ' on' : ''}`}
          aria-pressed={settled === 1}
          onClick={() => throwTo(1)}
        >{yes.label} <span aria-hidden>→</span></button>
      </div>
    </div>
  );
}
