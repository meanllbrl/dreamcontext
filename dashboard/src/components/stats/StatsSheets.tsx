import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useVault } from '../../context/VaultContext';
import { fmtCost, fmtPct, fmtTokens, fmtWhen } from './statsFormat';
import { GhostBar } from './StatsChart';
import type { SleepRun, SpendRow } from './statsTypes';

export function Sheet({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const { isActive } = useVault();
  useEffect(() => {
    if (!isActive) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, onClose]);
  return (
    <>
      <button type="button" className="st-scrim" aria-label={t('common.close')} onClick={onClose} />
      <aside className="st-sheet" role="dialog" aria-label={title}>
        <header><div><h2>{title}</h2>{sub && <p>{sub}</p>}</div><button type="button" className="st-x" aria-label={t('common.close')} onClick={onClose}>×</button></header>
        <div className="st-sheet-body">{children}</div>
      </aside>
    </>
  );
}

const FIELDS: Array<[string, number]> = [['stats.input', 0], ['stats.output', 1], ['stats.cacheRead', 2], ['stats.cacheWrite', 3]];

export function ModelSheet({ row, models, range, saveFailed, onSave, onClose }: {
  row: SpendRow; models: SpendRow[]; range: string; saveFailed: boolean;
  onSave: (change: { model: string; price?: number[] | null; alias?: string | null }) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [vals, setVals] = useState<string[]>(() => (row.price ?? ['', '', '', '']).map(String));
  const trend = row.trend ?? [];
  const max = Math.max(...trend, 1e-9);
  // A comma is a decimal point on a Turkish keypad. `Number`, not `parseFloat`: `12abc` is no price.
  const parsed = vals.map((v) => (v.trim() ? Number(v.trim().replace(',', '.')) : NaN));
  const valid = parsed.every((v) => Number.isFinite(v) && v >= 0);
  return (
    <Sheet title={row.label} sub={`${row.tool === 'codex' ? 'Codex' : 'Claude Code'} · ${t('stats.last')} ${range}`} onClose={onClose}>
      <div className="st-spark">{trend.map((v, i) => <i key={i} style={{ height: `${Math.max(2, (v / max) * 100)}%` }} />)}</div>
      <div className="st-k">{t('stats.costPerBucket')}</div>
      <dl className="st-kv">
        <dt>{t('stats.tab.cost')}</dt><dd>{row.cost === null ? '—' : fmtCost(row.cost)}</dd>
        <dt>{t('stats.tab.tokens')}</dt><dd>{fmtTokens(row.tokens)}</dd>
        <dt>{t('stats.cacheHit')}</dt><dd>{fmtPct((row.cacheHit ?? 0) * 100)}</dd>
        <dt>{t('stats.costPerMillion')}</dt><dd>{row.cost !== null && row.tokens ? fmtCost((row.cost / row.tokens) * 1e6) : '—'}</dd>
      </dl>
      <div className="st-k st-gap">{t('stats.pricePerMillion')} <span className={`st-chip${row.priceSource === 'none' ? ' warn' : ''}`}>{t(`stats.priceSource.${row.priceSource ?? 'none'}`)}</span></div>
      <div className="st-pf">
        {FIELDS.map(([label, i]) => (
          <label key={label}><span>{t(label)}</span><input inputMode="decimal" value={vals[i]} placeholder="$" onChange={(e) => setVals((v) => v.map((x, j) => (j === i ? e.target.value : x)))} /></label>
        ))}
      </div>
      <div className="st-pa">
        <button type="button" className="st-btn on" disabled={!valid} onClick={() => onSave({ model: row.key, price: parsed })}>{t('stats.setPrice')}</button>
        {row.priceSource === 'yours' && <button type="button" className="st-btn" onClick={() => onSave({ model: row.key, price: null, alias: null })}>{t('stats.useList')}</button>}
      </div>
      {saveFailed && <p className="st-foot st-err" role="alert">{t('stats.saveFailed')}</p>}
      <div className="st-k st-gap">{t('stats.countAs')}</div>
      <select className="st-alias" value={row.alias ?? ''} onChange={(e) => onSave({ model: row.key, alias: e.target.value || null })}>
        <option value="">{row.label} ({t('stats.itself')})</option>
        {models.filter((m) => m.key !== row.key && m.priceSource !== 'none').map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
      </select>
      <p className="st-foot">{t('stats.countAsFoot')}</p>
    </Sheet>
  );
}

export function RunSheet({ run, onSettings, onClose }: { run: SleepRun; onSettings: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const debt = run.debtBefore !== null ? ` · ${t('stats.debt')} ${run.debtBefore}${run.debtAfter !== null ? ` → ${run.debtAfter}` : ''}` : '';
  return (
    <Sheet title={`${t('stats.sleep')} · ${run.project}`} sub={`${fmtWhen(run.start)} · ${t(`stats.trigger.${run.trigger}`)}${debt}`} onClose={onClose}>
      <dl className="st-kv">
        <dt>{t('stats.tab.tokens')}</dt><dd>{fmtTokens(run.tokens)}</dd>
        <dt>{t('stats.tab.cost')}</dt><dd>{fmtCost(run.cost)}</dd>
        {run.reportedCostUsd !== null && <><dt>{t('stats.reportedCost')}</dt><dd>{fmtCost(run.reportedCostUsd)}</dd></>}
        <dt>{t('stats.shareOfWindow')}</dt><dd>{run.estWindowShare === null ? '—' : `~${fmtPct(run.estWindowShare * 100)}`}{run.estWindowShare !== null && <GhostBar share={run.estWindowShare} />}</dd>
        {run.estLimitPoints !== null && <><dt>{t('stats.limitPoints')}</dt><dd>~{fmtPct(run.estLimitPoints)}<GhostBar share={run.estLimitPoints / 100} /></dd></>}
        <dt>{t('stats.view.account')}</dt><dd>{run.accountLabel}</dd>
      </dl>
      <div className="st-k st-gap">{t('stats.sleepView.spec')}</div>
      <div className="st-tbl">
        {run.specialists.map((s) => (
          <div className="st-tr" key={`${s.name}${s.model}`}>
            <span className="nm nm2"><span><b className="mono">{s.name}</b><span className="dim">{s.model}{s.effort ? ` · ${s.effort}` : ''}</span></span></span>
            <span className="num">{fmtTokens(s.tokens)}</span>
            <span className="shr"><i data-sleep="" style={{ width: `${(s.cost / (run.cost || 1)) * 100}%` }} /><em>{fmtPct((s.cost / (run.cost || 1)) * 100)}</em></span>
            <span className="num">{fmtCost(s.cost)}</span>
          </div>
        ))}
      </div>
      <div className="st-pa"><button type="button" className="st-btn" onClick={onSettings}>{t('stats.sleepModels')}</button></div>
    </Sheet>
  );
}
