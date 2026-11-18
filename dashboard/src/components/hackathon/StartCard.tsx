import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { RequestError } from '../../api/client';
import { clock, fill, useDesign, type DesignView } from './data';
import './hackathon.css';

/**
 * The owner's start card (plan C6, criterion 4): drawn ONLY from `GET …/design` (the run's real
 * design, never the agent's labels): each team's tool, model and reach, every data tool teams may
 * call, rounds, end time and the limit. Başlat posts the hash it drew; a design changed after the
 * card was drawn comes back as "tasarım değişti" and the card redraws from the new design.
 */
export function StartCard({ run, onStarted }: { run: string; onStarted?: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  const { data: d, isLoading, isError, error, refetch } = useDesign(run);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  if (isLoading) return <div className="hk-card hk-card--start"><p className="hk-muted">{t('common.loading')}</p></div>;
  if (isError || !d) return <div className="hk-card hk-card--start"><p className="hk-error">{t('hk.start.loadFailed')} {(error as Error | null)?.message ?? ''}</p></div>;

  const start = async () => {
    setBusy(true); setErr(null); setChanged(false);
    try {
      await api.ownerPost(`/hackathon/${encodeURIComponent(run)}/start`, { designHash: d.designHash });
      await qc.invalidateQueries({ queryKey: ['hackathon'] });
      onStarted?.();
    } catch (e) {
      if (e instanceof RequestError && e.code === 'design_changed') { setChanged(true); await refetch(); }
      else setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const waiting = d.state === 'awaiting-owner';
  return (
    <section className="hk-card hk-card--start" aria-label={t('hk.start.aria')}>
      <header className="hk-start__head">
        <span className="hk-eyebrow">{t('hk.start.eyebrow')}</span>
        <h3 className="hk-start__title">{d.problem}</h3>
        <p className="hk-muted">{fill(t('hk.start.shape'), { kind: t(`hk.kind.${d.kind}`), rounds: d.rounds, minutes: d.roundMinutes, end: clock(d.endsAt) })}</p>
      </header>

      <table className="hk-start__teams">
        <thead>
          <tr><th>{t('hk.start.team')}</th><th>{t('hk.start.tool')}</th><th>{t('hk.start.reach')}</th></tr>
        </thead>
        <tbody>
          {d.teams.map((tm) => (
            <tr key={tm.id}>
              <td>
                <strong>{tm.name}</strong>
                <span className="hk-muted"> · {t(`hk.inner.${tm.inner}`)}</span>
                {tm.control && <span className="hk-chip">{t('hk.control')}</span>}
              </td>
              <td>{tm.tool === 'codex' ? 'Codex' : 'Claude'} · {tm.model}</td>
              <td className={tm.wholeDisk ? 'hk-warn-ink' : undefined}>{tm.wholeDisk ? t('hk.start.wholeDisk') : t('hk.start.isolated')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="hk-start__facts">
        <dt>{t('hk.start.limit')}</dt>
        <dd>{fill(t('hk.start.limitLine'), { share: d.limit.weeklyShareCeiling, guard: d.limit.sessionGuard })}</dd>
        <dt>{t('hk.start.tools')}</dt>
        <dd>{d.mcpTools.length ? <span className="hk-mono">{d.mcpTools.join(', ')}</span> : t('hk.start.noTools')}</dd>
        <dt>{t('hk.start.writes')}</dt>
        <dd>{t('hk.start.writesLine')}</dd>
        {d.experiment && (<><dt>{t('hk.start.experiment')}</dt><dd>{fill(t('hk.start.experimentLine'), { variable: d.experiment.variable, team: teamName(d, d.experiment.team) })}</dd></>)}
      </dl>

      {changed && <p className="hk-note" role="status">{t('hk.start.changed')}</p>}
      {err && <p className="hk-error" role="alert">{err}</p>}

      <footer className="hk-start__foot">
        {waiting ? (
          <button type="button" className="hk-btn hk-btn--primary" onClick={() => void start()} disabled={busy}>
            {busy ? t('hk.start.starting') : t('hk.start.go')}
          </button>
        ) : (
          <span className="hk-muted">{fill(t('hk.start.state'), { state: t(`hk.state.${d.state}`) })}</span>
        )}
      </footer>
    </section>
  );
}

function teamName(d: DesignView, id: string): string {
  return d.teams.find((x) => x.id === id)?.name ?? id;
}
