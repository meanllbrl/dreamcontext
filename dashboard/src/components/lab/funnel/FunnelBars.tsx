import { KN_THRESHOLD, stepDrops } from '../../../generated/frameOps';
import { fmtCount, fmtPercent } from '../explorer/explorerFormat';
import './FunnelBars.css';

/**
 * Compact funnel fallback — the v0-style vertical bar list. Used for legacy
 * `Series[]` payloads under `render: funnel` (no funnel-set in the cache) and
 * as the narrow-width fallback below the lane breakpoint, and the board
 * `funnel` block's body (`fill`, `stepLabel`). Pure display.
 *
 * The percent beside each count is ALWAYS the share of the first step, unlabelled,
 * as it has always been. The step-to-step conversion is a different number, so it
 * only appears as its own labelled marker (arrow + the caller's localized
 * `stepLabel`, e.g. "50% of prev. step"); the two can never be read for each other.
 * A narrow block writes the marker short (`stepMode: 'short'`: the arrow and the
 * percent, the label in its tooltip); the row's tooltip always has the whole line.
 */
export type FunnelStepMode = 'full' | 'short';

/**
 * The honesty words a bar list needs on an explorer funnel, from the caller (the bars stay
 * free of the i18n context, so the funnel pages draw them as before). Absent = none of these
 * marks: a derived step draws no badge and an unmeasured step reads "not measured".
 */
export interface FunnelStepCopy {
  /** The derived badge's word ("derived" / "türetilmiş") and its explanation. */
  derived: string;
  derivedTitle: string;
  /** "Not measured: {reason}" for a step the source does not count. */
  notMeasured: (reason: string | null) => string;
  /** The title of a step-to-step figure shown as counts (its previous step is under KN_THRESHOLD). */
  knTitle: (k: number, n: number) => string;
  /** The reader's language: explorer figures follow its number format (TR "659.569 · %21,8"). */
  locale: string;
}

/** A step as the bars read it: the funnel-set step with its basis and not-measured mark. */
export interface FunnelBarStep {
  key: string;
  label: string;
  users: number;
  basis?: 'measured' | 'derived';
  measured?: boolean;
  reason?: string | null;
}

/** The worst row's tint (the flow's worst-link wash): a wash on the row, the bar in the error tone. */
const WORST_ROW = { background: 'color-mix(in srgb, var(--color-error) 10%, transparent)', borderRadius: 'var(--radius-sm)' } as const;
const WORST_FILL = { background: 'var(--color-error)' } as const;

