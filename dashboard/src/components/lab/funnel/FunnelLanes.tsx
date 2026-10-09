import { Fragment, type CSSProperties } from 'react';
import { useMeasured } from '../chartBody';
import { useI18n } from '../../../context/I18nContext';
import { stepDrops, type FunnelSlice, type StepDrop } from '../../../generated/frameOps';
import { alignStepKeys, dropSeverity } from './funnelModel';
import { fmtCount, fmtDrop } from '../explorer/explorerFormat';
import { dropBadgeText, pctText } from './FunnelFlow';
import './FunnelLanes.css';

/** The most lanes drawn side by side (the card's pin limit). */
export const MAX_DRAWN_LANES = 4;

/** One drawn lane: its slice (from its own path) and its caption. */
export interface LaneInput {
  slice: FunnelSlice;
  /** The selection written for people ("Meta Ads · EN"). */
  label: string;
}

export interface LaneModel {
  label: string;
  measured: boolean;
  reason: string | null;
  users: number;
  /** stepDrops over the lane's OWN path, keyed by step key. */
  byKey: Map<string, StepDrop>;
  /** The lane's own first-step users: every bar in the lane is a share of it. */
  top: number;
  /** Why a step is not measured on this lane's path (the funnel step's reason), by step key. */
  reasons: Map<string, string | null>;
}

/**
 * The lanes on one spine: the funnel's own step order first (`base`), then any
 * step only a lane carries. Each lane's rates come from its own path: a lane
 * that skips a step drops from its own previous step, never from the spine's.
 */
export function laneModel(lanes: readonly LaneInput[], base: readonly { key: string; label: string }[]): { spine: { key: string; label: string }[]; lanes: LaneModel[] } {
  const drawn = lanes.slice(0, MAX_DRAWN_LANES);
  const spine = alignStepKeys([{ steps: base }, ...drawn.map((l) => ({ steps: l.slice.steps }))]);
  return {
    spine,
    lanes: drawn.map((l) => {
      const drops = l.slice.measured ? stepDrops(l.slice.steps) : [];
      return {
        label: l.label,
        measured: l.slice.measured,
        reason: l.slice.reason,
        users: l.slice.users,
        byKey: new Map(drops.map((d) => [d.key, d])),
        top: l.slice.steps.find((s) => s.measured !== false)?.users ?? 0,
        reasons: new Map(l.slice.steps.filter((s) => s.measured === false).map((s) => [s.key, s.reason ?? null])),
      };
    }),
  };
}

/** Row heights (px, FunnelLanes.css) the fit plans with: a step row never shrinks under one readable line. */
export const LANE_PX = { row: 16, head: 40, denseHead: 22 } as const;

/** The lane head goes to one line when the two-line head and a readable row per step do not both fit. */
export function lanesDense(steps: number, height: number): boolean {
  return height > 0 && height < LANE_PX.head + steps * (LANE_PX.row + 4);
}

/** The widest "users · share" (and share alone) a lane writes, in ch: every row of a lane keeps one track width. */
export function laneTextWidths(lane: LaneModel, locale = 'en'): { value: number; share: number } {
  let value = 1;
  let share = 1;
  for (const d of lane.byKey.values()) {
    const pct = d.ofTop !== null ? pctText(d.ofTop, locale) : '';
    value = Math.max(value, fmtCount(d.users, locale).length + (pct ? pct.length + 3 : 0));
    share = Math.max(share, pct.length);
  }
  return { value, share };
}

/**
 * Pinned selections side by side (1-4 columns) on one step spine. Every
 * lane's bar widths, shares and drop badges come from its own path (stepDrops
 * per lane); a step a lane does not carry is a dash, an unmeasured lane says
 * so in its head and draws dashes, never zeros. `markWorst` marks each lane's
 * own largest drop. One row per step: the bar, "users · share", and the drop
 * into that step. A row never shrinks under one readable line; a narrow lane
 * drops its secondary text first (the users, then the share), keeping the bar
 * and the drop. Labels render as text only.
 */
