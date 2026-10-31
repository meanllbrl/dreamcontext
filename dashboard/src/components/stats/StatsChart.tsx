import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { fmtDay } from './statsFormat';

/** `ghost`: an estimate outside the totals. `soft`: an estimate of a part of a total, so it stacks
 *  and counts, and is still drawn dashed with its `~`. */
export interface ChartSeries { name: string; color: string; values: number[]; ghost?: boolean; soft?: boolean; unpriced?: boolean }

/** The dashed bar every estimate carries. */
export function GhostBar({ share }: { share: number }) {
  return <i className="st-ghostbar st-ghostline" style={{ width: `${Math.max(2, Math.min(100, share * 100))}%` }} />;
}

interface Props {
  buckets: Array<{ start: number }>;
  hourly: boolean;
  series: ChartSeries[];
  format: (v: number) => string;
}

const H = 196;
const LEFT = 46;
const BOTTOM = 22;
const TOP = 8;

function shortLabel(ms: number, i: number, n: number, hourly: boolean): string {
  const d = new Date(ms);
  if (hourly) return d.getHours() % 6 === 0 ? String(d.getHours()).padStart(2, '0') : '';
  if (n <= 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return i % Math.ceil(n / 6) === 0 ? fmtDay(ms) : '';
}

/** T3's hand-drawn stacked bars. A ghost series stacks on top with a dashed edge and stays out of "Total". */
export function StatsChart({ buckets, hourly, series, format }: Props) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = buckets.length;
  const stack = buckets.map((_, i) => series.reduce((a, s) => a + s.values[i], 0));
  const max = Math.max(...stack, 1e-9);
  const step = [1, 2, 2.5, 5, 10].map((x) => x * 10 ** Math.floor(Math.log10(max / 4))).find((x) => max / x <= 4.2) ?? max / 4;
  const top = Math.ceil(max / step) * step;
  const y = (v: number) => TOP + (H - TOP - BOTTOM) * (1 - v / top);
  const gap = (width - LEFT - 4) / n;
  const bar = Math.max(2, Math.min(28, gap * 0.66));
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);

  const hovered = hover === null ? [] : series.filter((s) => s.values[hover] > 0);
  const tipLeft = hover === null ? 0 : Math.max(0, Math.min(width - 190, LEFT + gap * hover + gap / 2 - 95));

  return (
    <div className="st-chart" ref={host} onMouseLeave={() => setHover(null)} data-testid="stats-chart">
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={t('stats.chart.aria')}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="st-grid" x1={LEFT} x2={width} y1={y(v)} y2={y(v)} />
            <text className="st-ax" x={LEFT - 6} y={y(v) + 3.5} textAnchor="end">{format(v)}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = LEFT + 2 + gap * i + (gap - bar) / 2;
          let acc = 0;
          const label = shortLabel(b.start, i, n, hourly);
          return (
            <g key={b.start}>
              {series.map((s) => {
                const v = s.values[i];
                if (v <= 0) return null;
                const from = acc;
                acc += v;
                return (
                  <rect
                    key={s.name} x={x} y={y(acc)} width={bar} height={Math.max(0.5, y(from) - y(acc))} rx={Math.min(3, bar / 4)}
                    className={s.ghost ? 'st-ghost' : s.soft ? 'st-soft' : undefined} style={s.ghost ? undefined : { fill: s.color }}
                    data-ghost={s.ghost ? '' : undefined}
                  />
                );
              })}
              {label && <text className="st-ax" x={x + bar / 2} y={H - 6} textAnchor="middle">{label}</text>}
              <rect className="st-hit" x={LEFT + gap * i} y={TOP} width={gap} height={H - TOP - BOTTOM} onMouseEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="st-tip" style={{ left: tipLeft }}>
          <b>{hourly ? `${fmtDay(buckets[hover].start)} ${String(new Date(buckets[hover].start).getHours()).padStart(2, '0')}:00` : fmtDay(buckets[hover].start)}</b>
          {hovered.map((s) => (
            <div key={s.name}><i style={s.ghost ? undefined : { background: s.color }} className={s.ghost ? 'gh' : undefined} />{s.name}<span>{s.ghost || s.soft ? '~' : ''}{format(s.values[hover])}</span></div>
          ))}
          {hovered.length > 1 && (
            <div className="tt"><i />{t('stats.total')}<span>{format(series.filter((s) => !s.ghost).reduce((a, s) => a + s.values[hover], 0))}</span></div>
          )}
          {hovered.length === 0 && <div>{t('stats.nothingUsed')}</div>}
        </div>
      )}
    </div>
  );
}

export function ChartLegend({ series, format }: { series: ChartSeries[]; format: (v: number) => string }) {
  const { t } = useI18n();
  return (
    <div className="st-leg">
      {series.map((s) => (
        <span key={s.name}>
          <i style={s.ghost ? undefined : { background: s.color }} className={s.ghost ? 'st-ghost' : undefined} />
          {s.name}<b>{s.unpriced ? t('stats.unpriced') : `${s.ghost || s.soft ? '~' : ''}${format(s.values.reduce((a, b) => a + b, 0))}`}</b>
        </span>
      ))}
    </div>
  );
}
