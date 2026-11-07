import { memo, useEffect, useState } from 'react';
import { summarizeToolRun } from '../chat/chatEntities';
import { ToolCard } from '../chat/ToolCard';
import { BrowserSlot } from '../chat/browserHost';
import { liveLabel, stepFailed, stepPhrase, stepsDuration, turnClock } from './superSteps';
import { useI18n } from '../../../context/I18nContext';
import { pollMs } from '../../../lib/windowActivity';
import type { ChatToolItem } from '../chatSession';

/**
 * The Super Agent's tool steps as ONE quiet line (owner 2026-11-06, draft option A).
 *
 * In the Super view a turn's steps are mostly `dreamcontext` calls, and those break the plain
 * Chat's grouping on purpose, so a routine turn stacked seven cards above a two-line answer.
 * Here the whole stretch is one fixed-height line instead: while it runs, a small ring and the
 * step in hand in plain words; once it lands, a grey chip ("7 steps · 61 s") that opens the
 * same rows the plain Chat draws, and closes them again.
 *
 * Two things never hide inside it: a step that failed is drawn in full UNDER the line (and
 * counted on the chip), and a permission the owner has to answer stays its own card below the
 * transcript; the line only says it is waiting. The line's height never changes while it runs.
 *
 * Once the answer is written the line goes away entirely (owner 2026-11-06, second look): only
 * the answer stays, and a faint "steps" link on its hover opens the rows here (`hidden`).
 *
 * While it runs the line also carries the turn's elapsed time at its end, and in the gap between
 * steps it reads "Thinking" (owner 2026-11-07): the separate "Working… 28s" pill that used to pop
 * in under it, and make the chat jump a row each time, is not drawn in the Super view.
 */

/** Seconds since `startedAt` (or since mount, when the turn was already running on attach). */
function useTurnClock(startedAt: number | undefined, live: boolean): number {
  const [base] = useState(() => startedAt ?? Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, pollMs(1000));
    return () => clearInterval(timer);
  }, [live]);
  return Math.max(0, now - (startedAt ?? base));
}

/**
 * The live line with no steps under it yet: the start of a turn, or the thinking after an answer
 * piece. The same 24px shape as a live `SuperStepsLine`, so when the first step arrives the one
 * line simply changes its words, and the chat does not move.
 */
function SuperLiveLineInner({ label, startedAt }: { label?: string; startedAt?: number }) {
  const { t } = useI18n();
  const elapsed = useTurnClock(startedAt, true);
  const text = label ?? t('super.steps.thinking');
  return (
    <div className="super-steps" data-testid="super-live-line" data-live role="status" aria-live="polite" aria-label={text}>
      <span className="super-steps-line super-steps-line--static">
        <span className="super-steps-ring" aria-hidden />
        <span className="super-steps-now">{text}</span>
        <span className="super-steps-time" aria-hidden>· {turnClock(elapsed, t)}</span>
      </span>
    </div>
  );
}

export const SuperLiveLine = memo(SuperLiveLineInner);

function SuperStepsLineInner({
  items, stillAccruing, waiting = false, onOpenFile, replyGroup, hidden = false, startedAt,
}: {
  /** When the turn began (`conv.turnStartedAt`): the live line's clock counts from here. */
  startedAt?: number;
  /** Landed and put away behind its answer (ChatPane decides): nothing of the line shows, only a
   *  failed step's own row. There is no way back to the rows (owner 2026-11-08). */
  hidden?: boolean;
  items: ChatToolItem[];
  /** The tail of a turn that has not spoken yet (see `toolRunPhase`). */
  stillAccruing: boolean;
  /** A permission card for this turn is waiting on the owner. */
  waiting?: boolean;
  onOpenFile: (path: string) => void;
  replyGroup?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const live = stillAccruing || items.some((i) => i.status === 'running');
  const steps = items.filter((i) => !stepPhrase(i).quiet);
  const failed = items.filter(stepFailed);
  const summary = summarizeToolRun(items);
  // Only the turn's own tail counts: a landed run with an orphaned "running" step never ticks.
  const elapsed = useTurnClock(startedAt, stillAccruing && !hidden);

  const count = t(steps.length === 1 ? 'super.steps.one' : 'super.steps.many').replace('{n}', String(steps.length));
  const parts = [count];
  if (!live && summary.durationMs != null) parts.push(stepsDuration(summary.durationMs, t));
  const label = live ? liveLabel(items, waiting, t) : parts.join(' · ');

  if (hidden) {
    if (!failed.length) return null;
    return (
      <div className="super-steps" data-testid="super-steps" data-hidden>
        <div className="super-steps-errors" data-testid="super-steps-errors">
          {failed.map((item) => <ToolCard key={item.id} item={item} onOpenFile={onOpenFile} actor="lead" />)}
        </div>
      </div>
    );
  }

  return (
    <div
      className="super-steps"
      data-testid="super-steps"
      data-live={live || undefined}
      data-open={open || undefined}
      data-waiting={(live && waiting) || undefined}
      data-reply-grp={replyGroup}
    >
      <button
        type="button"
        className="super-steps-line"
        aria-expanded={open}
        aria-label={live ? `${label} · ${count}` : `${label}${failed.length ? ` · ${t(failed.length === 1 ? 'super.steps.failedOne' : 'super.steps.failedMany').replace('{n}', String(failed.length))}` : ''}`}
        onClick={() => setOpen((o) => !o)}
        data-testid="super-steps-line"
      >
        {live ? (
          <>
            <span className="super-steps-ring" aria-hidden />
            <span className="super-steps-now">{label}</span>
            <span className="super-steps-count">· {steps.length}</span>
            {stillAccruing && <span className="super-steps-time" aria-hidden>· {turnClock(elapsed, t)}</span>}
          </>
        ) : (
          <>
            <span className="super-steps-pill-text">{label}</span>
            {failed.length > 0 && (
              <span className="super-steps-failed">
                · {t(failed.length === 1 ? 'super.steps.failedOne' : 'super.steps.failedMany').replace('{n}', String(failed.length))}
              </span>
            )}
          </>
        )}
        <span className="super-steps-caret" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {/* A failed step's own row (below) draws its browser; the line draws the rest. */}
      {!open && <BrowserSlot ids={items.filter((i) => !stepFailed(i)).map((i) => i.id)} />}
      {open ? (
        <div className="super-steps-rows" data-testid="super-steps-rows">
          {items.map((item) => <ToolCard key={item.id} item={item} onOpenFile={onOpenFile} actor="lead" stretch="follow" />)}
        </div>
      ) : failed.length > 0 && (
        // A failed step never hides in the line: it stands under it, in full, with its own red row.
        <div className="super-steps-errors" data-testid="super-steps-errors">
          {failed.map((item) => <ToolCard key={item.id} item={item} onOpenFile={onOpenFile} actor="lead" />)}
        </div>
      )}
    </div>
  );
}

export const SuperStepsLine = memo(SuperStepsLineInner);
