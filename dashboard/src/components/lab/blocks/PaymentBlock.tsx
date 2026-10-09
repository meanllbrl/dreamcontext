import { useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { paymentView, type PaymentCohort, type PaymentRow, type Selection } from '../../../generated/frameOps';
import { balancedColumns, fill, fmtCount, fmtPercent, formatRateOrKn, hintLine, rateAttrs, type Translate } from '../explorer/explorerFormat';
import '../explorer/explorer.css';
import { BlockEmpty, drawableFrame, stringOption, type BlockViewProps } from './blockCommon';
import { selectionLabel, unknownFunnelPick } from './BreakdownBlock';

/**
 * `payment`: the selected path's card payments (paymentView): the decline
 * rate (k/n under 100 attempts), attempts and declines, why cards were
 * declined (named reasons plus the residual "other or unnamed"), then one
 * table per dimension the payment is split by.
 *
 * Honest by construction: a total is only ever the source's own `{}` cell
 * (never a sum of rows), cohorts are shown one at a time (never mixed), a
 * selection the payment is not split by says so and shows the funnel total,
 * reasons adding up to more than the declines raise a warning, and a funnel
 * with no payment says what is missing and how to fill it, never zeros.
 * Reason bars are full-width rows at least 20px tall (the reference's
 * weakness 10).
 */

const COHORT_KEYS: Record<PaymentCohort, string> = {
  first: 'lab.explorer.cohortFirst',
  renewal: 'lab.explorer.cohortRenewal',
  all: 'lab.explorer.cohortAll',
};

export function PaymentBlock({ frame, options, selection }: BlockViewProps) {
  const { t, locale } = useI18n();
  const [cohort, setCohort] = useState<PaymentCohort | null>(null);
  const drawable = drawableFrame(frame, ['funnel'] as const);
  if ('empty' in drawable) return <div className="lab-block-fill"><BlockEmpty reason={drawable.empty} /></div>;
  const f = drawable.frame;
  if (f.funnels.length === 0) return <BlockEmpty />;

  const pick = stringOption(options, 'funnel');
  const unknownFunnel = unknownFunnelPick(f, pick);
  const funnelId = unknownFunnel ? null : pick;
  const funnel = f.funnels.find((x) => x.id === funnelId) ?? f.funnels[0];
  const sel: Selection = selection ?? {};
  const view = paymentView(f, funnel.id, sel, cohort);
  const density = options.density === 'comfortable' ? 'comfortable' : 'compact';
  const dimOrder = (f.dimensions ?? []).map((d) => d.key);
  const dimLabel = (k: string) => f.dimensions?.find((d) => d.key === k)?.label ?? k;
  const count = (n: number) => fmtCount(n, locale);

  const notes = unknownFunnel ? (
    <div className="lab-x-note" data-tone="caution" data-lab-unknown-funnel="">
      {t('lab.blocks.explorer.unknownFunnel').replace('{id}', unknownFunnel).replace('{name}', funnel.name)}
    </div>
  ) : null;

  if (!view.measured) {
    const hint = hintLine(t, f, 'payment');
    const main = view.reason
      ? fill(t('lab.explorer.notMeasuredWhy'), { reason: view.reason })
      : fill(t('lab.explorer.emptyPayment'), { funnel: funnel.name });
    return (
      <div className="lab-block-fill lab-pay" data-lab-payment="" data-scope={view.scope}>
        {notes}
        <div className="lab-x-empty" data-lab-empty="payment" data-lab-not-measured={view.reason ? '' : undefined}>
          <span>{main}</span>
          {hint && <span className="lab-x-empty-hint" data-lab-hint="">{hint}</span>}
        </div>
      </div>
    );
  }

  const selected = Object.keys(sel).length > 0;
  const row: PaymentRow | null = view.current ?? view.total;
  const notForSel = selected && !view.current;

  return (
    <div className="lab-block-fill lab-pay" data-lab-payment="" data-scope={view.scope} data-cohort={view.cohort}>
      {notes}
      {view.scope === 'set' && <div className="lab-x-note" data-lab-payment-scope="set">{t('lab.explorer.paymentAllFunnels')}</div>}
      {view.cohorts.length > 1 && (
        <div className="lab-x-segmented" role="group" data-lab-payment-cohorts="">
          {view.cohorts.map((c) => (
            <button
              key={c}
              type="button"
              className="lab-x-segmented-option"
              data-lab-payment-cohort={c}
              aria-pressed={c === view.cohort}
              onClick={() => setCohort(c)}
            >
              {t(COHORT_KEYS[c])}
            </button>
          ))}
        </div>
      )}
      {notForSel && (
        <div className="lab-x-note" data-tone="caution" data-lab-payment-not-for-sel="">
          {fill(t('lab.explorer.paymentNotForSel'), { sel: selectionLabel(sel, dimOrder) ?? '' })}
        </div>
      )}
      {row ? <PaymentFigures row={row} t={t} locale={locale} /> : <BlockEmpty />}
      {row?.clipped && <div className="lab-pay-clipped" data-lab-payment-clipped="">{t('lab.explorer.paymentClipped')}</div>}
      {row && <ReasonBars row={row} t={t} locale={locale} />}
      {view.byDim.map((group) => (
        <div key={group.dim} className="lab-x-table-wrap" data-lab-payment-dim={group.dim}>
          <table className="lab-x-table" data-density={density}>
            <thead>
              <tr>
                <th scope="col">{dimLabel(group.dim)}</th>
                <th scope="col" className="lab-x-r">{t('lab.explorer.paymentAttempts')}</th>
                <th scope="col" className="lab-x-r">{t('lab.explorer.paymentDeclines')}</th>
                <th scope="col" className="lab-x-r">{t('lab.explorer.paymentRate')}</th>
                <th scope="col">{t('lab.explorer.paymentReasons')}</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((r) => {
                const value = r.dims[group.dim];
                const rate = formatRateOrKn(r.rate, 'pct', r.kn, locale, t);
                const top = [...r.reasons].sort((a, b) => b.count - a.count)[0];
                return (
                  <tr
                    key={value}
                    data-lab-payment-row={value}
                    data-low-sample={r.lowSample ? 'true' : undefined}
                    data-active={sel[group.dim] === value ? '' : undefined}
                    title={r.lowSample ? t('lab.explorer.lowSampleRow') : undefined}
                  >
                    <td>{value}</td>
                    <td className="lab-x-r">{count(r.attempts)}</td>
                    <td className="lab-x-r">{count(r.declines)}</td>
                    <td className="lab-x-r"><span {...rateAttrs(rate)}>{rate.text || '–'}</span></td>
                    <td className="lab-rank-sel">{top && top.count > 0 ? top.label : ''}</td>
                  </tr>
                );
              })}
              {view.total && (
                <tr className="lab-x-total" data-lab-payment-total="">
                  <td>{t('lab.explorer.paymentTotal')}</td>
                  <td className="lab-x-r">{count(view.total.attempts)}</td>
                  <td className="lab-x-r">{count(view.total.declines)}</td>
                  <td className="lab-x-r">
                    {(() => {
                      const rate = formatRateOrKn(view.total.rate, 'pct', view.total.kn, locale, t);
                      return <span {...rateAttrs(rate)}>{rate.text || '–'}</span>;
                    })()}
                  </td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/** Decline rate, attempts and declines of one cell, as one equal-height strip. */
function PaymentFigures({ row, t, locale }: { row: PaymentRow; t: Translate; locale: string }) {
  const rate = formatRateOrKn(row.rate, 'pct', row.kn, locale, t);
  const count = (n: number) => fmtCount(n, locale);
  const cards: { key: string; label: string; node: ReactNode }[] = [
    {
      key: 'rate',
      label: t('lab.explorer.paymentRate'),
      node: <span className="lab-x-card-value" data-lab-payment-rate={row.rate ?? ''} {...rateAttrs(rate)}>{rate.text || '–'}</span>,
    },
    { key: 'attempts', label: t('lab.explorer.paymentAttempts'), node: <span className="lab-x-card-value">{count(row.attempts)}</span> },
    { key: 'declines', label: t('lab.explorer.paymentDeclines'), node: <span className="lab-x-card-value">{count(row.declines)}</span> },
  ];
  return (
    <div
      className="lab-x-cards"
      data-lab-payment-figures=""
      data-low-sample={row.lowSample ? 'true' : undefined}
      style={{ '--lab-x-cols': balancedColumns(cards.length, 3) } as CSSProperties}
    >
      {cards.map((c) => (
        <div key={c.key} className="lab-x-card" data-lab-payment-card={c.key}>
          <span className="lab-x-card-label">{c.label}</span>
          {c.node}
        </div>
      ))}
    </div>
  );
}

/** Reason rows a payment page lists at most; the rest fold into "other or unnamed". */
export const MAX_REASON_ROWS = 5;

interface ReasonItem { key: string; label: string; count: number; share: number | null; note: string | null }

/**
 * The reason rows: named reasons by count (largest first), then the residual. Past
 * MAX_REASON_ROWS the smallest named reasons fold into the residual row, so the list
 * never grows past five and still adds up to the declines.
 */
export function reasonItems(row: PaymentRow, otherLabel: string): ReasonItem[] {
  const named = row.reasons
    .filter((r) => r.count > 0)
    .map((r) => ({ key: r.key, label: r.label, count: r.count, share: r.share, note: r.note }))
    .sort((a, b) => b.count - a.count);
  const room = row.other > 0 || named.length > MAX_REASON_ROWS ? MAX_REASON_ROWS - 1 : MAX_REASON_ROWS;
  const kept = named.slice(0, room);
  const other = row.other + named.slice(room).reduce((sum, r) => sum + r.count, 0);
  if (other > 0) {
    kept.push({ key: 'other', label: otherLabel, count: other, share: row.declines > 0 ? (other / row.declines) * 100 : null, note: null });
  }
  return kept;
}

/** Why cards were declined: one full-width bar per reason (at most five), tracks ending at one x. Shares are of the declines. */
function ReasonBars({ row, t, locale }: { row: PaymentRow; t: Translate; locale: string }) {
  const items = reasonItems(row, t('lab.explorer.paymentOther'));
  if (items.length === 0 || row.declines === 0) return null;
  return (
    <div data-lab-payment-reasons="">
      <div className="lab-pay-head">{t('lab.explorer.paymentReasons')}</div>
      <ul className="lab-pay-bars">
        {items.map((r) => (
          <li key={r.key} className="lab-pay-bar" data-lab-payment-reason={r.key} title={r.note ?? r.label}>
            <span className="lab-pay-bar-label">{r.label}</span>
            <span className="lab-x-track" aria-hidden="true">
              <span className="lab-x-fill" style={{ width: `${Math.max(0, Math.min(100, r.share ?? 0))}%` }} />
            </span>
            <span className="lab-pay-bar-figure">
              <span className="lab-pay-bar-count">{fmtCount(r.count, locale)}</span>
              <span className="lab-pay-bar-share">{r.share !== null ? fmtPercent(r.share, locale, 1) : ''}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
