import { useId, useState, type CSSProperties } from 'react';
import { useI18n } from '../../../context/I18nContext';
import {
  funnelSlice,
  knOf,
  orderedNotes,
  type FunnelFrame,
  type FunnelFrameFunnel,
  type FunnelFrameMetric,
  type FunnelFrameNote,
  type Selection,
} from '../../../generated/frameOps';
import {
  balancedColumns, fill, fmtCompact, fmtMetric, fmtMetricDelta, formatDay, formatRateOrKn, rateAttrs, relativeAgo, spendDisplay, type Translate,
} from './explorerFormat';
import './explorer.css';

/**
 * The funnel explorer's header (a `breakdown` block with `picker` draws it above
 * its chips): which funnel, which window, where the numbers came from, the
 * funnel's headline figures, and its reading traps, ONCE, as one line each.
 *
 * It replaces the reference explorer's walls of notes repeated under every
 * page (weakness 2). Two forms:
 *
 *   - CARD (a board cell): it must leave the page its room. One row holds the
 *     picker, the window and the source; the headline figures are ONE strip
 *     (label and value inline, the change a small suffix); only the current
 *     funnel's own traps show (at most CARD_TRAPS), everything else (the set's
 *     traps, every info note) sits behind "Reading traps (N)".
 *   - FULL (fullscreen): equal-height headline cards whose column count never
 *     leaves an orphan (weakness 8), and the notes in `orderedNotes` order with
 *     the first NOTES_VISIBLE showing, the rest behind "+N".
 *
 * An unmeasured figure reads "Not measured", never 0; a dollar figure of 0 is
 * "no spend attributed", never "$0". Every script string renders as text.
 */

/** Notes shown before the "+N" toggle in the full header. */
export const NOTES_VISIBLE = 4;
/** The current funnel's own traps a card header shows without a click. */
export const CARD_TRAPS = 2;
/** Headline cards at most. */
export const MAX_KPIS = 4;

/** The funnel the header speaks for: the pick, else the first (the block notes an unknown pick itself). */
function shownFunnel(frame: FunnelFrame, funnelId: string | null): FunnelFrameFunnel | null {
  return frame.funnels.find((f) => f.id === funnelId) ?? frame.funnels[0] ?? null;
}

/** First-step users of a funnel (its first measured step), for the picker. */
function topUsers(f: FunnelFrameFunnel): number | null {
  const first = f.steps.find((s) => s.measured !== false);
  return first ? first.users : null;
}

/**
 * The headline metrics, in key order: up to three counts or dollar figures,
 * then one rate (the ladder's first stage when it is carried, else the first
 * pct/x metric). The frame names no primary metric, so this is the rule.
 */
export function kpiKeys(frame: FunnelFrame, metrics: Record<string, FunnelFrameMetric>): string[] {
  const keys = Object.keys(metrics);
  const plain = keys.filter((k) => metrics[k].format === 'count' || metrics[k].format === 'usd').slice(0, MAX_KPIS - 1);
  const rate = (frame.ladder ?? []).find((k) => metrics[k]) ?? keys.find((k) => metrics[k].format === 'pct' || metrics[k].format === 'x');
  return rate ? [...plain, rate] : plain.slice(0, MAX_KPIS);
}

export interface ExplorerHeaderProps {
  frame: FunnelFrame;
  /** The effective pick (already checked against the frame), or null for the first funnel. */
  funnelId: string | null;
  selection: Selection;
  /** Change the card's funnel; absent = the picker shows the funnel but cannot change it. */
  onFunnel?: (id: string | null) => void;
  /** The full header (fullscreen); default the compact card form. */
  full?: boolean;
}

