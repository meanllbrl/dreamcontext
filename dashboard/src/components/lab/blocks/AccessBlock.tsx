import { useI18n } from '../../../context/I18nContext';
import { accessView, type Selection } from '../../../generated/frameOps';
import { fill, fmtCount, fmtPercent, formatDay, formatRateOrKn, hintLine, rateAttrs } from '../explorer/explorerFormat';
import '../explorer/explorer.css';
import { BlockEmpty, drawableFrame, stringOption, type BlockViewProps } from './blockCommon';
import { selectionLabel, unknownFunnelPick } from './BreakdownBlock';

/**
 * `access`: did the people who paid reach the product, stage by stage
 * (accessView). One row per access row that matches the funnel and the
 * selection; each stage is its users and its share of the row's base (the
 * first stage), or k/n when the base is under 100. A stage the source did not
 * measure reads "Not measured", never 0.
 *
 * With no access data the explorer preset hides this tab altogether; drawn on
 * its own, the block says what is missing and how to fill it.
 */

export function AccessBlock({ frame, options, selection }: BlockViewProps) {
  const { t, locale } = useI18n();
  const drawable = drawableFrame(frame, ['funnel'] as const);
  if ('empty' in drawable) return <div className="lab-block-fill"><BlockEmpty reason={drawable.empty} /></div>;
  const f = drawable.frame;
  if (f.funnels.length === 0) return <BlockEmpty />;

  const pick = stringOption(options, 'funnel');
  const funnelId = unknownFunnelPick(f, pick) ? null : pick;
  const funnel = f.funnels.find((x) => x.id === funnelId) ?? f.funnels[0];
  const sel: Selection = selection ?? {};
  const view = accessView(f, funnel.id, sel);
  const density = options.density === 'comfortable' ? 'comfortable' : 'compact';

  if (!view || view.rows.length === 0) {
    const hint = hintLine(t, f, 'access');
    return (
      <div className="lab-block-fill lab-acc" data-lab-access="">
        <div className="lab-x-empty" data-lab-empty="access">
          <span>{t('lab.explorer.emptyAccess')}</span>
          {hint && <span className="lab-x-empty-hint" data-lab-hint="">{hint}</span>}
        </div>
      </div>
    );
  }

  const dimOrder = (f.dimensions ?? []).map((d) => d.key);
  const rowLabel = (r: (typeof view.rows)[number]) => {
    const name = r.funnel ? f.funnels.find((x) => x.id === r.funnel)?.name ?? r.funnel : t('lab.blocks.breakdown.all');
    const dims = selectionLabel(r.dims, dimOrder);
    return dims ? `${name} · ${dims}` : name;
  };
  const baseLabel = view.stages[0]?.label ?? '';

  return (
    <div className="lab-block-fill lab-acc" data-lab-access="">
      {view.asOf && (
        <div className="lab-x-note" data-lab-access-asof={view.asOf}>
          {fill(t('lab.explorer.accessAsOf'), { date: formatDay(view.asOf.slice(0, 10), locale) })}
        </div>
      )}
      <div className="lab-x-table-wrap">
        <table className="lab-x-table" data-density={density}>
          <thead>
            <tr>
              <th scope="col">{t('lab.explorer.picker')}</th>
              {view.stages.map((s) => <th key={s.key} scope="col">{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r, i) => (
              <tr key={`${r.funnel ?? ''}|${JSON.stringify(r.dims)}|${i}`} data-lab-access-row={r.funnel ?? 'all'}>
                <td>{rowLabel(r)}</td>
                {r.cells.map((c, ci) => {
                  if (c.users === null) {
                    return (
                      <td key={c.key} data-stage={c.key}>
                        <span className="lab-x-unmeasured" data-lab-not-measured="">{t('lab.explorer.notMeasured')}</span>
                      </td>
                    );
                  }
                  const share = ci === 0 ? null : formatRateOrKn(c.ofBase, 'pct', c.kn, locale, t);
                  const width = c.ofBase === null ? 0 : Math.max(0, Math.min(100, c.ofBase));
                  // The base stage is its count; every later stage reads "{stage}: %75,0 (1.500/2.000)", or k/n on a small base.
                  const phrase = share && share.text && !share.kn && c.kn
                    ? fill(t('lab.explorer.accessOfBase'), { stage: c.label, pct: fmtPercent(c.ofBase, locale, 1), k: fmtCount(c.kn.k, locale), n: fmtCount(c.kn.n, locale) })
                    : share?.text ?? '';
                  return (
                    <td key={c.key} data-stage={c.key}>
                      <span className="lab-acc-stage">
                        {ci === 0 || !phrase
                          ? <span className="lab-x-num">{fmtCount(c.users, locale)}</span>
                          : (
                            <span className="lab-x-num" {...rateAttrs(share!)} data-lab-access-share="" title={share!.title ?? `${baseLabel}: ${fmtCount(r.base, locale)}`}>
                              {phrase}
                            </span>
                          )}
                        <span className="lab-x-track" aria-hidden="true">
                          <span className="lab-x-fill" style={{ width: `${ci === 0 ? 100 : width}%` }} />
                        </span>
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