export function FunnelBars({ steps, dense = false, fill = false, stepLabel = null, stepMode = 'full', valueWidth, worstKey = null, copy = null }: {
  steps: readonly FunnelBarStep[];
  dense?: boolean;
  /** Rows share the parent's height (board block): they shrink to fit, never scroll. */
  fill?: boolean;
  /** Draws the labelled step-to-step conversion beside each step after the first; the
   *  argument is the formatted percent ("50%"). Absent = none (the funnel pages). */
  stepLabel?: ((pct: string) => string) | null;
  /** How the marker is written: the labelled sentence, or the arrow and percent alone. */
  stepMode?: FunnelStepMode;
  /** One value column for every row (px, measured by the block), so the tracks end together. */
  valueWidth?: number;
  /** The step whose drop is the worst (stepDrops): its row is marked `data-lab-worst` and tinted. Absent = none. */
  worstKey?: string | null;
  /** The explorer's honesty words (derived badge, not measured, k/n). */
  copy?: FunnelStepCopy | null;
}) {
  // stepDrops, not a plain ratio: an unmeasured step gets no rate and the next one compares with
  // the last MEASURED step, so a dead event never draws a 100% drop and a rise from 0.
  const rows = stepDrops(steps);
  if (rows.length === 0) {
    return <div className="funnel-bars-empty">No steps.</div>;
  }
  const max = Math.max(1, ...rows.filter((r) => r.measured).map((r) => r.users));
  const reasonOf = (key: string) => steps.find((s) => s.key === key)?.reason ?? null;
  // Explorer bars read in the card's language; the funnel pages keep their original English figures.
  const pctText = (v: number) => (copy ? fmtPercent(v, copy.locale, v >= 10 ? 0 : 1) : `${v.toFixed(v >= 10 ? 0 : 1)}%`);
  const countText = (v: number) => (copy ? fmtCount(v, copy.locale) : v.toLocaleString('en-US'));
  const topText = (v: number) => (copy ? fmtPercent(v, copy.locale, 1) : `${v.toFixed(v >= 10 ? 0 : 1)}%`);
  return (
    <div
      className={`funnel-bars${dense ? ' funnel-bars--dense' : ''}${fill ? ' funnel-bars--fill' : ''}`}
      style={fill ? { gridTemplateRows: `repeat(${rows.length}, minmax(0, var(--space-8)))` } : undefined}
    >
      {rows.map((row) => {
        const worst = worstKey !== null && row.key === worstKey;
        const columns = valueWidth ? { gridTemplateColumns: `minmax(72px, 32%) 1fr ${valueWidth}px` } : null;
        const derived = copy && row.basis === 'derived' ? (
          <span className="funnel-bars-derived" data-lab-derived="" title={copy.derivedTitle}>{copy.derived}</span>
        ) : null;
        if (!row.measured) {
          const text = copy ? copy.notMeasured(reasonOf(row.key)) : 'Not measured';
          return (
            <div
              key={row.key}
              className="funnel-bars-row funnel-bars-row--unmeasured"
              data-measured="false"
              style={columns ?? undefined}
              title={`${row.label}: ${text}`}
            >
              <span className="funnel-bars-label">{row.label}{derived}</span>
              <span className="funnel-bars-track" aria-hidden="true" />
              <span className="funnel-bars-value funnel-bars-unmeasured" data-lab-not-measured={row.key}>{text}</span>
            </div>
          );
        }
        // The step-to-step figure as counts when its denominator is small: "k/n", never a rate.
        // Only on explorer bars (`copy`): the funnel pages keep their percentages as they always were.
        const smallPrev = copy !== null && row.prevUsers !== null && row.prevUsers > 0 && row.prevUsers < KN_THRESHOLD;
        const stepText = (pct: string) => (smallPrev ? `${countText(row.users)}/${countText(row.prevUsers as number)}` : pct);
        return (
          <div
            key={row.key}
            className="funnel-bars-row"
            data-lab-worst={worst ? row.key : undefined}
            style={columns || worst ? { ...columns, ...(worst ? WORST_ROW : null) } : undefined}
            title={copy
              ? `${row.label}: ${countText(row.users)}${row.ofTop !== null ? ` · ${topText(row.ofTop)}` : ''}${stepLabel && row.ofPrev !== null ? ` · ${stepLabel(stepText(pctText(row.ofPrev)))}` : ''}`
              : `${row.label}: ${row.users.toLocaleString('en-US')} users${row.ofTop !== null ? ` · ${row.ofTop.toFixed(1)}% of top` : ''}${stepLabel && row.ofPrev !== null ? ` · ${stepLabel(pctText(row.ofPrev))}` : ''}`}
          >
            <span className="funnel-bars-label">{row.label}{derived}</span>
            <span className="funnel-bars-track">
              <span className="funnel-bars-fill" style={{ width: `${(row.users / max) * 100}%`, ...(worst ? WORST_FILL : null) }} />
            </span>
            <span className="funnel-bars-value">
              {countText(row.users)}
              {row.ofTop !== null && <span className="funnel-bars-pct"> · {topText(row.ofTop)}</span>}
              {stepLabel && row.ofPrev !== null && (
                <span
                  className="funnel-bars-step"
                  data-step-pct={row.ofPrev.toFixed(1)}
                  data-lab-kn={smallPrev ? `${row.users}/${row.prevUsers}` : undefined}
                  title={smallPrev && copy
                    ? copy.knTitle(row.users, row.prevUsers as number)
                    : stepMode === 'short' ? stepLabel(pctText(row.ofPrev)) : undefined}
                >
                  <svg className="funnel-bars-step-icon" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
                    <path d="M2 1v4.5h5.5M5.5 3.5l2 2-2 2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {stepMode === 'short' ? stepText(pctText(row.ofPrev)) : stepLabel(stepText(pctText(row.ofPrev)))}
                </span>
              )}
              {/* The first step has no previous one: an invisible marker keeps its track as wide as the rest. */}
              {stepLabel && row.ofPrev === null && (
                <span className="funnel-bars-step funnel-bars-step--spacer" aria-hidden="true">
                  <svg className="funnel-bars-step-icon" viewBox="0 0 10 10" width="10" height="10" focusable="false" />
                  {stepMode === 'short' ? '100%' : stepLabel('100%')}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