export function ExplorerHeader({ frame, funnelId, selection, onFunnel, full = false }: ExplorerHeaderProps) {
  const { t, locale } = useI18n();
  const funnel = shownFunnel(frame, funnelId);
  if (!funnel) return null;
  const notes = orderedNotes(frame, funnel.id);
  return (
    <section className="lab-xh" data-lab-explorer-header="" data-lab-funnel={funnel.id} data-mode={full ? 'full' : 'card'}>
      <div className="lab-xh-top">
        <FunnelPicker frame={frame} current={funnel.id} onFunnel={onFunnel} t={t} locale={locale} />
        <ExplorerWindow frame={frame} t={t} locale={locale} />
        <ExplorerSource frame={frame} t={t} locale={locale} />
      </div>
      {full
        ? <ExplorerKpis frame={frame} funnelId={funnel.id} selection={selection} t={t} locale={locale} />
        : <ExplorerKpiStrip frame={frame} funnelId={funnel.id} selection={selection} t={t} locale={locale} />}
      {full ? <ExplorerNotes notes={notes} t={t} /> : <ExplorerCardNotes notes={notes} t={t} />}
    </section>
  );
}

interface Copy {
  t: Translate;
  locale: string;
}

/** A picker option's text: the funnel name and its first-step users in short form. */
export function pickerText(f: FunnelFrameFunnel, t: Translate, locale: string): string {
  const users = topUsers(f);
  return users === null ? f.name : fill(t('lab.explorer.pickerOption'), { name: f.name, users: fmtCompact(users, locale) });
}

export function FunnelPicker({ frame, current, onFunnel, t, locale }: Copy & { frame: FunnelFrame; current: string; onFunnel?: (id: string | null) => void }) {
  const id = useId();
  const chosen = frame.funnels.find((f) => f.id === current);
  return (
    <span className="lab-xh-picker">
      <label className="lab-xh-label" htmlFor={id}>{t('lab.explorer.picker')}</label>
      <select
        id={id}
        className="lab-xh-select"
        data-lab-funnel-picker=""
        value={current}
        title={chosen ? pickerText(chosen, t, locale) : undefined}
        disabled={!onFunnel || frame.funnels.length < 2}
        onChange={(e) => onFunnel?.(e.target.value)}
      >
        {frame.funnels.map((f) => (
          <option key={f.id} value={f.id} data-lab-funnel-option={f.id}>{pickerText(f, t, locale)}</option>
        ))}
      </select>
    </span>
  );
}

export function ExplorerWindow({ frame, t, locale }: Copy & { frame: FunnelFrame }) {
  const w = frame.window;
  if (!w) return null;
  const now = fill(t('lab.explorer.window'), { from: formatDay(w.from, locale), to: formatDay(w.to, locale) });
  const prev = w.prevFrom && w.prevTo
    ? fill(t('lab.explorer.windowPrev'), { from: formatDay(w.prevFrom, locale), to: formatDay(w.prevTo, locale) })
    : null;
  return (
    <span className="lab-xh-window" data-lab-explorer-window={`${w.from}..${w.to}`}>
      <span className="lab-xh-window-now">{now}</span>
      {prev && <span className="lab-xh-window-prev" data-lab-explorer-window-prev="">{prev}</span>}
    </span>
  );
}

