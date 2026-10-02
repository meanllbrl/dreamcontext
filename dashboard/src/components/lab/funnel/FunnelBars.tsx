import { computeStepRows } from './funnelModel';
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

/** The worst row's tint (the flow's worst-link wash): a wash on the row, the bar in the error tone. */
const WORST_ROW = { background: 'color-mix(in srgb, var(--color-error) 10%, transparent)', borderRadius: 'var(--radius-sm)' } as const;
const WORST_FILL = { background: 'var(--color-error)' } as const;

export function FunnelBars({ steps, dense = false, fill = false, stepLabel = null, stepMode = 'full', valueWidth, worstKey = null }: {
  steps: { key: string; label: string; users: number }[];
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
}) {
  const rows = computeStepRows(steps);
  if (rows.length === 0) {
    return <div className="funnel-bars-empty">No steps.</div>;
  }
  const max = Math.max(1, ...rows.map((r) => r.users));
  const pctText = (v: number) => `${v.toFixed(v >= 10 ? 0 : 1)}%`;
  return (
    <div
      className={`funnel-bars${dense ? ' funnel-bars--dense' : ''}${fill ? ' funnel-bars--fill' : ''}`}
      style={fill ? { gridTemplateRows: `repeat(${rows.length}, minmax(0, var(--space-8)))` } : undefined}
    >
      {rows.map((row) => {
        const worst = worstKey !== null && row.key === worstKey;
        const columns = valueWidth ? { gridTemplateColumns: `minmax(72px, 32%) 1fr ${valueWidth}px` } : null;
        return (
          <div
            key={row.key}
            className="funnel-bars-row"
            data-lab-worst={worst ? row.key : undefined}
            style={columns || worst ? { ...columns, ...(worst ? WORST_ROW : null) } : undefined}
            title={`${row.label}: ${row.users.toLocaleString('en-US')} users${row.ofTop !== null ? ` · ${row.ofTop.toFixed(1)}% of top` : ''}${stepLabel && row.ofPrev !== null ? ` · ${stepLabel(pctText(row.ofPrev))}` : ''}`}
          >
            <span className="funnel-bars-label">{row.label}</span>
            <span className="funnel-bars-track">
              <span className="funnel-bars-fill" style={{ width: `${(row.users / max) * 100}%`, ...(worst ? WORST_FILL : null) }} />
            </span>
            <span className="funnel-bars-value">
              {row.users.toLocaleString('en-US')}
              {row.ofTop !== null && <span className="funnel-bars-pct"> · {row.ofTop.toFixed(row.ofTop >= 10 ? 0 : 1)}%</span>}
              {stepLabel && row.ofPrev !== null && (
                <span
                  className="funnel-bars-step"
                  data-step-pct={row.ofPrev.toFixed(1)}
                  title={stepMode === 'short' ? stepLabel(pctText(row.ofPrev)) : undefined}
                >
                  <svg className="funnel-bars-step-icon" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
                    <path d="M2 1v4.5h5.5M5.5 3.5l2 2-2 2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {stepMode === 'short' ? pctText(row.ofPrev) : stepLabel(pctText(row.ofPrev))}
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
