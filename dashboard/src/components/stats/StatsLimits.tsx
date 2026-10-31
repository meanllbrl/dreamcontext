import { useI18n } from '../../context/I18nContext';
import { fmtClock, fmtIn, fmtPct } from './statsFormat';
import { TOOL_COLOR, type StatsWire, type ToolAccount, type ToolLimits, type ToolWindow } from './statsTypes';

type Row = { a: ToolAccount; w: ToolWindow };

const KIND_ORDER = ['session', 'weekly', 'monthly'];

/** T3's pooled limits: several accounts are one bar, one part per account, soonest reset first. */
function PooledWindow({ tool, kind, rows, now }: { tool: ToolLimits; kind: string; rows: Row[]; now: number }) {
  const { t } = useI18n();
  const live = rows.filter((r) => r.w.resetsAt === null || r.w.resetsAt > now)
    .sort((x, y) => (x.w.resetsAt ?? Infinity) - (y.w.resetsAt ?? Infinity));
  if (live.length === 0) return null;
  const used = live.reduce((a, r) => a + r.w.usedPercent, 0) / live.length;
  const paced = live.filter((r) => r.w.resetsAt !== null && r.w.durationMins);
  const pace = paced.length
    ? paced.reduce((a, r) => a + (1 - ((r.w.resetsAt as number) - now) / ((r.w.durationMins as number) * 60_000)), 0) / paced.length * 100
    : null;
  const next = live[0];
  const title = live[0].w.label || kind;
  const accent = TOOL_COLOR[tool.id];
  return (
    <div className="st-win" data-testid={`stats-limit-${tool.id}-${kind}`}>
      <div className="st-wh"><b>{title}</b><span className="dim">{live.length > 1 ? t('stats.pooled').replace('{n}', String(live.length)) : live[0].a.label}</span><span className="sp" /><b className="num">{fmtPct(used)} {t('stats.used')}</b></div>
      <div className="st-pool">
        {live.map(({ a, w }) => (
          <div className="st-seg-bar" key={a.id} title={`${a.label} · ${fmtPct(w.usedPercent)}`}>
            <i data-hot={w.usedPercent >= 85 ? '' : undefined} style={{ width: `${Math.min(100, w.usedPercent)}%`, background: accent }}>
              {w.estSleepPercent !== null && w.estSleepPercent > 0.5 && w.usedPercent > 0 && <em className="st-slp" style={{ width: `${Math.min(100, (w.estSleepPercent / w.usedPercent) * 100)}%` }} />}
            </i>
          </div>
        ))}
        {pace !== null && <span className="st-pace" style={{ left: `${Math.max(0, Math.min(100, pace))}%` }} title={t('stats.evenPace')} />}
      </div>
      <div className="st-accs">
        {live.map(({ a, w }) => (
          <div className="st-acc" key={a.id}>
            <span className="mono">{a.label}</span>{a.plan && <span className="dim">{a.plan}</span>}<span className="sp" />
            <span>{fmtPct(w.usedPercent)}</span>
            {w.resetsAt !== null && <span className="dim">{t('stats.resetsIn')} {fmtIn(w.resetsAt - now)}</span>}
            {w.estSleepPercent !== null && w.estSleepPercent >= 0.5 && <span className="st-chip acc">{t('stats.sleep')} ~{fmtPct(w.estSleepPercent)}</span>}
          </div>
        ))}
      </div>
      <div className="st-back">
        {next.w.resetsAt !== null && <>{t('stats.nextReset')} <b>{next.a.label}</b> {t('stats.getsBack').replace('{p}', fmtPct(next.w.usedPercent)).replace('{t}', fmtIn(next.w.resetsAt - now))} </>}
        {pace !== null && (used > pace ? <span className="warn">{t('stats.aheadPace')}</span> : t('stats.belowPace'))}
      </div>
    </div>
  );
}

export function StatsLimits({ data, off }: { data: StatsWire; off: Set<string> }) {
  const { t } = useI18n();
  const now = Date.now();
  return (
    <div className="st-col">
      {data.limits.filter((tool) => !off.has(tool.id)).map((tool) => {
        const accounts = tool.accounts.filter((a) => !off.has(`${tool.id}:${a.id}`));
        const kinds = [...new Set(accounts.flatMap((a) => a.windows.map((w) => w.kind)))]
          .sort((a, b) => (KIND_ORDER.indexOf(a) + 1 || 9) - (KIND_ORDER.indexOf(b) + 1 || 9));
        const oldest = accounts.flatMap((a) => (a.fetchedAt ? [a.fetchedAt] : [])).sort((a, b) => a - b)[0];
        const hasSleep = accounts.some((a) => a.windows.some((w) => (w.estSleepPercent ?? 0) >= 0.5));
        return (
          <div className="st-card st-lim" key={tool.id}>
            <div className="st-lh">
              <i className="st-dot" style={{ background: TOOL_COLOR[tool.id] }} /><b>{tool.name}</b>
              <span className="dim">{t('stats.accountsSorted').replace('{n}', String(accounts.length))}</span>
              <span className="sp" />
              {hasSleep && <span className="st-lgd"><i className="st-slp" />{t('stats.sleep')} (~)</span>}
              <span className="st-lgd"><i className="pc" />{t('stats.evenPace')}</span>
            </div>
            {kinds.map((k) => (
              <PooledWindow key={k} tool={tool} kind={k} now={now} rows={accounts.flatMap((a) => a.windows.filter((w) => w.kind === k).map((w) => ({ a, w })))} />
            ))}
            {kinds.length === 0 && <p className="st-foot">{t('stats.noReading')}</p>}
            {oldest && <p className="st-foot">{t('stats.oldestReading')} {fmtClock(oldest)}.</p>}
          </div>
        );
      })}
      {data.notCounted.map((x) => (
        <div className="st-card st-lim" key={x.id}>
          <div className="st-lh"><b>{x.name}</b><span className="st-chip warn">{t('stats.notCountedChip')}</span></div>
        </div>
      ))}
      <p className="st-foot st-center">{t('stats.limitsFoot')}</p>
    </div>
  );
}
