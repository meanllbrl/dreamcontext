import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../context/I18nContext';
import { isDesktop } from '../../lib/desktop';
import { startHandsfreeJob } from './handsfreeActions';
import { focusHandsfreeBanner, onHandsfreeEvent, OPEN_SHEET, openHandsfreeSheet, useHandsfreeFor, type HandsfreeView } from './handsfreeStore';
import { fill, JobProgress } from './HandsfreeParts';
import { HandsfreeSheet } from './HandsfreeSheet';
import type { HandsfreeJob, HandsfreeStatus } from './handsfreeTypes';
import { handsfreeVisible } from './handsfreeReveal';
import './handsfree.css';

/**
 * What the chip does when clicked. Home (or a go of this project running): the go sheet. This
 * project away or on the way: its banner already carries every action, so the chip brings it
 * forward. ANOTHER project while a trip is out (r16: it has no banner at all): the elsewhere
 * dialog, naming the away project with Return, Show link and a running job's progress.
 */
export function chipAction(view: HandsfreeView, phase: HandsfreeStatus['phase'], goRunning: boolean): 'sheet' | 'banner' | 'elsewhere' {
  if (phase === 'home' || (goRunning && view !== 'other')) return 'sheet';
  return view === 'other' ? 'elsewhere' : 'banner';
}

/**
 * The window chrome's hands-free button (desktop app only, for the project on screen). Home:
 * opens the go sheet. Away or on the way: the banner already carries every action, so the
 * button brings it forward instead of a second, competing surface. In a project that is NOT
 * the one on the cloud machine it never claims to be: it names the away project and opens the
 * elsewhere dialog (r14/r16). Also the sheet's host for `openHandsfreeSheet()` ("Show link").
 */
export function HandsfreeButton({ vault }: { vault: string }) {
  const { t } = useI18n();
  const { status, unavailable, job, view } = useHandsfreeFor(vault);
  const [open, setOpen] = useState(false);
  const [elsewhereOpen, setElsewhereOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const closeElsewhere = useCallback(() => setElsewhereOpen(false), []);

  useEffect(() => onHandsfreeEvent(OPEN_SHEET, () => { setElsewhereOpen(false); setOpen(true); }), []);

  if (!isDesktop() || unavailable || !vault || !handsfreeVisible(status)) return null;
  const phase = status?.phase ?? 'home';
  const goRunning = job?.kind === 'go' && job.status === 'running';
  const action = chipAction(view, phase, goRunning);
  const elsewhere = action === 'elsewhere';
  const name = status?.away?.name ?? t('handsfree.banner.other.unnamed');
  const label = action === 'sheet' && phase === 'home' && !goRunning
    ? t('handsfree.button')
    : elsewhere && phase === 'away'
      ? fill(t('handsfree.button.elsewhere'), { name })
      : t(`handsfree.phase.${phase}`);

  return (
    <>
      <button
        type="button"
        className="hf-chrome-btn"
        data-phase={elsewhere ? 'elsewhere' : phase}
        data-testid="hf-button"
        aria-haspopup="dialog"
        title={label}
        onClick={() => {
          if (action === 'sheet') setOpen(true);
          else if (action === 'elsewhere') setElsewhereOpen(true);
          else focusHandsfreeBanner();
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5z" />
          {phase !== 'home' && <circle cx="12.5" cy="3.5" r="1.6" fill="currentColor" stroke="none" />}
        </svg>
        <span className="hf-chrome-label">{label}</span>
      </button>
      {open && <HandsfreeSheet vault={vault} onClose={close} />}
      {elsewhereOpen && status && createPortal(<ElsewhereDialog status={status} job={job} name={name} onClose={closeElsewhere} />, document.body)}
    </>
  );
}

/**
 * The trip as seen from ANOTHER project (r16): no banner there, so this is where Return, Show
 * link and a running go/return's progress live. Same markup as the sheet (hf-backdrop/hf-sheet).
 */
export function ElsewhereDialog({ status, job, name, onClose }: { status: HandsfreeStatus; job: HandsfreeJob | null; name: string; onClose: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const running = job && job.status === 'running' ? job : null;
  const phase = status.phase === 'home' ? 'away' : status.phase;

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const goReturn = async () => {
    setBusy(true);
    setActionError(null);
    const r = await startHandsfreeJob('return');
    if (!r.ok && r.code !== 'busy') setActionError(r.message);
    setBusy(false);
  };

  return (
    <div className="hf-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="hf-sheet" role="dialog" aria-modal="true" aria-labelledby="hf-elsewhere-title" tabIndex={-1} data-testid="hf-elsewhere">
        <header className="hf-sheet-head">
          <h2 id="hf-elsewhere-title">{t('handsfree.sheet.title')}</h2>
          <button type="button" className="hf-icon-btn" onClick={onClose} aria-label={t('handsfree.close')}>✕</button>
        </header>
        <section className="hf-sheet-body">
          <p className="hf-lead">{fill(t(`handsfree.banner.other.${phase}`), { name })}</p>
          {running && <JobProgress job={running} />}
          {actionError && <div className="hf-error" role="alert">{actionError}</div>}
          {!running && status.phase === 'away' && (
            <div className="hf-actions hf-actions--end">
              {status.url && <button type="button" className="hf-btn" onClick={() => { onClose(); openHandsfreeSheet('link'); }}>{t('handsfree.banner.showLink')}</button>}
              {status.offers.includes('return') && (
                <button type="button" className="hf-btn hf-btn--primary" onClick={() => void goReturn()} disabled={busy} data-testid="hf-elsewhere-return">{t('handsfree.return')}</button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
