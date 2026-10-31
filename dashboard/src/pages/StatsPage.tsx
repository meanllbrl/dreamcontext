import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageBar } from '../components/layout/PageBar';
import { useI18n } from '../context/I18nContext';
import { useApi } from '../context/VaultContext';
import { StatsDc } from '../components/stats/StatsDc';
import { StatsLimits } from '../components/stats/StatsLimits';
import { ModelSheet, RunSheet } from '../components/stats/StatsSheets';
import { StatsSpend } from '../components/stats/StatsSpend';
import type { SleepRun, SpendRow, StatsRange, StatsTab, StatsWire } from '../components/stats/statsTypes';
import './StatsPage.css';

const TABS: Array<[StatsTab, string]> = [['cost', 'c'], ['tokens', 't'], ['limits', 'l'], ['dc', 'd']];
const RANGES: StatsRange[] = ['24h', '7d', '30d', '90d'];

function Menu({ label, on, children }: { label: string; on?: boolean; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => { if (!host.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div className="st-menuwrap" ref={host}>
      <button type="button" className="st-btn" data-on={on ? '' : undefined} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}<span className="car">▾</span></button>
      {open && <div className="st-menu" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** T3 Code's usage screen in the shell (Cost, Tokens, Limits), plus our fourth tab: what sleep costs, what memory adds, what Eco saves. */
export function StatsPage({ onNavigate }: { onNavigate: (page: 'settings') => void }) {
  const { t } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  const [tab, setTab] = useState<StatsTab>('cost');
  const [range, setRange] = useState<StatsRange>('7d');
  const [project, setProject] = useState<string | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [modelKey, setModelKey] = useState<string | null>(null);
  const [run, setRun] = useState<SleepRun | null>(null);

  const offParam = [...off].sort().join(',');
  const { data, isError } = useQuery({
    queryKey: ['agent-stats', range, project, offParam],
    queryFn: () => api.get<StatsWire>(`/agent/stats?range=${range}${project ? `&project=${encodeURIComponent(project)}` : ''}${offParam ? `&off=${encodeURIComponent(offParam)}` : ''}`),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.scanning ? 2000 : 60_000),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && /^Digit[1-4]$/.test(e.code)) {
        e.preventDefault();
        setRange(RANGES[Number(e.code.slice(5)) - 1]);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const hit = TABS.find(([, k]) => k === e.key.toLowerCase());
      if (hit) setTab(hit[0]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = (key: string) => setOff((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const countedTools = data?.tools.filter((x) => x.counted) ?? [];
  const onTools = countedTools.filter((x) => !off.has(x.id));
  const toolsLabel = off.size === 0 ? t('stats.allTools') : onTools.length === 1 ? onTools[0].name : `${onTools.length} ${t('stats.tools')}`;
  const model = modelKey ? data?.breakdown.model.find((m) => m.key === modelKey) ?? null : null;

  const savePrice = async (change: { model: string; price?: number[] | null; alias?: string | null }) => {
    await api.post('/agent/stats/price', change);
    await qc.invalidateQueries({ queryKey: ['agent-stats'] });
  };

  return (
    <div className="st-page" data-testid="stats-page">
      <PageBar title={t('nav.stats')}>
        <div className="st-seg" role="tablist">
          {TABS.map(([id, k]) => <button type="button" role="tab" key={id} aria-selected={tab === id} data-on={tab === id ? '' : undefined} title={`${t(`stats.tab.${id}`)}  ${k.toUpperCase()}`} onClick={() => setTab(id)}>{t(`stats.tab.${id}`)}</button>)}
        </div>
        <span className="sp" />
        {tab !== 'limits' && (
          <div className="st-seg">
            {RANGES.map((r, i) => <button type="button" key={r} data-on={range === r ? '' : undefined} title={`${r}  ⌘⇧${i + 1}`} onClick={() => setRange(r)}>{r}</button>)}
          </div>
        )}
        <Menu label={project ?? t('stats.allProjects')} on={project !== null}>
          {(close) => (
            <>
              <button type="button" className="st-mi" data-on={project === null ? '' : undefined} onClick={() => { setProject(null); close(); }}>{t('stats.allProjects')}</button>
              {data?.projects.map((p) => <button type="button" className="st-mi" key={p} data-on={project === p ? '' : undefined} onClick={() => { setProject(p); close(); }}>{p}</button>)}
            </>
          )}
        </Menu>
        <Menu label={toolsLabel} on={off.size > 0}>
          {() => (
            <>
              <div className="st-mh">{t('stats.toolsAccounts')}</div>
              {data?.tools.map((x) => (
                <div key={x.id}>
                  <button type="button" className="st-mi" disabled={!x.counted} data-on={x.counted && !off.has(x.id) ? '' : undefined} onClick={() => toggle(x.id)}>
                    {x.name}{!x.counted && <span className="pc">{t('stats.notCountedChip')}</span>}
                  </button>
                  {x.accounts.map((a) => (
                    <button type="button" className="st-mi sub" key={a.id} data-on={!off.has(x.id) && !off.has(`${x.id}:${a.id}`) ? '' : undefined} onClick={() => toggle(`${x.id}:${a.id}`)}>
                      {a.label}<span className="pc">{a.plan}</span>
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
        </Menu>
      </PageBar>
      <div className="st-body">
        {data?.scanning && <div className="st-scan" role="status">{data.scanning.total === 0 ? t('stats.scanningStart') : t('stats.scanning').replace('{d}', String(data.scanning.done)).replace('{n}', String(data.scanning.total))}</div>}
        {isError && !data && <div className="st-none">{t('stats.loadFailed')}</div>}
        {data && (tab === 'cost' || tab === 'tokens') && <StatsSpend data={data} tab={tab} onTab={setTab} onModel={(r: SpendRow) => setModelKey(r.key)} />}
        {data && tab === 'limits' && <StatsLimits data={data} off={off} />}
        {data && tab === 'dc' && <StatsDc data={data} onRun={setRun} />}
      </div>
      {model && data && <ModelSheet key={`${model.key}${model.priceSource}`} row={model} models={data.breakdown.model} range={range} onSave={(c) => void savePrice(c)} onClose={() => setModelKey(null)} />}
      {run && <RunSheet run={run} onSettings={() => { setRun(null); onNavigate('settings'); }} onClose={() => setRun(null)} />}
    </div>
  );
}
