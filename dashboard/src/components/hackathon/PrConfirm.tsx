import { useState } from 'react';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { fill, usePrCheck, type RunTeam } from './data';

/**
 * The PR confirm card (plan C6 `pr`): the winner's branch, its diffstat, any secret hit (which
 * refuses the push with file:line), and every changed path that runs on another machine or in the
 * owner's next session, with its hunks. Those need his tick: the tick sends the confirm hash the
 * server computed over exactly those hunks, so a hunk changed after this card was drawn re-asks.
 */
export function PrConfirm({ run, team, onClose }: { run: string; team: RunTeam | undefined; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const { data, isLoading, isError, error, refetch } = usePrCheck(run, true);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const check = data?.check ?? null;
  const needsConfirm = !!check?.elsewhere.length;
  const blocked = !!check?.secretHits.length;

  const send = async () => {
    if (!check) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.ownerPost<{ ok: true; url: string }>(`/hackathon/${encodeURIComponent(run)}/pr`, needsConfirm ? { confirmHash: check.confirmHash } : {});
      setUrl(r.url);
    } catch (e) {
      setErr((e as Error).message); setOk(false); await refetch();
    } finally { setBusy(false); }
  };

  return (
    <section className="hk-panel hk-pr" aria-label={t('hk.pr.aria')}>
      <header className="hk-pr__head">
        <h3 className="hk-start__title">{fill(t('hk.pr.title'), { team: team?.name ?? data?.pick ?? '' })}</h3>
        <button type="button" className="hk-btn" onClick={onClose}>{t('hk.pr.close')}</button>
      </header>
      {isLoading && <p className="hk-muted">{t('common.loading')}</p>}
      {isError && <p className="hk-error">{(error as Error | null)?.message}</p>}
      {data && !check && <p className="hk-error">{fill(t('hk.pr.unavailable'), { reason: data.reason ?? '' })}</p>}
      {check && (
        <>
          <p className="hk-muted">{fill(t('hk.pr.branch'), { branch: check.branch })}</p>
          <pre className="hk-screen__code hk-mono hk-pr__stat">{check.diffstat || t('hk.pr.noDiff')}</pre>
          {blocked && (
            <div className="hk-error" role="alert">
              <strong>{t('hk.pr.secrets')}</strong>
              <ul>{check.secretHits.map((h) => <li key={`${h.path}:${h.line}`} className="hk-mono">{h.path}:{h.line}</li>)}</ul>
            </div>
          )}
          {needsConfirm && (
            <div className="hk-pr__elsewhere">
              <strong>{t('hk.pr.elsewhere')}</strong>
              {check.elsewhere.map((f) => (
                <details key={f.path} className="hk-pr__file" open={check.elsewhere.length <= 3}>
                  <summary className="hk-mono">{f.path}</summary>
                  <pre className="hk-screen__code hk-mono">{f.hunks}</pre>
                </details>
              ))}
              <label className="hk-pr__tick">
                <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
                {t('hk.pr.confirm')}
              </label>
            </div>
          )}
          <ul className="hk-pr__notes hk-muted">
            <li>{t('hk.pr.noteScan')}</li>
            <li>{t('hk.pr.noteCi')}</li>
            {check.codexWinner && <li className="hk-warn-ink">{t('hk.pr.noteCodex')}</li>}
          </ul>
          {err && <p className="hk-error" role="alert">{err}</p>}
          {url ? (
            <p className="hk-note">{t('hk.pr.opened')} <a href={url} target="_blank" rel="noreferrer">{url}</a></p>
          ) : (
            <footer className="hk-start__foot">
              <button type="button" className="hk-btn hk-btn--primary" disabled={busy || blocked || (needsConfirm && !ok)} onClick={() => void send()}>
                {busy ? t('hk.pr.sending') : t('hk.pr.send')}
              </button>
              {blocked ? <span className="hk-muted">{t('hk.pr.blockedWhy')}</span> : needsConfirm && !ok ? <span className="hk-muted">{t('hk.pr.tickWhy')}</span> : null}
            </footer>
          )}
        </>
      )}
    </section>
  );
}
