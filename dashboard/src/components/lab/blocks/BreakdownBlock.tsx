import { useId, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import {
  breakdownAxes, funnelSlice, selectionKey, toggleSelection,
  type BreakdownAxis, type FunnelFrame, type Selection,
} from '../../../generated/frameOps';
import { formatNumber } from '../chart';
import { BlockEmpty, boolOption, drawableFrame, stringListOption, stringOption, type BlockViewProps } from './blockCommon';
import './breakdown.css';

/**
 * `breakdown`: the explorer's chip bar. One chip row per funnel dimension
 * (`dims` picks and orders them); a chip toggles its value in the card's
 * selection, "All traffic" clears it. A chip whose combination has no measured
 * path is aria-disabled (still focusable): clicks change nothing and its
 * reason shows on hover and on focus. Not measured is never drawn as 0.
 *
 * `counts` puts each chip's users on it; `lanes` (default on) adds the lane
 * box: pin the current selection as one of up to 4 side-by-side lanes.
 * Every label, value and reason comes from the script and renders as text.
 */

export const MAX_LANES = 4;

/** A selection as the chips read: values in dimension order, `·` between (empty = null). */
export function selectionLabel(sel: Selection, dimOrder: readonly string[]): string | null {
  const keys = [...dimOrder.filter((k) => sel[k] !== undefined), ...Object.keys(sel).filter((k) => !dimOrder.includes(k)).sort()];
  const values = keys.map((k) => sel[k]).filter((v) => typeof v === 'string' && v !== '');
  return values.length > 0 ? values.join(' · ') : null;
}

/** The picked funnel id when the frame does not carry it (the block notes the fallback). */
export function unknownFunnelPick(frame: FunnelFrame, pick: string | null): string | null {
  return pick !== null && frame.funnels.length > 0 && !frame.funnels.some((f) => f.id === pick) ? pick : null;
}

/** The axes the `dims` option asks for, in its order; unknown dims are returned so the block can say so. */
export function pickAxes(axes: readonly BreakdownAxis[], dims: readonly string[] | null): { axes: BreakdownAxis[]; unknown: string[] } {
  if (!dims) return { axes: [...axes], unknown: [] };
  const out: BreakdownAxis[] = [];
  const unknown: string[] = [];
  for (const key of dims) {
    const axis = axes.find((a) => a.key === key);
    if (axis) {
      if (!out.includes(axis)) out.push(axis);
    } else if (!unknown.includes(key)) unknown.push(key);
  }
  return { axes: out, unknown };
}

/** Why the current selection cannot be pinned, or null when it can. */
export function pinBlock(sel: Selection, lanes: readonly Selection[], measured: boolean): 'full' | 'unmeasured' | 'duplicate' | null {
  if (lanes.length >= MAX_LANES) return 'full';
  if (!measured) return 'unmeasured';
  const key = selectionKey(sel);
  if (lanes.some((l) => selectionKey(l) === key)) return 'duplicate';
  return null;
}

interface Tip {
  id: string;
  title: string;
  text: string;
  /** The chip's box in viewport px. */
  rect: { left: number; top: number; width: number; height: number };
}

export function BreakdownBlock({ frame, options, selection, onSelection, lanes, onLanes }: BlockViewProps) {
  const { t, locale } = useI18n();
  const uid = useId();
  const [tip, setTip] = useState<Tip | null>(null);
  const drawable = drawableFrame(frame, ['funnel'] as const);
  if ('empty' in drawable) return <div className="lab-block-fill"><BlockEmpty reason={drawable.empty} /></div>;
  const f = drawable.frame;

  const pick = stringOption(options, 'funnel');
  const unknownFunnel = unknownFunnelPick(f, pick);
  const funnelId = unknownFunnel ? null : pick;
  const sel: Selection = selection ?? {};
  const { axes, unknown } = pickAxes(breakdownAxes(f, funnelId, sel), stringListOption(options, 'dims'));
  const counts = boolOption(options, 'counts');
  const showLanes = boolOption(options, 'lanes', true);
  const pinned: readonly Selection[] = lanes ?? [];
  const dimOrder = (f.dimensions ?? []).map((d) => d.key);
  const shownName = f.funnels.find((x) => x.id === funnelId)?.name ?? f.funnels[0]?.name ?? '';

  const notes = (
    <>
      {unknownFunnel && (
        <div className="lab-explorer-note" data-lab-unknown-funnel="">
          {t('lab.blocks.explorer.unknownFunnel').replace('{id}', unknownFunnel).replace('{name}', shownName)}
        </div>
      )}
      {unknown.length > 0 && (
        <div className="lab-explorer-note" data-lab-unknown-dims="">
          {t('lab.blocks.explorer.unknownMetrics').replace('{keys}', unknown.join(', '))}
        </div>
      )}
    </>
  );

  if (axes.length === 0) {
    return (
      <div className="lab-block-fill lab-breakdown" data-lab-breakdown="">
        {notes}
        <BlockEmpty message={t('lab.blocks.breakdown.noDims')} />
      </div>
    );
  }

  const reasonText = (reason: string | null) => t('lab.blocks.breakdown.unmeasured').replace('{reason}', reason ?? t('lab.blocks.breakdown.noPath'));
  const users = (n: number) => formatNumber(n, { format: 'compact', locale });
  const allLabel = t('lab.blocks.breakdown.all');
  const labelOf = (s: Selection) => selectionLabel(s, dimOrder) ?? allLabel;

  const showTip = (e: FocusEvent<HTMLElement> | MouseEvent<HTMLElement>, id: string, title: string, text: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ id, title, text, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
  };
  const hideTip = (id: string) => setTip((cur) => (cur && cur.id === id ? null : cur));

  const current = funnelSlice(f, funnelId, sel);
  const blocked = pinBlock(current.selection, pinned, current.measured);
  const hint = pinned.length >= MAX_LANES
    ? t('lab.blocks.breakdown.lanesFull')
    : pinned.length === 0
      ? t('lab.blocks.breakdown.lanesHint0')
      : pinned.length === 1
        ? t('lab.blocks.breakdown.lanesHint1')
        : t('lab.blocks.breakdown.lanesHintN').replace('{n}', String(pinned.length));
  const allActive = axes.every((a) => sel[a.key] === undefined);
  // A tip outlives nothing: once its chip is enabled (or gone) it closes.
  const tipLive = !!tip && axes.some((a) => a.chips.some((c) => !c.enabled && tip.id === `${uid}-tip-${a.key}-${c.value}`));

  return (
    <div className="lab-block-fill lab-breakdown" data-lab-breakdown="" data-counts={counts ? 'true' : undefined}>
      {notes}
      <div className="lab-breakdown-axes">
        <div className="lab-breakdown-all-row">
          <button
            type="button"
            className="lab-breakdown-chip lab-breakdown-all"
            data-lab-breakdown-all=""
            aria-pressed={allActive}
            onClick={() => onSelection?.({})}
          >
            {allLabel}
          </button>
        </div>
        {axes.map((axis) => {
          const labelId = `${uid}-dim-${axis.key}`;
          return (
            <div key={axis.key} className="lab-breakdown-dim" role="group" aria-labelledby={labelId} data-lab-breakdown-dim={axis.key}>
              <span className="lab-breakdown-dim-label" id={labelId}>{axis.label}</span>
              <div className="lab-breakdown-chips">
                {axis.chips.map((chip) => {
                  const tipId = `${uid}-tip-${axis.key}-${chip.value}`;
                  const descId = `${uid}-why-${axis.key}-${chip.value}`;
                  const why = chip.enabled ? null : reasonText(chip.reason);
                  return (
                    <button
                      key={chip.value}
                      type="button"
                      className="lab-breakdown-chip"
                      data-lab-breakdown-chip={chip.value}
                      data-active={chip.active ? 'true' : undefined}
                      aria-pressed={chip.active}
                      aria-disabled={chip.enabled ? undefined : true}
                      aria-describedby={why ? descId : undefined}
                      onClick={() => {
                        if (chip.enabled) onSelection?.(toggleSelection(sel, axis.key, chip.value));
                      }}
                      onMouseEnter={why ? (e) => showTip(e, tipId, chip.value, why) : undefined}
                      onMouseLeave={() => hideTip(tipId)}
                      onFocus={why ? (e) => showTip(e, tipId, chip.value, why) : undefined}
                      onBlur={() => hideTip(tipId)}
                    >
                      <span className="lab-breakdown-chip-value">{chip.value}</span>
                      {counts && chip.users !== null && (
                        <span className="lab-breakdown-chip-count" data-lab-chip-users={chip.users}>{users(chip.users)}</span>
                      )}
                      {why && <span className="lab-breakdown-sr" id={descId}>{why}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {showLanes && (
        <div className="lab-breakdown-lanes" data-lab-breakdown-lanes={pinned.length}>
          <span className="lab-breakdown-dim-label">{t('lab.blocks.breakdown.lanes')}</span>
          <div className="lab-breakdown-lane-list">
            {pinned.map((lane, i) => (
              <span key={selectionKey(lane) || `all-${i}`} className="lab-breakdown-lane" data-lab-lane={i + 1}>
                <span className="lab-breakdown-lane-num" data-lane={i + 1} aria-hidden="true">{i + 1}</span>
                <span className="lab-breakdown-lane-label">{labelOf(lane)}</span>
                <button
                  type="button"
                  className="lab-breakdown-lane-remove"
                  data-lab-lane-remove={i + 1}
                  aria-label={t('lab.blocks.breakdown.removeLane').replace('{n}', String(i + 1))}
                  onClick={() => onLanes?.(pinned.filter((_, j) => j !== i))}
                >
                  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                    <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            ))}
            <button
              type="button"
              className="lab-breakdown-pin"
              data-lab-lane-pin=""
              data-blocked={blocked ?? undefined}
              disabled={blocked !== null}
              onClick={() => {
                if (blocked === null) onLanes?.([...pinned, current.selection]);
              }}
            >
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span>{t('lab.blocks.breakdown.pin').replace('{sel}', `'${labelOf(current.selection)}'`)}</span>
            </button>
            {pinned.length >= 2 && (
              <button type="button" className="lab-breakdown-clear" data-lab-lanes-clear="" onClick={() => onLanes?.([])}>
                {t('lab.blocks.breakdown.clear')}
              </button>
            )}
          </div>
          <span className="lab-breakdown-hint" data-lab-lanes-hint="">{hint}</span>
        </div>
      )}
      {tip && tipLive && <ChipReason tip={tip} />}
    </div>
  );
}

/** The tip's left edge: centred on the chip, kept inside the viewport. */
export function chipTipLeft(rect: { left: number; width: number }, tipWidth: number, viewportWidth: number): number {
  const centred = rect.left + rect.width / 2 - tipWidth / 2;
  return Math.min(Math.max(0, centred), Math.max(0, viewportWidth - tipWidth));
}

/**
 * The disabled chip's reason, floating over the page (a portal on <body>,
 * fixed position) so a short card never clips it. Text only, in the chart
 * tooltip's skin; placed beside the chip and kept inside the viewport.
 */
function ChipReason({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    const box = { width: el.offsetWidth, height: el.offsetHeight };
    const bounds = { width: window.innerWidth, height: window.innerHeight };
    // Prefer below the chip, centred on it; flip above when the viewport ends.
    const below = tip.rect.top + tip.rect.height + 6;
    const top = below + box.height <= bounds.height ? below : Math.max(0, tip.rect.top - 6 - box.height);
    const next = { left: chipTipLeft(tip.rect, box.width, bounds.width), top };
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, [tip]);
  const el = (
    <div
      ref={ref}
      className="lab-chart-tooltip lab-breakdown-tip"
      role="tooltip"
      id={tip.id}
      data-floating="true"
      data-lab-chip-reason={tip.title}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="lab-chart-tooltip-title">{tip.title}</div>
      <div className="lab-breakdown-tip-text">{tip.text}</div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(el, document.body) : el;
}
