import { useCallback, useEffect, useRef, useState } from 'react';
import { api, RequestError } from '../../api/client';
import { useI18n } from '../../context/I18nContext';
import { cutCurrentJob, startHandsfreeJob } from './handsfreeActions';
import { FOCUS_BANNER, onHandsfreeEvent, OPEN_RECEIPT, openHandsfreeSheet, useHandsfreeFor } from './handsfreeStore';
import { useChrome } from '../layout/WindowChrome';
import { AbandonConfirm, fill, InlineConfirm, JobErrorBlock, stageOf } from './HandsfreeParts';
import { HandsfreeReceipt } from './HandsfreeReceipt';
import type { HandsfreeJob, Receipt, ReturnResult } from './handsfreeTypes';
import './handsfree.css';

const RETURN_KINDS = new Set<HandsfreeJob['kind']>(['return', 'resume', 'rollback', 'abandon']);

/**
 * The hands-free banner, on EVERY page of the project on the cloud machine while the laptop is
 * not home (AC6): away → "on the cloud machine" + Return; going / returning → the job's progress, its wait and Cut; an
 * interrupted trip → exactly the buttons the status offers (Resume / Roll back / Abandon).
 * Queued cloud finalization and the warnings (AC22 retention, AC23 quota) ride as a quiet line,
 * at home too. Every OTHER project (another tab, the launcher) gets no banner at all: the chip
 * in the window bar names the away project and carries Return / Show link (r14/r16: the lock is
 * per project). Also the receipt's host: it opens when a Return finishes and on
 * `openHandsfreeReceipt(trip)` (the Settings card's last trip).
 */
export function HandsfreeBanner() {
  const { t } = useI18n();
  const { activeVault } = useChrome();
  const { status, unavailable, job, view } = useHandsfreeFor(activeVault);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pulse, setPulse] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  /** Jobs seen RUNNING in this page: only their finish opens the receipt (never a reload's). */
  const seenRunning = useRef(new Set<string>());
  const closeReceipt = useCallback(() => setReceipt(null), []);

  useEffect(() => {
    if (!job) return;
    if (job.status === 'running') { seenRunning.current.add(job.id); return; }
    if (!seenRunning.current.delete(job.id)) return;
    if (job.status !== 'success' || (job.kind !== 'return' && job.kind !== 'resume')) return;
    const r = job.result as ReturnResult | null;
    if (r?.receipt) setReceipt(r.receipt);
    else if (r?.message) setNotice(r.message);
  }, [job]);

  useEffect(() => onHandsfreeEvent<string>(OPEN_RECEIPT, (trip) => {
    void api.get<Receipt>(`/handsfree/receipt?trip=${encodeURIComponent(trip)}`)
      .then(setReceipt, (err: unknown) => setNotice(err instanceof RequestError ? err.message : String(err)));
  }), []);

  useEffect(() => onHandsfreeEvent(FOCUS_BANNER, () => {
    setPulse((n) => n + 1);
    barRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }), []);

  const run = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    setActionError(null);
    const r = await startHandsfreeJob(path, body);
    if (!r.ok && r.code !== 'busy') setActionError(r.message);
    setBusy(false);
  };
  const cut = async () => {
    const r = await cutCurrentJob();
    if (!r.ok && r.code !== 'not_waiting') setActionError(r.message);
  };

  const modal = receipt && <HandsfreeReceipt receipt={receipt} onClose={closeReceipt} />;
  if (unavailable || !status) return modal || null;

  const phase = status.phase;
  const quiet = [
    ...(status.queued ? [fill(t('handsfree.banner.queued'), { steps: status.queued.steps.join(', ') })] : []),
    ...status.warnings,
    ...(notice ? [notice] : []),
  ];

  if (phase === 'home' && !status.unreadable) {
    if (!quiet.length) return modal || null;
    return (
      <>
        <div className="hf-banner hf-banner--quiet" role="status" data-testid="hf-banner-quiet">
          {quiet.map((q) => <span key={q} className="hf-banner-quiet">{q}</span>)}
          {notice && <button type="button" className="hf-banner-btn" onClick={() => setNotice(null)}>{t('handsfree.dismiss')}</button>}
        </div>
        {modal}
      </>
    );
  }

  const tripJob = job && job.status === 'running' ? job : null;
  // Another project (or the launcher) while a trip is out: NO banner row at all (owner, r16).
  // The window bar's chip names the away project and opens Return / Show link from there.
  if (view === 'other') return modal || null;
  const failed = job && job.status === 'error' && (RETURN_KINDS.has(job.kind) || job.kind === 'go') ? job : null;
  const waiting = tripJob?.step === 'waiting';
  const offers = status.offers;
  const message = status.unreadable
    ? t('handsfree.banner.unreadable')
    : tripJob
      ? fill(t(`handsfree.banner.job.${tripJob.kind}`), { stage: t(`handsfree.stage.${stageOf(tripJob.kind, tripJob.step) ?? 'check'}`) })
      : t(`handsfree.banner.${phase}`);

  return (
    <>
      <div
        ref={barRef}
        className="hf-banner"
        data-phase={phase}
        data-pulse={pulse % 2 ? 'a' : pulse ? 'b' : undefined}
        role="region"
        aria-label={t('handsfree.banner.aria')}
        data-testid="hf-banner"
      >
        <div className="hf-banner-row">
          <span className="hf-banner-msg" aria-live="polite">{message}</span>
          {tripJob?.detail && !waiting && <span className="hf-banner-quiet">{tripJob.detail}</span>}
          {!tripJob && (
            <span className="hf-banner-actions">
              {phase === 'away' && offers.includes('return') && (
                <button type="button" className="hf-banner-btn hf-banner-btn--primary" onClick={() => void run('return')} disabled={busy} data-testid="hf-return">{t('handsfree.return')}</button>
              )}
              {phase === 'away' && status.url && (
                <button type="button" className="hf-banner-btn" onClick={() => openHandsfreeSheet('link')}>{t('handsfree.banner.showLink')}</button>
              )}
              {phase !== 'away' && offers.includes('resume') && (
                <button type="button" className="hf-banner-btn hf-banner-btn--primary" onClick={() => void run('resume')} disabled={busy} data-testid="hf-resume">{t('handsfree.resume')}</button>
              )}
              {offers.includes('rollback') && (
                <InlineConfirm label={t('handsfree.rollback')} confirmLabel={t('handsfree.rollback.confirm')} body={<p>{t('handsfree.rollback.body')}</p>} onConfirm={() => void run('rollback')} busy={busy} danger testId="hf-rollback" />
              )}
              {offers.includes('abandon') && <AbandonConfirm onConfirm={() => void run('abandon', { confirm: 'abandon' })} busy={busy} />}
            </span>
          )}
        </div>
        {waiting && (
          <div className="hf-banner-row">
            <span className="hf-banner-quiet">{tripJob?.detail ?? t('handsfree.wait.lead')}</span>
            <InlineConfirm label={t('handsfree.cut')} confirmLabel={t('handsfree.cut.confirm')} body={<p>{t('handsfree.cut.body')}</p>} onConfirm={() => void cut()} danger testId="hf-banner-cut" />
          </div>
        )}
        {failed && !tripJob && <JobErrorBlock job={failed} status={status} onAbandon={offers.includes('abandon') ? undefined : () => void run('abandon', { confirm: 'abandon' })} busy={busy} />}
        {actionError && <div className="hf-error" role="alert">{actionError}</div>}
        {quiet.map((q) => <p key={q} className="hf-banner-quiet">{q}</p>)}
      </div>
      {modal}
    </>
  );
}
