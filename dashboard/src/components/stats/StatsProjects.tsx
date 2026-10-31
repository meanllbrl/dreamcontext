import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { fmtCost, fmtDay, fmtTokens } from './statsFormat';
import type { ProjectRow, StatsWire } from './statsTypes';

const SHOWN = 10;

/** An estimate's sign is always written: a net of "$12" must not read as money spent. */
const signed = (v: number, fmt: (n: number) => string): string => `~ ${v < 0 ? '−' : '+'}${fmt(Math.abs(v))}`;

function Row({ r, partial, t }: { r: ProjectRow; partial: boolean; t: (k: string) => string }) {
  const eaten = r.sleep.cost + r.estMemory.cost;
  const eatenTokens = r.sleep.tokens + r.estMemory.tokens;
  const machine = r.prompts ? r.prompts.super + r.prompts.auto : 0;
  const up = r.estNet.cost >= 0;
  const zero = eatenTokens === 0 && r.estSaved.tokens === 0;
  return (
    <div className="st-tr" role="row" data-testid="stats-project-row">
      <span className="nm nm2" role="cell"><span><b>{r.label}</b><span className="dim">{fmtCost(r.cost ?? 0)} · {fmtTokens(r.tokens)}</span></span></span>
      <span className="st-pc" role="cell" data-k={t('stats.projects.prompts')}>
        <b>{r.prompts ? r.prompts.owner.toLocaleString('en-US') : '—'}</b>
        {machine > 0 && <small title={t('stats.projects.machineWhy')}>{r.prompts?.super ? `${r.prompts.super} ${t('stats.projects.super')}` : ''}{r.prompts?.super && r.prompts.auto ? ' · ' : ''}{r.prompts?.auto ? `${r.prompts.auto} ${t('stats.projects.auto')}` : ''}</small>}
      </span>
      <span className="st-pc" role="cell" data-k={t('stats.projects.eaten')}>
        <b>~{fmtCost(eaten)}</b>
        <small title={t('stats.projects.eatenWhy')}>{fmtCost(r.sleep.cost)} {t('stats.projects.sleep')} · ~{fmtCost(r.estMemory.cost)} {t('stats.projects.memory')}</small>
        <small>~{fmtTokens(eatenTokens)}</small>
      </span>
      <span className={`st-pc${r.estSaved.tokens > 0 ? ' st-est-cell' : ''}`} role="cell" data-k={t('stats.saved')}>
        <b>{r.estSaved.tokens > 0 ? `~${fmtCost(r.estSaved.cost)}` : '—'}</b>
        {r.estSaved.tokens > 0 && <small>~{fmtTokens(r.estSaved.tokens)}</small>}
      </span>
      <span className={`st-pc${zero ? '' : ' st-est-cell'}`} role="cell" data-k={t('stats.projects.net')} data-partial={partial ? '' : undefined}>
        <b className={up && !partial && !zero ? 'good' : undefined}>{zero ? '—' : `${partial ? '≥ ' : ''}${signed(r.estNet.cost, fmtCost)}`}</b>
        {!zero && <small>{signed(r.estNet.tokens, fmtTokens)}</small>}
        {partial && <small className="st-partial">{t('stats.projects.partial')}</small>}
      </span>
    </div>
  );
}

/** Per project: who wrote how much, what dreamcontext ate, what it saved, and the two against each other. */
export function StatsProjects({ data }: { data: StatsWire }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const { projects, ecoFrom, ecoPartial } = data.dc;
  const rows = all ? projects : projects.slice(0, SHOWN);
  return (
    <div className="st-card" data-testid="stats-projects">
      <div className="st-bh"><div className="st-k">{t('stats.projects.title')}</div></div>
      {projects.length === 0 && <div className="st-none">{t('stats.projects.none')}</div>}
      {projects.length > 0 && (
        <div className="st-tbl st-proj" role="table">
          <div className="st-tr st-th" role="row">
            <span>{t('stats.projects.project')}</span>
            <span>{t('stats.projects.prompts')}</span>
            <span>{t('stats.projects.eaten')}</span>
            <span>{t('stats.saved')} (~)</span>
            <span>{t('stats.projects.net')} (~)</span>
          </div>
          {rows.map((r) => <Row key={r.key} r={r} partial={ecoPartial} t={t} />)}
          {projects.length > rows.length && <button type="button" className="st-more" onClick={() => setAll(true)}>{t('stats.showAll').replace('{n}', String(projects.length))}</button>}
        </div>
      )}
      {ecoPartial && projects.length > 0 && <p className="st-foot" data-testid="stats-eco-partial">{(ecoFrom === null ? t('stats.projects.ecoNone') : t('stats.projects.ecoFrom').replace('{d}', fmtDay(ecoFrom)))}</p>}
      {projects.length > 0 && <p className="st-foot">{t('stats.projects.foot')}</p>}
    </div>
  );
}
