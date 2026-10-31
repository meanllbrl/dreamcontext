import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { ChartLegend, StatsChart, type ChartSeries } from './StatsChart';
import { fmtCost, fmtDay, fmtPct, fmtTokens, fmtWhen } from './statsFormat';
import type { LimitWindow, SleepRun, StatsWire } from './statsTypes';

type T = (k: string) => string;

const projectsOf = (w: LimitWindow) => [...new Set(w.runs.map((r) => r.project))];

/** The owner's question in one line, for the top of every tab. */
export function answerLine(data: StatsWire, t: T): string {
  const a = data.dc.answer;
  const share = a.worst ? `~${fmtPct(a.worst.estSleepShare * 100)}` : '';
  if (a.verdict === 'none') return t('stats.answer.line.none');
  return t(`stats.answer.line.${a.verdict}`).replace('{n}', String(a.hits)).replace('{s}', share);
}

function LimitAnswerCard({ data }: { data: StatsWire }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const a = data.dc.answer;
  const w = a.worst;
  const shown = all ? a.windows : a.windows.slice(0, 4);
  return (
    <div className="st-card st-answer" data-verdict={a.verdict} data-testid="stats-answer">
      <div className="st-k">{t('stats.answer.q')}</div>
      <div className="st-answer-v">
        <b>{t(`stats.answer.${a.verdict}`)}</b>
        <span>{t(`stats.answer.${a.verdict}.why`).replace('{n}', String(a.hits)).replace('{s}', w ? `~${fmtPct(w.estSleepShare * 100)}` : '')}</span>
      </div>
      {a.twoProject > 0 && <p className="st-sub">{t('stats.answer.two').replace('{n}', String(a.twoProject))}</p>}
      {a.windows.length > 0 && (
        <div className="st-tbl st-wins" role="table">
          <div className="st-tr st-th" role="row"><span>{t('stats.answer.window')}</span><span>{t('stats.sleep')}</span><span>{t('stats.answer.shareOfSpend')} (~)</span><span /></div>
          {shown.map((x) => (
            <div className="st-tr" role="row" key={`${x.kind}${x.account}${x.start}`}>
              <span className="nm nm2"><span>
                <b>{fmtWhen(x.start)}{x.kind === 'weekly' ? ` · ${t('stats.weekly')}` : ''}</b>
                <span className="dim">{x.accountLabel} · {projectsOf(x).join(', ') || t('stats.sleep')}</span>
              </span></span>
              <span className="num">{fmtCost(x.sleepCost)} <span className="dim">/ {fmtCost(x.cost)}</span></span>
              <span className="shr"><i className="st-ghostbar" style={{ width: `${x.estSleepShare * 100}%` }} /><em>~{fmtPct(x.estSleepShare * 100)}</em></span>
              <span>{x.hit && <span className={`st-chip${x.thin ? '' : ' warn'}`} title={x.thin ? t('stats.answer.thin') : undefined}>{t('stats.answer.ranOut')}</span>}</span>
            </div>
          ))}
          {a.windows.length > shown.length && <button type="button" className="st-more" onClick={() => setAll(true)}>{t('stats.showAll').replace('{n}', String(a.windows.length))}</button>}
        </div>
      )}
      <p className="st-foot">{t('stats.answer.foot')}</p>
    </div>
  );
}