export function FunnelLanes({ lanes, base, markWorst = false, dense = false }: {
  lanes: readonly LaneInput[];
  base: readonly { key: string; label: string }[];
  markWorst?: boolean;
  dense?: boolean;
}) {
  const { t, locale } = useI18n();
  const [measure, box] = useMeasured<HTMLDivElement>();
  const model = laneModel(lanes, base);
  const n = model.lanes.length;
  if (n === 0) return null;
  const thin = dense || lanesDense(model.spine.length, box.height);
  const rows = ['auto', ...model.spine.map(() => `minmax(${LANE_PX.row}px, 1fr)`)];
  return (
    <div
      ref={measure}
      className="funnel-lanes"
      data-lab-lanes={n}
      data-dense={thin ? '' : undefined}
      style={{
        gridTemplateColumns: `fit-content(${n > 2 ? 22 : 28}%) repeat(${n}, minmax(0, 1fr))`,
        gridTemplateRows: rows.join(' '),
      }}
    >
      <span className="funnel-lanes-corner" aria-hidden="true" />
      {model.lanes.map((lane, li) => {
        const note = lane.measured
          ? fmtCount(lane.users, locale)
          : t('lab.blocks.explorer.notMeasured').replace('{sel}', lane.label).replace('{reason}', lane.reason ?? t('lab.blocks.breakdown.noPath'));
        return (
          <div
            key={`h${li}`}
            className="funnel-lanes-head"
            data-lab-lane={li + 1}
            data-lab-lane-unmeasured={lane.measured ? undefined : ''}
            title={`${t('lab.blocks.funnel.lane').replace('{n}', String(li + 1))}: ${lane.label} · ${note}`}
          >
            <span className="funnel-lanes-head-row">
              <span className="funnel-lanes-num" data-lane={li + 1}>{li + 1}</span>
              <span className="funnel-lanes-name">{lane.label}</span>
              <span className="funnel-lanes-users">{note}</span>
            </span>
          </div>
        );
      })}
      {model.spine.map((step) => (
        <Fragment key={step.key}>
          <span className="funnel-lanes-step" data-lab-lane-step={step.key} title={step.label}>{step.label}</span>
          {model.lanes.map((lane, li) => {
            const d = lane.byKey.get(step.key);
            if (!d) {
              return (
                <span key={`c${li}`} className="funnel-lanes-cell funnel-lanes-cell--missing" data-lab-lane-missing={step.key} data-lane={li + 1}>—</span>
              );
            }
            if (!d.measured) {
              // Not measured on this path: the word, its reason in the title, never a bar of 0.
              const why = t('lab.explorer.notMeasuredWhy').replace('{reason}', lane.reasons.get(step.key) ?? t('lab.blocks.breakdown.noPath'));
              return (
                <span
                  key={`c${li}`}
                  className="funnel-lanes-cell funnel-lanes-cell--unmeasured"
                  data-lane={li + 1}
                  data-measured="false"
                  data-lab-not-measured={step.key}
                  title={`${lane.label} · ${step.label}: ${why}`}
                >
                  {t('lab.explorer.notMeasured')}
                </span>
              );
            }
            const width = lane.top > 0 ? Math.min(100, (d.users / lane.top) * 100) : 0;
            const w = laneTextWidths(lane, locale);
            const worst = markWorst && d.worst;
            return (
              <span
                key={`c${li}`}
                className="funnel-lanes-cell"
                data-lane={li + 1}
                data-users={d.users}
                style={{ '--lane-value-w': `${w.value}ch`, '--lane-share-w': `${w.share}ch` } as CSSProperties}
                title={`${lane.label} · ${step.label}: ${fmtCount(d.users, locale)}${d.ofTop !== null ? ` · ${pctText(d.ofTop, locale)}` : ''}`}
              >
                <span className="funnel-lanes-row">
                <span className="funnel-lanes-track"><span className="funnel-lanes-fill" style={{ width: `${width}%` }} /></span>
                <span className="funnel-lanes-text">
                  <span className="funnel-lanes-value">
                    {fmtCount(d.users, locale)}
                    {d.ofTop !== null && <span className="funnel-lanes-pct"> · {pctText(d.ofTop, locale)}</span>}
                  </span>
                  {d.ofTop !== null && <span className="funnel-lanes-share" aria-hidden="true">{pctText(d.ofTop, locale)}</span>}
                </span>
                {d.dropPct === null ? <span className="funnel-lanes-drop funnel-lanes-drop--none" aria-hidden="true" /> : (
                  <span
                    className="funnel-lanes-drop"
                    data-lab-drop={step.key}
                    data-lane={li + 1}
                    data-drop-pct={d.dropPct.toFixed(1)}
                    data-severity={dropSeverity(d.ofPrev)}
                    data-lab-worst={worst ? step.key : undefined}
                    title={`${lane.label}: ${fmtDrop(d.dropPct, locale)}${worst ? ` · ${t('lab.blocks.funnel.worst')}` : ''}`}
                  >
                    {dropBadgeText(d, locale)}
                  </span>
                )}
                </span>
              </span>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
