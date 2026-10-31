import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { ChartLegend, StatsChart, type ChartSeries } from './StatsChart';
import { fmtCost, fmtDay, fmtPct, fmtTokens } from './statsFormat';
import { TOOL_COLOR, type SpendRow, type StatsTab, type StatsWire } from './statsTypes';
import { answerLine } from './StatsDc';

function ShareBar({ title, parts }: { title: string; parts: Array<[string, number, string]> }) {
  const total = parts.reduce((a, p) => a + p[1], 0) || 1;
  return (
    <div className="st-sh">
      <div className="st-sh-h">{title}</div>
      <div className="st-shbar">{parts.filter((p) => p[1] > 0).map((p) => <i key={p[0]} style={{ width: `${(p[1] / total) * 100}%`, background: p[2] }} title={`${p[0]} ${fmtPct((p[1] / total) * 100)}`} />)}</div>
      <div className="st-shl">{parts.map((p) => <span key={p[0]}><i style={{ background: p[2] }} />{p[0]}<b>{fmtPct((p[1] / total) * 100)}</b></span>)}</div>
    </div>
  );
}

type View = 'model' | 'account' | 'project' | 'time';

export function StatsSpend({ data, tab, onTab, onModel }: { data: StatsWire; tab: StatsTab; onTab: (t: StatsTab) => void; onModel: (r: SpendRow) => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<View>('model');
  const isCost = tab === 'cost';
  const fmt = isCost ? fmtCost : fmtTokens;
  const series: ChartSeries[] = data.tools.filter((x) => x.counted && data.series[x.id]).map((x) => ({
    name: x.name, color: TOOL_COLOR[x.id] ?? 'var(--chart-6)', values: isCost ? data.series[x.id].cost : data.series[x.id].tokens,
  }));
  const tot = data.totals;
  const notCounted = data.tools.filter((x) => !x.counted);
  const rangeLabel = data.range === '24h' ? t('stats.last24h') : t('stats.lastDays').replace('{n}', String(data.buckets.length));

  const rows: Array<SpendRow & { timeLabel?: string }> = view === 'time'
    ? data.buckets.map((b, i) => ({
      key: String(b.start), label: data.hourly ? `${fmtDay(b.start)} ${String(new Date(b.start).getHours()).padStart(2, '0')}:00` : fmtDay(b.start), tool: null,
      tokens: Object.values(data.series).reduce((a, s) => a + s.tokens[i], 0), cost: Object.values(data.series).reduce((a, s) => a + s.cost[i], 0),
    })).reverse()
    : [...data.breakdown[view]].sort((a, b) => (isCost ? (b.cost ?? 0) - (a.cost ?? 0) : b.tokens - a.tokens));
  const value = (r: SpendRow) => (isCost ? r.cost ?? 0 : r.tokens);
  const total = rows.reduce((a, r) => a + value(r), 0) || 1;

  return (
    <div className="st-col">
      <button type="button" className="st-dcline" onClick={() => onTab('dc')}>
        <span className="st-dcline-text">{answerLine(data, t)}</span><span className="sp" /><span className="go">dreamcontext ›</span>
      </button>
      <div className="st-card">
        <div className="st-ch">
          <div>
            <div className="st-k">{isCost ? t('stats.tab.cost') : t('stats.tab.tokens')} · {rangeLabel}</div>
            <div className="st-big">{isCost ? fmtCost(tot.cost) : fmtTokens(tot.tokens)}</div>
          </div>
          <ChartLegend series={series} format={fmt} />
        </div>
        <StatsChart buckets={data.buckets} hourly={data.hourly} series={series} format={fmt} />
        {notCounted.length > 0 && <p className="st-foot">{notCounted.map((x) => x.name).join(', ')}: {t('stats.notCounted')}</p>}
      </div>
      <div className="st-grid2">
        <div className="st-card">
          <div className="st-k">{t('stats.totals')}</div>
          <dl className="st-kv">
            <dt>{t('stats.processed')}</dt><dd>{fmtTokens(tot.tokens)}</dd>
            <dt>{t('stats.cachedInput')}</dt><dd>{fmtTokens(tot.cacheRead)}</dd>
            <dt>{t('stats.uncachedInput')}</dt><dd>{fmtTokens(tot.input + tot.cacheWrite)}</dd>
            <dt>{t('stats.output')}</dt><dd>{fmtTokens(tot.output)}</dd>
            <dt>{t('stats.tab.cost')}</dt><dd>{fmtCost(tot.cost)}</dd>
            <dt className="good">{t('stats.cacheSavings')}</dt><dd className="good">{fmtCost(tot.cacheSavings)}</dd>
          </dl>
          <ShareBar title={t('stats.tokensByType')} parts={[[t('stats.cachedInput'), tot.cacheRead, 'var(--chart-8)'], [t('stats.uncached'), tot.input, 'var(--chart-2)'], [t('stats.cacheWrite'), tot.cacheWrite, 'var(--color-accent)'], [t('stats.output'), tot.output, 'var(--chart-5)']]} />
          <ShareBar title={t('stats.costByType')} parts={[[t('stats.input'), tot.costParts[0], 'var(--chart-2)'], [t('stats.cacheRead'), tot.costParts[1], 'var(--chart-8)'], [t('stats.cacheWrite'), tot.costParts[2], 'var(--color-accent)'], [t('stats.output'), tot.costParts[3], 'var(--chart-5)']]} />
          {tot.hasFast && <ShareBar title={t('stats.costBySpeed')} parts={[[t('stats.standard'), tot.cost - tot.fastCost, 'var(--chart-6)'], [t('stats.fast'), tot.fastCost, 'var(--chart-7)']]} />}
          <p className="st-foot">{t('stats.apiPrices')}{data.unpriced.length > 0 && ` ${data.unpriced.join(', ')}: ${t('stats.noPrice')}`}</p>
        </div>
        <div className="st-card">
          <div className="st-bh">
            <div className="st-k">{t('stats.breakdown')}</div><span className="sp" />
            <div className="st-seg">{(['model', 'account', 'project', 'time'] as View[]).map((v) => <button type="button" key={v} data-on={view === v ? '' : undefined} onClick={() => setView(v)}>{t(`stats.view.${v}`)}</button>)}</div>
          </div>
          <div className="st-tbl" role="table">
            <div className="st-tr st-th" role="row"><span>{t(`stats.view.${view}`)}</span><span>{isCost ? t('stats.tab.cost') : t('stats.tab.tokens')}</span><span>{t('stats.share')}</span><span>{isCost ? t('stats.tab.tokens') : t('stats.tab.cost')}</span></div>
            {rows.length === 0 && <div className="st-none">{t('stats.nothingUsed')}</div>}
            {rows.map((r) => {
              const unpriced = view === 'model' && r.priceSource === 'none';
              const clickable = view === 'model';
              const body = (
                <>
                  <span className="nm">
                    {r.tool && <i className="st-dot" style={{ background: TOOL_COLOR[r.tool] }} />}
                    <b>{r.label}</b>{r.sub && <span className="dim">{r.sub}</span>}
                    {unpriced && <span className="st-chip warn">{t('stats.unpriced')}</span>}
                    {view === 'model' && r.priceSource === 'yours' && <span className="st-chip">{t('stats.yourPrice')}</span>}
                  </span>
                  <span className="num">{isCost ? (r.cost === null ? '—' : fmtCost(r.cost)) : fmtTokens(r.tokens)}</span>
                  <span className="shr"><i style={{ width: `${(value(r) / total) * 100}%` }} /><em>{fmtPct((value(r) / total) * 100)}</em></span>
                  <span className="num dim">{isCost ? fmtTokens(r.tokens) : (r.cost === null ? '—' : fmtCost(r.cost))}</span>
                </>
              );
              return clickable
                ? <button type="button" key={r.key} className="st-tr click" role="row" onClick={() => onModel(r)}>{body}</button>
                : <div key={r.key} className="st-tr" role="row">{body}</div>;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