function SleepTable({ data, onRun }: { data: StatsWire; onRun: (r: SleepRun) => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<'run' | 'vault' | 'spec'>('run');
  const s = data.dc.sleep;
  const total = s.cost || 1;
  return (
    <div className="st-card">
      <div className="st-bh">
        <div className="st-k">{t('stats.sleep')}</div><span className="sp" />
        <div className="st-seg">{(['run', 'vault', 'spec'] as const).map((v) => <button type="button" key={v} data-on={view === v ? '' : undefined} onClick={() => setView(v)}>{t(`stats.sleepView.${v}`)}</button>)}</div>
      </div>
      {s.runs.length === 0 && <div className="st-none">{t('stats.noSleep')}</div>}
      {s.runs.length > 0 && view === 'run' && (
        <div className="st-tbl st-runs" role="table">
          <div className="st-tr st-th"><span>{t('stats.sleepView.one')}</span><span>{t('stats.tab.tokens')}</span><span>{t('stats.tab.cost')}</span><span>5h (~)</span></div>
          {s.runs.slice(0, 12).map((r) => (
            <button type="button" className="st-tr click" key={r.id} onClick={() => onRun(r)}>
              <span className="nm nm2"><span><b>{r.project}</b><span className="dim">{fmtWhen(r.start)} · {t(`stats.trigger.${r.trigger}`)}</span></span></span>
              <span className="num">{fmtTokens(r.tokens)}</span>
              <span className="num">{fmtCost(r.cost)}</span>
              <span className="num" data-warn={(r.estWindowShare ?? 0) > 0.25 ? '' : undefined}>{r.estWindowShare === null ? '—' : `~${fmtPct(r.estWindowShare * 100)}`}</span>
            </button>
          ))}
          {s.runs.length > 12 && <p className="st-foot">{t('stats.moreRuns').replace('{n}', String(s.runs.length - 12))}</p>}
        </div>
      )}
      {s.runs.length > 0 && view === 'vault' && (
        <div className="st-tbl" role="table">
          <div className="st-tr st-th"><span>{t('stats.vault')}</span><span>{t('stats.tab.cost')}</span><span>{t('stats.share')}</span><span>{t('stats.sleepView.run')}</span></div>
          {s.vaults.map((g) => (
            <div className="st-tr" key={g.key}>
              <span className="nm"><b>{g.label}</b></span><span className="num">{fmtCost(g.cost ?? 0)}</span>
              <span className="shr"><i data-sleep="" style={{ width: `${((g.cost ?? 0) / total) * 100}%` }} /><em>{fmtPct(((g.cost ?? 0) / total) * 100)}</em></span>
              <span className="num dim">{g.sub}</span>
            </div>
          ))}
        </div>
      )}
      {s.runs.length > 0 && view === 'spec' && (
        <>
          <div className="st-tbl" role="table">
            <div className="st-tr st-th"><span>{t('stats.specialist')}</span><span>{t('stats.tab.cost')}</span><span>{t('stats.share')}</span><span>{t('stats.tab.tokens')}</span></div>
            {s.specialists.map((g) => {
              const set = s.configured[g.name];
              return (
                <div className="st-tr" key={`${g.name}${g.model}`}>
                  <span className="nm nm2"><span><b className="mono">{g.name}</b><span className="dim">{g.model}{g.effort ? ` · ${g.effort}` : ''}{set?.model ? ` · ${t('stats.setTo')} ${set.model}` : ''}</span></span></span>
                  <span className="num">{fmtCost(g.cost)}</span>
                  <span className="shr"><i data-sleep="" style={{ width: `${(g.cost / total) * 100}%` }} /><em>{fmtPct((g.cost / total) * 100)}</em></span>
                  <span className="num dim">{fmtTokens(g.tokens)}</span>
                </div>
              );
            })}
          </div>
          <p className="st-foot">{t('stats.specFoot')}</p>
        </>
      )}
    </div>
  );
}

export function StatsDc({ data, onRun }: { data: StatsWire; onRun: (r: SleepRun) => void }) {
  const { t } = useI18n();
  const { dc } = data;
  const added = dc.memory.first + dc.memory.carried;
  const hasEco = dc.eco.estSaved > 0;
  const net = dc.eco.estSaved - added;
  const barMax = Math.max(dc.eco.estSaved, added, 1);
  const series: ChartSeries[] = [
    { name: t('stats.yourWork'), color: 'color-mix(in srgb, var(--chart-6) 70%, var(--color-bg-tertiary))', values: dc.chart.work },
    { name: t('stats.memoryAdds'), color: 'var(--chart-8)', values: dc.chart.memory },
    { name: t('stats.sleep'), color: 'var(--color-accent)', values: dc.chart.sleep },
    { name: t('stats.ecoGhost'), color: 'transparent', values: dc.chart.estSaved, ghost: true },
  ];
  const rangeLabel = data.range === '24h' ? t('stats.last24h') : t('stats.lastDays').replace('{n}', String(data.buckets.length));
  return (
    <div className="st-col">
      <LimitAnswerCard data={data} />
      <div className="st-kpis">
        <div className="st-card">
          <div className="st-k">{t('stats.sleep')}</div>
          <div className="st-big">{dc.estWeekShare === null ? fmtCost(dc.sleep.cost) : `~${fmtPct(dc.estWeekShare)}`}<small>{dc.estWeekShare === null ? t('stats.atApiPrice') : t('stats.ofWeek')}</small></div>
          <div className="st-sub">{dc.sleep.runs.length} {t('stats.sleepView.run').toLowerCase()} · {fmtTokens(dc.sleep.tokens)} {t('stats.tab.tokens').toLowerCase()} · {fmtCost(dc.sleep.cost)} · {fmtPct(dc.claudeTokens ? (dc.sleep.tokens / dc.claudeTokens) * 100 : 0)} {t('stats.ofClaude')}</div>
        </div>
        <div className="st-card">
          <div className="st-k">{t('stats.eco')}</div>
          <div className="st-big">~{fmtTokens(dc.eco.estSaved)}<small>{t('stats.tokensSaved')}</small></div>
          <div className="st-sub">{dc.eco.rows.length} {t('stats.handoffs')} · {fmtTokens(dc.eco.avgBefore)} → {fmtTokens(dc.eco.avgAfter)} · ~{fmtCost(dc.eco.estSavedCost)} {t('stats.atApiPrice')}</div>
        </div>
        <div className="st-card">
          <div className="st-k">{t('stats.memoryAdds')}</div>
          <div className="st-big">{fmtTokens(added)}<small>{t('stats.tokensLower')}</small></div>
          <div className="st-sub">{fmtTokens(dc.memory.first)} {t('stats.firstRead')} · {fmtTokens(dc.memory.carried)} {t('stats.carried')} · {dc.memory.starts} {t('stats.starts')}, {dc.memory.messages} {t('stats.messages')} · {fmtPct(dc.memory.inputShare * 100)} {t('stats.ofInput')}</div>
        </div>
        <div className="st-card">
          <div className="st-k">{t('stats.balance')}</div>
          {hasEco
            ? <div className="st-big" data-good={net >= 0 ? '' : undefined}>{net >= 0 ? `~${fmtTokens(net)}` : `~${fmtTokens(-net)}`}<small>{net >= 0 ? t('stats.fewerTokens') : t('stats.moreTokens')}</small></div>
            : <div className="st-big">—</div>}
          <div className="st-bal">
            <div><span>{t('stats.saved')}</span><i className="st-ghostbar" style={{ width: `${(dc.eco.estSaved / barMax) * 100}%` }} /></div>
            <div><span>{t('stats.added')}</span><i className="a" style={{ width: `${(added / barMax) * 100}%` }} /></div>
          </div>
        </div>
      </div>
      <div className="st-card">
        <div className="st-ch">
          <div><div className="st-k">{t('stats.claudeTokens')} · {rangeLabel}</div><div className="st-big">{fmtTokens(dc.claudeTokens)}</div></div>
          <ChartLegend series={series} format={fmtTokens} />
        </div>
        <StatsChart buckets={data.buckets} hourly={data.hourly} series={series} format={fmtTokens} />
      </div>
      <div className="st-grid2">
        <SleepTable data={data} onRun={onRun} />
        <div className="st-card">
          <div className="st-bh"><div className="st-k">{t('stats.eco')}</div><span className="sp" /><span className="dim st-sm">{t('stats.beforeAfter')}</span></div>
          {dc.eco.rows.length === 0 && <div className="st-none">{t('stats.noHandoffs')}</div>}
          <div className="st-tbl st-eco">
            {dc.eco.rows.slice(0, 9).map((e) => (
              <div className="st-tr" key={`${e.at}${e.title}`}>
                <span className="nm nm2"><span><b>{e.title || e.project}</b><span className="dim">{e.project} · {fmtDay(e.at)} · {t(`stats.ecoKind.${e.kind}`)}</span></span></span>
                <span className="num">{fmtTokens(e.before)} → {e.after === null ? '—' : fmtTokens(e.after)}</span>
                <span className="num good">{e.estSaved > 0 ? `~${fmtTokens(e.estSaved)}` : '—'}</span>
              </div>
            ))}
          </div>
          {dc.eco.rows.length > 0 && <p className="st-foot">{t('stats.ecoFoot').replace('{n}', String(dc.eco.turns))}</p>}
        </div>
      </div>
      <p className="st-foot st-center">{t('stats.dcFoot')}</p>
    </div>
  );
}
