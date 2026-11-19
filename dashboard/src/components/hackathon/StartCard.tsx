import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../context/VaultContext';
import { ScopedLocale, useI18n } from '../../context/I18nContext';
import { RequestError } from '../../api/client';
import { fill, modelLabel, textLocale, useDesign, when, type DesignView } from './data';
import { TeamMark, people } from './parts';
import './hackathon.css';

/**
 * The owner's start card (plan C6, criterion 4): drawn ONLY from `GET …/design` (the run's real
 * design, never the agent's labels): each team's tool, model and reach, every data tool teams may
 * call, rounds, end time and the limit. Başlat posts the hash of the design the owner READ: the
 * first one drawn. A refetch that brings another design shows "tasarım değişti" and Başlat waits
 * until he confirms he has read the new one (the server refuses any other hash too).
 */
type StartCardProps = {
  run: string;
  onStarted?: () => void;
  /** On the Hackathon page the header already names the problem. */
  inPage?: boolean;
  /** Vazgeç: closes the run before it starts (the page passes Durdur). */
  onCancel?: () => void;
  cancelling?: boolean;
};

/** The card speaks its run's language (a Turkish problem → Turkish labels), in chat as on the page. */
export function StartCard(props: StartCardProps) {
  const { locale } = useI18n();
  const { data: d } = useDesign(props.run);
  return <ScopedLocale locale={textLocale([d?.problem, ...(d?.teams ?? []).map((x) => x.persona)], locale)}><StartCardBody {...props} /></ScopedLocale>;
}

function StartCardBody({ run, onStarted, inPage, onCancel, cancelling }: {
  run: string;
  onStarted?: () => void;
  /** On the Hackathon page the header already names the problem. */
  inPage?: boolean;
  /** Vazgeç: closes the run before it starts (the page passes Durdur). */
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const { t } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  const { data: d, isLoading, isError, error, refetch } = useDesign(run);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [cancelAsk, setCancelAsk] = useState(false);
  // The hash of the design he has in front of him: set once, moved only by his own confirm.
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => { if (d?.designHash && seen === null) setSeen(d.designHash); }, [d?.designHash, seen]);

  if (isLoading) return <div className="hk-card hk-card--start"><p className="hk-quiet">{t('common.loading')}</p></div>;
  if (isError || !d) return <div className="hk-card hk-card--start"><p className="hk-error">{t('hk.start.loadFailed')} {(error as Error | null)?.message ?? ''}</p></div>;

  const moved = seen !== null && seen !== d.designHash;
  const start = async () => {
    if (moved || seen === null) return;
    setBusy(true); setErr(null); setChanged(false);
    try {
      await api.ownerPost(`/hackathon/${encodeURIComponent(run)}/start`, { designHash: seen });
      await qc.invalidateQueries({ queryKey: ['hackathon'] });
      onStarted?.();
    } catch (e) {
      if (e instanceof RequestError && e.code === 'design_changed') { setChanged(true); await refetch(); }
      else setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const waiting = d.state === 'awaiting-owner';
  const disk = d.teams.filter((x) => x.wholeDisk);
  const isolated = d.teams.some((x) => !x.wholeDisk);
  const words = t('hk.start.count').split('|');
  const count = words[d.teams.length] ?? String(d.teams.length);
  return (
    <section className={`hk-card--start${inPage ? ' hk-card--page' : ''}`} aria-label={t('hk.start.aria')}>
      {!inPage && <h3 className="hk-title hk-title--card">{d.problem}</h3>}
      <p className="hk-lede">{fill(t(`hk.start.lede.${d.kind}`), { teams: count, rounds: d.rounds, minutes: d.roundMinutes })}</p>

      <div className="hk-start__teams">
        {d.teams.map((tm) => (
          <article key={tm.id} className="hk-tc">
            <header className="hk-tc__head">
              <TeamMark teams={d.teams} team={tm} />
              <b>{tm.name}</b>
              {tm.control && <span className="hk-chip">{t('hk.control')}</span>}
            </header>
            {tm.persona && <p>{tm.persona}</p>}
            <p className="hk-small">{people(t, tm.inner, true)} · {modelLabel(tm.tool, tm.model)}</p>
          </article>
        ))}
      </div>

      <dl className="hk-kv">
        <dt>{t('hk.start.see')}</dt>
        <dd>
          {isolated && <>{t('hk.start.seeLine')} <strong className="hk-warn">{t('hk.start.keychain')}</strong></>}
          {!!disk.length && <> <strong className="hk-warn">{fill(t('hk.start.wholeDiskLine'), { teams: disk.map((x) => x.name).join(', ') })}</strong></>}
        </dd>
        <dt>{t('hk.start.limit')}</dt>
        <dd>{fill(t('hk.start.limitLine'), { share: d.limit.weeklyShareCeiling, guard: d.limit.sessionGuard })}</dd>
        <dt>{t('hk.start.end')}</dt>
        <dd>{fill(t('hk.start.endLine'), { end: when(d.endsAt) })}</dd>
        {!!d.mcpTools.length && (<><dt>{t('hk.start.tools')}</dt><dd>{d.mcpTools.join(', ')}</dd></>)}
        {d.experiment && (<><dt>{t('hk.start.experiment')}</dt><dd>{fill(t('hk.start.experimentLine'), { variable: d.experiment.variable, team: teamName(d, d.experiment.team) })}</dd></>)}
      </dl>

      {(changed || moved) && <p className="hk-banner" role="status">{t('hk.start.changed')}</p>}
      {err && <p className="hk-error" role="alert">{err}</p>}

      <footer className="hk-start__foot">
        {waiting && moved ? (
          <button type="button" className="hk-btn hk-start__reread" onClick={() => { setSeen(d.designHash); setChanged(false); }}>
            {t('hk.start.reread')}
          </button>
        ) : waiting ? (
          <button type="button" className="hk-btn hk-btn--primary hk-btn--lg" onClick={() => void start()} disabled={busy || seen === null}>
            {busy ? t('hk.start.starting') : t('hk.start.go')}
          </button>
        ) : (
          <span className="hk-quiet">{fill(t('hk.start.state'), { state: t(`hk.state.${d.state}`) })}</span>
        )}
        {onCancel && !cancelAsk && (waiting || d.state === 'draft') && (
          <button type="button" className="hk-btn hk-btn--lg" disabled={cancelling} onClick={() => setCancelAsk(true)}>{t('hk.start.cancel')}</button>
        )}
        {onCancel && cancelAsk && (
          <span className="hk-confirm" role="group" aria-label={t('hk.start.cancel')}>
            <span>{t('hk.stop.confirmDraft')}</span>
            <button type="button" className="hk-btn hk-btn--danger" disabled={cancelling} onClick={() => { setCancelAsk(false); onCancel(); }}>{t('hk.stop.yes')}</button>
            <button type="button" className="hk-btn" onClick={() => setCancelAsk(false)}>{t('hk.stop.no')}</button>
          </span>
        )}
      </footer>
    </section>
  );
}

function teamName(d: DesignView, id: string): string {
  return d.teams.find((x) => x.id === id)?.name ?? id;
}
