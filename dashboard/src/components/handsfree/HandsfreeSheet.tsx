import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiClient, RequestError } from '../../api/client';
import { useI18n } from '../../context/I18nContext';
import { VaultProvider } from '../../context/VaultContext';
import { RunCard } from '../sleepy/chat/RunCard';
import { cutCurrentJob, startHandsfreeJob } from './handsfreeActions';
import { useHandsfree } from './handsfreeStore';
import {
  AbandonConfirm, CloudLink, coreHours, fill, formatBytes, InlineConfirm, JobErrorBlock, JobProgress, RunningList,
} from './HandsfreeParts';
import type { GoResult, HandsfreeJob, PreflightReport } from './handsfreeTypes';
import '../sleepy/chat/ChatViews.css';

/**
 * The go sheet: (1) scope + size estimate from `GET /api/handsfree/preflight`, Go disabled
 * with the reason when the preflight refuses; (2) the wait for running turns, with Cut; (3)
 * per-step progress of the job; (4) the cloud URL, its QR and a copy button.
 *
 * The sheet holds no job state of its own: it renders whatever `jobs/current` says, so closing
 * and reopening it, or reloading the app, re-adopts a go that is still running.
 */
export function HandsfreeSheet({ vault, onClose }: { vault: string; onClose: () => void }) {
  const { t } = useI18n();
  const { status, job } = useHandsfree();
  const client = useMemo(() => new ApiClient(vault), [vault]);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A finished go job the owner already looked at (Back to step 1). */
  const [dismissedJob, setDismissedJob] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const runBus = useMemo(() => new EventTarget(), []);

  const goJob: HandsfreeJob | null = job && job.kind === 'go' && job.id !== dismissedJob ? job : null;
  const phase = status?.phase ?? 'home';
  const view: 'preflight' | 'waiting' | 'progress' | 'error' | 'done' =
    goJob?.status === 'running' ? (goJob.step === 'waiting' ? 'waiting' : 'progress')
      : goJob?.status === 'error' ? 'error'
        : phase === 'away' || (goJob?.status === 'success' && phase !== 'home') ? 'done'
          : phase === 'home' ? 'preflight' : 'progress';

  const loadPreflight = useCallback(async () => {
    setPreflightError(null);
    setPreflight(null);
    try {
      setPreflight(await client.get<PreflightReport>('/handsfree/preflight'));
    } catch (err) {
      setPreflightError(err instanceof RequestError || err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => { if (view === 'preflight') void loadPreflight(); }, [view, loadPreflight]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const go = async () => {
    setBusy(true);
    setActionError(null);
    const r = await startHandsfreeJob('go', {}, client);
    if (!r.ok && r.code !== 'busy') setActionError(r.message);
    setBusy(false);
  };

  const cut = async () => {
    const r = await cutCurrentJob();
    if (!r.ok && r.code !== 'not_waiting') setActionError(r.message);
  };

  const abandon = async () => {
    setBusy(true);
    const r = await startHandsfreeJob('abandon', { confirm: 'abandon' });
    if (!r.ok) setActionError(r.message);
    setBusy(false);
  };

  const goResult = goJob?.status === 'success' ? (goJob.result as GoResult | null) : null;
  const url = goResult?.url ?? status?.url ?? null;

  // Portalled to <body>: the chrome bar is its own stacking context, and the banner must sit
  // under this modal's backdrop, not over it.
  return createPortal(
    <div className="hf-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="hf-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hf-sheet-title"
        tabIndex={-1}
        data-testid="hf-sheet"
        data-view={view}
      >
        <header className="hf-sheet-head">
          <h2 id="hf-sheet-title">{t('handsfree.sheet.title')}</h2>
          <button type="button" className="hf-icon-btn" onClick={onClose} aria-label={t('handsfree.close')}>✕</button>
        </header>

        {view === 'preflight' && (
          <section className="hf-sheet-body" data-testid="hf-step-scope">
            <p className="hf-lead">{fill(t('handsfree.sheet.lead'), { vault })}</p>
            {!preflight && !preflightError && <p className="hf-quiet" role="status">{t('handsfree.sheet.checking')}</p>}
            {preflightError && <div className="hf-error" role="alert">{preflightError}</div>}
            {preflight && <PreflightBody report={preflight} vault={vault} runBus={runBus} />}
            {actionError && <div className="hf-error" role="alert">{actionError}</div>}
            <div className="hf-actions hf-actions--end">
              <button type="button" className="hf-btn" onClick={onClose}>{t('handsfree.cancel')}</button>
              <button
                type="button"
                className="hf-btn hf-btn--primary"
                onClick={() => void go()}
                disabled={!preflight || !!preflight.refusal || busy}
                data-testid="hf-go"
                title={preflight?.refusal?.message}
              >
                {t('handsfree.go')}
              </button>
            </div>
          </section>
        )}

        {view === 'waiting' && goJob && (
          <section className="hf-sheet-body" data-testid="hf-step-wait">
            <JobProgress job={goJob} />
            <p className="hf-lead">{t('handsfree.wait.lead')}</p>
            <RunningList running={goJob.running} detail={goJob.detail} />
            <InlineConfirm
              label={t('handsfree.cut')}
              confirmLabel={t('handsfree.cut.confirm')}
              body={<p>{t('handsfree.cut.body')}</p>}
              onConfirm={() => void cut()}
              danger
              testId="hf-cut"
            />
            {actionError && <div className="hf-error" role="alert">{actionError}</div>}
          </section>
        )}

        {view === 'progress' && (
          <section className="hf-sheet-body" data-testid="hf-step-progress">
            {goJob ? <JobProgress job={goJob} /> : <p className="hf-quiet">{t(`handsfree.phase.${phase}`)}</p>}
            <p className="hf-quiet">{t('handsfree.progress.closeable')}</p>
          </section>
        )}

        {view === 'error' && goJob && (
          <section className="hf-sheet-body" data-testid="hf-step-error">
            <JobProgress job={goJob} />
            <JobErrorBlock job={goJob} status={status} onAbandon={() => void abandon()} busy={busy} />
            {status?.offers.includes('abandon') && goJob.error?.code !== 'quota' && <AbandonConfirm onConfirm={() => void abandon()} busy={busy} />}
            {actionError && <div className="hf-error" role="alert">{actionError}</div>}
            <div className="hf-actions hf-actions--end">
              {phase === 'home' && <button type="button" className="hf-btn" onClick={() => setDismissedJob(goJob.id)}>{t('handsfree.back')}</button>}
            </div>
          </section>
        )}

        {view === 'done' && (
          <section className="hf-sheet-body" data-testid="hf-step-done">
            <p className="hf-lead">{t('handsfree.done.lead')}</p>
            {url ? <CloudLink url={url} /> : <p className="hf-quiet">{t('handsfree.done.noUrl')}</p>}
            {goResult?.recreated && <p className="hf-note">{t('handsfree.done.recreated')}</p>}
            {!!goResult?.signedOutAccounts?.length && (
              <p className="hf-note">{fill(t('handsfree.done.signedOut'), { accounts: goResult.signedOutAccounts.join(', ') })}</p>
            )}
            {!!goResult?.staysHome?.length && (
              <details className="hf-details">
                <summary>{fill(t('handsfree.done.staysHome'), { n: goResult.staysHome.length })}</summary>
                <ul className="hf-paths">{goResult.staysHome.map((p) => <li key={`${p.rootId}:${p.path}`}><code className="hf-mono">{p.path}</code> <span className="hf-quiet">{p.reason}</span></li>)}</ul>
              </details>
            )}
            {(goResult?.warnings ?? []).map((w) => <p key={w} className="hf-quiet">{w}</p>)}
            <div className="hf-actions hf-actions--end">
              <button type="button" className="hf-btn hf-btn--primary" onClick={onClose}>{t('handsfree.done.close')}</button>
            </div>
          </section>
        )}
      </div>
    </div>,
    document.body,
  );
}

function PreflightBody({ report, vault, runBus }: { report: PreflightReport; vault: string; runBus: EventTarget }) {
  const { t } = useI18n();
  const m = report.machine;
  const cores = m?.name ? (/^standard/i.test(m.name) ? 4 : /^premium/i.test(m.name) ? 8 : /^largePremium/i.test(m.name) ? 16 : 2) : 2;
  return (
    <>
      <table className="hf-table">
        <caption className="hf-visually-hidden">{t('handsfree.sheet.scopeCaption')}</caption>
        <thead>
          <tr><th scope="col">{t('handsfree.sheet.root')}</th><th scope="col">{t('handsfree.sheet.kind')}</th><th scope="col" className="hf-num">{t('handsfree.sheet.size')}</th></tr>
        </thead>
        <tbody>
          {report.roots.map((r) => (
            <tr key={r.rootId}>
              <td><code className="hf-mono">{r.path}</code></td>
              <td>{t(`handsfree.rootKind.${r.kind}`)}</td>
              <td className="hf-num">{formatBytes(r.bytes)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th scope="row" colSpan={2}>{t('handsfree.sheet.total')}</th><td className="hf-num" data-testid="hf-total">{formatBytes(report.totalBytes)}</td></tr>
        </tfoot>
      </table>

      {m && (
        <dl className="hf-facts">
          <dt>{t('handsfree.sheet.machine')}</dt>
          <dd>{m.name}{m.running ? ` · ${t('handsfree.sheet.running')}` : ''}</dd>
          <dt>{t('handsfree.sheet.disk')}</dt>
          <dd>{m.freeBytes === null ? t('handsfree.unknown') : fill(t('handsfree.sheet.diskFit'), { need: formatBytes(m.needBytes), free: formatBytes(m.freeBytes) })}</dd>
          <dt>{t('handsfree.sheet.quota')}</dt>
          <dd>
            {m.remainingCoreMinutes === null ? t('handsfree.unknown') : fill(t('handsfree.sheet.quotaFit'), { left: coreHours(m.remainingCoreMinutes, cores), need: coreHours(m.needCoreMinutes, cores) })}
            {m.quotaSource === 'laptop' && <span className="hf-quiet"> · {t('handsfree.sheet.quotaLaptop')}</span>}
          </dd>
        </dl>
      )}

      {report.runningTurns.length > 0 && (
        <div className="hf-note">
          <p>{fill(t('handsfree.sheet.runningTurns'), { n: report.runningTurns.length })}</p>
          <RunningList running={report.runningTurns} />
        </div>
      )}

      {report.warnings.map((w) => <p key={w} className="hf-quiet hf-warning">{w}</p>)}

      {report.refusal && (
        <div className="hf-error" role="alert" data-testid="hf-refusal" data-code={report.refusal.code}>
          <p className="hf-error-msg">{t(`handsfree.refusal.${report.refusal.code}`)}</p>
          <p className="hf-pre-line">{report.refusal.message}</p>
          {report.refusal.code === 'not_setup' && (
            <VaultProvider vault={vault} instanceId="handsfree-sheet" isActive bus={runBus}>
              <RunCard spec={{ type: 'run', id: 'hf-setup', command: 'dreamcontext handsfree setup', why: t('handsfree.setup.why') }} />
            </VaultProvider>
          )}
        </div>
      )}
    </>
  );
}
