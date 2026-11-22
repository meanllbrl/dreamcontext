import { useI18n } from '../../context/I18nContext';
import { fmtTokens } from './statsFormat';
import { stratumDiff, stratumLabel, superFoot, superWhy, windowNote } from './superEffectWords';
import type { StatsWire } from './statsTypes';

/**
 * "Super Agent token tüketimini artırıyor mu?" (super-cocuk-tasarruf D6), under the limit answer
 * card. The verdict word and the diff column carry the only good/warn ink.
 */
export function SuperEffectCard({ data }: { data: StatsWire }) {
  const { t } = useI18n();
  const e = data.dc.superEffect;
  if (!e) return null;
  const loading = data.scanning !== null && e.strata.length === 0 && e.verdict !== 'noSuper';
  const tone = e.verdict === 'reduces' ? 'good' : e.verdict === 'increases' ? 'warn' : undefined;
  return (
    <div className="st-card st-answer st-super" data-verdict={loading ? 'loading' : e.verdict} data-testid="stats-super-effect">
      <div className="st-k">{t('stats.super.q')}</div>
      {loading ? (
        <div className="st-answer-v"><span>{t('stats.super.loading')}</span></div>
      ) : (
        <div className="st-answer-v">
          <b data-tone={tone}>{t(`stats.super.${e.verdict}`)}</b>
          <span>{superWhy(e, t)}</span>
        </div>
      )}
      {!loading && e.strata.length > 0 && (
        <>
          <div className="st-super-sum">
            <span><em>{t('stats.super.withSuper')}</em><b>{fmtTokens(e.totals.super)}</b></span>
            {e.overhead.tokens > 0 && <span><em>{t('stats.super.overhead')}</em><b>+{fmtTokens(e.overhead.tokens)}</b></span>}
            <span><em>{t('stats.super.without')}</em><b>{fmtTokens(e.totals.plain)}</b></span>
          </div>
          <div className="st-tbl st-super-tbl" role="table">
            <div className="st-tr st-th" role="row">
              <span>{t('stats.super.kind')}</span><span>{t('stats.super.withSuper')}</span><span>{t('stats.super.without')}</span><span>{t('stats.super.diff')}</span>
            </div>
            {e.strata.map((s) => {
              const d = stratumDiff(s, t);
              const note = windowNote(s, t);
              return (
                <div className="st-tr" role="row" key={`${s.mode ?? '?'}|${s.model}`}>
                  <span className="nm nm2"><span>
                    <b>{stratumLabel(s, t)}</b>
                    <span className="dim">{t('stats.super.jobs').replace('{a}', String(s.superSessions)).replace('{b}', String(s.plainSessions))}{note ? ` · ${note}` : ''}</span>
                  </span></span>
                  <span className="num">{s.superMedian === null ? '—' : fmtTokens(s.superMedian)}</span>
                  <span className="num">{s.plainMedian === null ? '—' : fmtTokens(s.plainMedian)}</span>
                  <span className="num st-super-d" data-tone={d.tone ?? undefined}>{d.text}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {!loading && e.verdict !== 'noSuper' && superFoot(e, t).map((line) => <p className="st-foot" key={line}>{line}</p>)}
    </div>
  );
}
