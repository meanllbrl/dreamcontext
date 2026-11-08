import { useId, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { scaleFor, shortLabel, useChartWidth } from './StatsChart';
import { fmtCost, fmtDay } from './statsFormat';
import { ecoCover, ecoStartAt, topEaters, trendBuckets, type EatenItem } from './statsCharts';
import type { StatsWire } from './statsTypes';

const H = 196;
const LEFT = 46;
const BOTTOM = 22;
const TOP = 8;
const SLEEP = 'var(--color-accent)';

export const fmtNet = (v: number): string => `~ ${v < 0 ? '−' : '+'}${fmtCost(Math.abs(v))}`;

function Legend() {
  const { t } = useI18n();
  return (
    <div className="st-leg">
      <span><i style={{ background: SLEEP }} />{t('stats.sleep')}</span>
      <span><i className="st-memkey" />{t('stats.charts.memory')}</span>
      <span><i className="st-ghost" />{t('stats.charts.saved')}</span>
    </div>
  );
}

function EatenLine({ item, max, partial, open, onOpen }: { item: EatenItem; max: number; partial: boolean; open: boolean; onOpen: (on: boolean) => void }) {
  const { t } = useI18n();
  const eaten = item.sleep + item.memory;
  const pct = (v: number) => `${(v / max) * 100}%`;
  return (
    <div className="st-pline" data-testid="stats-chart-line" onMouseEnter={() => onOpen(true)} onMouseLeave={() => onOpen(false)} onClick={() => onOpen(!open)}>
      <span className="st-pname" title={item.label}>{item.others ? t('stats.charts.other').replace('{n}', String(item.others)) : item.label}</span>
      <span className="st-pbars">
        <span className="st-pbar">
          <span className="st-ptrack">
            {item.sleep > 0 && <i style={{ width: pct(item.sleep), background: SLEEP }} />}
            {item.memory > 0 && <i className="st-pmem" style={{ width: pct(item.memory) }} />}
          </span>
          <em>~{fmtCost(eaten)}</em>
        </span>
        <span className="st-pbar">
          <span className="st-ptrack">{item.saved > 0 && <i className="st-ghostbar" style={{ width: pct(item.saved) }} />}</span>
          <em>{item.saved > 0 ? `~${fmtCost(item.saved)}` : '—'}</em>
        </span>
      </span>
      <b className={`st-netpill ${item.net < 0 ? 'down' : 'up'}`}>{partial ? '≥ ' : ''}{fmtNet(item.net)}</b>
      {open && (
        <div className="st-tip st-ptip">
          <b>{item.others ? t('stats.charts.other').replace('{n}', String(item.others)) : item.label}</b>
          <div>{t('stats.projects.prompts')}<span>{item.prompts === null ? '—' : item.prompts.toLocaleString('en-US')}</span></div>
          <div>{t('stats.charts.spend')}<span>{fmtCost(item.spend)}</span></div>
          <div>{t('stats.sleep')}<span>{fmtCost(item.sleep)}</span></div>
          <div>{t('stats.charts.memory')}<span>~{fmtCost(item.memory)}</span></div>
          <div>{t('stats.charts.saved')}<span>{item.saved > 0 ? `~${fmtCost(item.saved)}` : '—'}</span></div>
        </div>
      )}
    </div>
  );
}

function ProjectsChart({ data }: { data: StatsWire }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const items = topEaters(data.dc.projects);
  const max = Math.max(...items.map((i) => Math.max(i.sleep + i.memory, i.saved)), 1e-9);
  return (
    <div className="st-pchart" data-testid="stats-chart-projects">
      <div className="st-ch"><div className="st-k">{t('stats.charts.byProject')}</div><Legend /></div>
      {items.length === 0 && <div className="st-none">{t('stats.charts.nothing')}</div>}
      {items.map((i) => <EatenLine key={i.key} item={i} max={max} partial={data.dc.ecoPartial} open={open === i.key} onOpen={(on) => setOpen(on ? i.key : null)} />)}
    </div>
  );
}

function TrendChart({ data }: { data: StatsWire }) {
  const { t } = useI18n();
  const hatch = useId();
  const { host, width } = useChartWidth();
  const [hoverAt, setHover] = useState<number | null>(null);
  const weekly = data.range === '90d';
  const bars = trendBuckets(data.buckets, data.dc.trend, weekly);
  const n = bars.length;
  // A range change shortens the bars under a resting pointer.
  const hover = hoverAt !== null && hoverAt < n ? hoverAt : null;
  const eatenOf = (i: number) => bars[i].sleep + bars[i].memory;
  const max = Math.max(...bars.map((b) => Math.max(b.sleep + b.memory, b.saved)), 1e-9);
  const { top, ticks } = scaleFor(max);
  const y = (v: number) => TOP + (H - TOP - BOTTOM) * (1 - v / top);
  const gap = (width - LEFT - 4) / n;
  const bar = Math.max(2, Math.min(13, (gap - 2) * 0.42));
  const start = ecoStartAt(bars, data.dc.ecoFrom);
  const startX = start === null ? null : LEFT + 2 + gap * start;
  const fromLabel = data.dc.ecoFrom === null ? '' : t('stats.charts.ecoStart').replace('{d}', fmtDay(data.dc.ecoFrom));
  const cover = hover === null ? 'none' : ecoCover(bars[hover], data.dc.ecoFrom);
  const savedAt = (i: number) => {
    // A bucket the record starts inside keeps its saved bar on the measured side of the mark.
    const x = LEFT + 2 + gap * i + (gap - bar * 2 - 1) / 2 + bar + 1;
    if (startX === null || x >= startX + 1 || ecoCover(bars[i], data.dc.ecoFrom) !== 'part') return { x, w: bar };
    return { x: startX + 1, w: Math.min(bar, Math.max(3, LEFT + 2 + gap * (i + 1) - startX - 1)) };
  };
  const empty = bars.every((b) => b.sleep + b.memory + b.saved < 0.005);
  const tipLeft = hover === null ? 0 : Math.max(0, Math.min(width - 190, LEFT + gap * hover + gap / 2 - 95));
  return (
    <div className="st-pchart" data-testid="stats-chart-trend">
      <div className="st-ch"><div className="st-k">{t(weekly ? 'stats.charts.byWeek' : data.hourly ? 'stats.charts.byHour' : 'stats.charts.byDay')}</div><Legend /></div>
      <div className="st-chart" ref={host} onMouseLeave={() => setHover(null)}>
        <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={t('stats.charts.trendAria')}>
          <defs><pattern id={hatch} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" className="st-hatch" /></pattern></defs>
          {ticks.map((v) => (
            <g key={v}>
              <line className="st-grid" x1={LEFT} x2={width} y1={y(v)} y2={y(v)} />
              <text className="st-ax" x={LEFT - 6} y={y(v) + 3.5} textAnchor="end">{fmtCost(v)}</text>
            </g>
          ))}
          {startX !== null && startX > LEFT + 2 && <rect x={LEFT + 2} y={TOP} width={startX - LEFT - 2} height={H - TOP - BOTTOM} fill={`url(#${hatch})`} data-testid="stats-unmeasured" />}
          {startX !== null && startX - LEFT > 84 && <text className="st-ax st-unm" x={LEFT + 8} y={TOP + (startX - LEFT < 240 ? 28 : 13)}>{t('stats.charts.notMeasured')}</text>}
          {bars.map((b, i) => {
            const x = LEFT + 2 + gap * i + (gap - bar * 2 - 1) / 2;
            const label = shortLabel(b.start, i, n, data.hourly);
            return (
              <g key={b.start}>
                {b.sleep > 0 && <rect x={x} y={y(b.sleep)} width={bar} height={Math.max(1.5, y(0) - y(b.sleep))} rx={Math.min(2, bar / 3)} style={{ fill: SLEEP }} />}
                {b.memory > 0 && <rect x={x} y={y(eatenOf(i))} width={bar} height={Math.max(1.5, y(b.sleep) - y(eatenOf(i)))} rx={Math.min(2, bar / 3)} className="st-soft" style={{ fill: 'color-mix(in srgb, var(--chart-8) 30%, transparent)' }} />}
                {b.saved > 0 && <rect x={savedAt(i).x} y={y(b.saved)} width={savedAt(i).w} height={Math.max(2, y(0) - y(b.saved))} rx={Math.min(2, bar / 3)} className="st-ghost" />}
                {label && <text className="st-ax" x={x + bar + 16 > width ? width - 1 : x + bar} y={H - 6} textAnchor={x + bar + 16 > width ? 'end' : 'middle'}>{label}</text>}
                <rect className="st-hit" x={LEFT + gap * i} y={TOP} width={gap} height={H - TOP - BOTTOM} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
              </g>
            );
          })}
          {startX !== null && start !== null && start < n && (
            <g data-testid="stats-eco-start">
              <line className="st-ecoline" x1={startX} x2={startX} y1={TOP} y2={H - BOTTOM} />
              <text className="st-ax st-ecotext" x={startX + (startX > width * 0.62 ? -5 : 5)} y={TOP + 13} textAnchor={startX > width * 0.62 ? 'end' : 'start'}>{fromLabel}</text>
            </g>
          )}
        </svg>
        {empty && <div className="st-chartnote">{t('stats.charts.nothing')}</div>}
        {hover !== null && (
          <div className="st-tip" style={{ left: tipLeft }}>
            <b>{weekly ? `${fmtDay(bars[hover].start)} – ${fmtDay(bars[hover].end - 1)}` : data.hourly ? `${fmtDay(bars[hover].start)} ${String(new Date(bars[hover].start).getHours()).padStart(2, '0')}:00` : fmtDay(bars[hover].start)}</b>
            <div>{t('stats.sleep')}<span>{fmtCost(bars[hover].sleep)}</span></div>
            <div>{t('stats.charts.memory')}<span>~{fmtCost(bars[hover].memory)}</span></div>
            <div>{t('stats.charts.saved')}<span>{cover === 'none' || (cover === 'part' && bars[hover].saved <= 0) ? t('stats.charts.notMeasured') : `${cover === 'part' ? '≥ ' : ''}~${fmtCost(bars[hover].saved)}`}</span></div>
            {cover !== 'none' && <div className="tt">{t('stats.projects.net')}<span>{cover === 'part' ? '≥ ' : ''}{fmtNet(bars[hover].saved - eatenOf(hover))}</span></div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** What the table below says, to be read at a glance first. */
export function StatsProjectCharts({ data }: { data: StatsWire }) {
  return (
    <div className="st-pcharts">
      <ProjectsChart data={data} />
      <TrendChart data={data} />
    </div>
  );
}