export function ExplorerSource({ frame, t, locale }: Copy & { frame: FunnelFrame }) {
  const p = frame.provenance;
  if (!p) return null;
  const parts = sourceParts(p, t, locale);
  const line = parts.join(' · ');
  return (
    <span className="lab-xh-source" data-lab-explorer-source="">
      <span className="lab-xh-source-line" title={p.pulledAt ? `${line}\n${p.pulledAt}` : line}>{line}</span>
      {p.filters.length > 0 && (
        <details className="lab-xh-filters" data-lab-explorer-filters="">
          <summary>{`${t('lab.explorer.filters')} (${p.filters.length})`}</summary>
          <ul>
            {p.filters.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </details>
      )}
    </span>
  );
}

/**
 * The source line's parts: where from, when it was pulled, and how old the data
 * was at the pull. Both times are labelled, so "pulled 11 days ago" and "data
 * 3 h old" never read as a contradiction.
 */
export function sourceParts(
  p: NonNullable<FunnelFrame['provenance']>,
  t: Translate,
  locale: string,
  now: number = Date.now(),
): string[] {
  const parts = [fill(t('lab.explorer.source'), { source: p.source })];
  if (p.pulledAt) {
    const ago = relativeAgo(p.pulledAt, locale, now);
    if (ago) parts.push(fill(t('lab.explorer.pulledAt'), { ago }));
  }
  if (p.freshness) parts.push(fill(t('lab.explorer.dataAge'), { age: p.freshness }));
  return parts;
}

/** One headline figure, formatted: the value (or k/n, or the no-spend dash) and its change. */
function kpiFigure(frame: FunnelFrame, slice: ReturnType<typeof funnelSlice>, k: string, t: Translate, locale: string, compact: boolean) {
  const m = slice.metrics[k];
  const measured = m.measured && m.v !== null;
  if (!measured) return { m, measured, text: null, attrs: {}, title: m.reason ?? undefined, delta: null as number | null, deltaText: null as string | null };
  if (m.format === 'usd' && m.v === 0) {
    const d = spendDisplay(0, locale, t, compact);
    return { m, measured, text: d.text, attrs: {}, title: d.title ?? undefined, delta: null, deltaText: null };
  }
  const shown = formatRateOrKn(m.v, m.format, knOf(frame, slice, k), locale, t);
  const text = shown.kn ? shown.text : fmtMetric(m.v as number, m.format, locale, compact);
  const delta = !shown.kn && m.prev !== null ? (m.v as number) - m.prev : null;
  const deltaText = delta === null ? null : fmtMetricDelta(delta, m.format, locale, compact);
  return { m, measured, text, attrs: rateAttrs(shown), title: shown.title ?? undefined, delta, deltaText };
}

/** The card form: every headline figure on ONE line (label, value, a small signed change). */
export function ExplorerKpiStrip({ frame, funnelId, selection, t, locale }: Copy & { frame: FunnelFrame; funnelId: string; selection: Selection }) {
  const slice = funnelSlice(frame, funnelId, selection);
  if (!slice.measured) return null;
  const keys = kpiKeys(frame, slice.metrics);
  if (keys.length === 0) return null;
  return (
    <div className="lab-xh-strip" data-lab-explorer-kpis="" data-mode="strip">
      {keys.map((k) => {
        const fig = kpiFigure(frame, slice, k, t, locale, true);
        const label = fig.m.label ?? k;
        return (
          <span key={k} className="lab-xh-strip-item" data-lab-kpi={k} data-measured={fig.measured ? undefined : 'false'} title={label}>
            <span className="lab-xh-strip-label">{label}</span>
            {fig.text !== null
              ? <span className="lab-xh-strip-value" {...fig.attrs} title={fig.title}>{fig.text}</span>
              : (
                <span className="lab-xh-strip-value lab-x-unmeasured" data-lab-not-measured="" title={fig.title}>
                  {t('lab.explorer.notMeasured')}
                </span>
              )}
            {fig.deltaText && (
              <span
                className="lab-xh-strip-delta"
                data-lab-kpi-delta=""
                data-sign={fig.delta! > 0 ? 'up' : fig.delta! < 0 ? 'down' : 'flat'}
                title={fill(t('lab.explorer.kpiDelta'), { delta: fig.deltaText })}
              >
                {fig.deltaText}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function ExplorerKpis({ frame, funnelId, selection, t, locale }: Copy & { frame: FunnelFrame; funnelId: string; selection: Selection }) {
  const slice = funnelSlice(frame, funnelId, selection);
  if (!slice.measured) return null;
  const keys = kpiKeys(frame, slice.metrics);
  if (keys.length === 0) return null;
  const cols = balancedColumns(keys.length, MAX_KPIS);
  return (
    <div className="lab-xh-kpis" data-lab-explorer-kpis="" style={{ '--lab-xh-cols': cols } as CSSProperties}>
      {keys.map((k) => {
        const fig = kpiFigure(frame, slice, k, t, locale, false);
        const label = fig.m.label ?? k;
        return (
          <div key={k} className="lab-xh-kpi" data-lab-kpi={k} data-measured={fig.measured ? undefined : 'false'}>
            <span className="lab-xh-kpi-label" title={label}>{label}</span>
            {fig.text !== null
              ? <span className="lab-xh-kpi-value" {...fig.attrs} title={fig.title}>{fig.text}</span>
              : (
                <span className="lab-xh-kpi-value lab-x-unmeasured" data-lab-not-measured="" title={fig.title}>
                  {t('lab.explorer.notMeasured')}
                </span>
              )}
            {fig.deltaText && (
              <span className="lab-xh-kpi-delta" data-lab-kpi-delta="" data-sign={fig.delta! > 0 ? 'up' : fig.delta! < 0 ? 'down' : 'flat'}>
                {fill(t('lab.explorer.kpiDelta'), { delta: fig.deltaText })}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ExplorerNotes({ notes, t }: { notes: readonly FunnelFrameNote[]; t: Translate }) {
  const [open, setOpen] = useState(false);
  if (notes.length === 0) return null;
  const shown = open ? notes : notes.slice(0, NOTES_VISIBLE);
  const more = notes.length - NOTES_VISIBLE;
  return (
    <div className="lab-xh-notes" data-lab-explorer-notes={notes.length}>
      <span className="lab-xh-label">{t('lab.explorer.notes')}</span>
      <ul className="lab-xh-note-list">
        {shown.map((n, i) => (
          <li
            key={`${n.scope}-${i}`}
            className="lab-xh-note"
            data-lab-explorer-note={n.code ?? String(i)}
            data-level={n.level}
            data-scope={n.scope}
            title={n.text}
          >
            <span className="lab-xh-note-mark" aria-hidden="true" />
            {n.code && <span className="lab-xh-note-code">{n.code}</span>}
            <span className="lab-xh-note-text">{n.text}</span>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button
          type="button"
          className="lab-xh-notes-more"
          data-lab-notes-more={more}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t('lab.explorer.notesLess') : fill(t('lab.explorer.notesMore'), { n: more })}
        </button>
      )}
    </div>
  );
}

/** The note line a header draws (both forms share it). */
function NoteLine({ n, i }: { n: FunnelFrameNote; i: number }) {
  return (
    <li
      className="lab-xh-note"
      data-lab-explorer-note={n.code ?? String(i)}
      data-level={n.level}
      data-scope={n.scope}
      title={n.text}
    >
      <span className="lab-xh-note-mark" aria-hidden="true" />
      {n.code && <span className="lab-xh-note-code">{n.code}</span>}
      <span className="lab-xh-note-text">{n.text}</span>
    </li>
  );
}

/**
 * The card form's notes: the current funnel's own traps (at most CARD_TRAPS),
 * always in sight; everything else (the set's traps, every info note, a third
 * own trap) behind ONE "Reading traps (N)" disclosure.
 */
export function ExplorerCardNotes({ notes, t }: { notes: readonly FunnelFrameNote[]; t: Translate }) {
  const [open, setOpen] = useState(false);
  if (notes.length === 0) return null;
  const own = notes.filter((n) => n.scope === 'funnel' && n.level !== 'info').slice(0, CARD_TRAPS);
  const rest = notes.filter((n) => !own.includes(n));
  return (
    <div className="lab-xh-notes lab-xh-notes--card" data-lab-explorer-notes={notes.length}>
      {/* With nothing behind a disclosure, the label names what the lines are. */}
      {rest.length === 0 && <span className="lab-xh-label">{t('lab.explorer.notes')}</span>}
      {own.length > 0 && (
        <ul className="lab-xh-note-list">
          {own.map((n, i) => <NoteLine key={`own-${i}`} n={n} i={i} />)}
        </ul>
      )}
      {rest.length > 0 && (
        <button
          type="button"
          className="lab-xh-notes-more"
          data-lab-notes-more={rest.length}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {fill(t('lab.explorer.notesAll'), { n: rest.length })}
        </button>
      )}
      {open && rest.length > 0 && (
        <ul className="lab-xh-note-list" data-lab-notes-rest="">
          {rest.map((n, i) => <NoteLine key={`rest-${i}`} n={n} i={own.length + i} />)}
        </ul>
      )}
    </div>
  );
}
