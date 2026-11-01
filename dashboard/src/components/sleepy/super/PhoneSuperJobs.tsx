import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { SuperJobWire } from '../../handsfree/macContract';
import { ChildTranscript } from './ChildTranscript';
import './PhoneAgenda.css';

/** The word a job's row says. */
export function jobStateKey(state: SuperJobWire['state']): `super.phoneJobs.${SuperJobWire['state']}` {
  return `super.phoneJobs.${state}`;
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * What the Super Agent gave out, on the hands-free phone: the jobs it runs and the ones it just
 * finished, under the agenda strip. The stage does not come to a phone; this list does. It reads
 * the Mac's record (`supers[].jobs` of `live-chats`), and a tap reads that job's transcript
 * through `/agent/chat-history`: nothing here opens a socket to a child or can write to one.
 */
export function PhoneSuperJobs({ jobs }: { jobs: readonly SuperJobWire[] }) {
  const { t } = useI18n();
  // The job as it was tapped: it may leave the list while it is being read.
  const [tapped, setTapped] = useState<SuperJobWire | null>(null);
  const open = tapped ? (jobs.find((j) => j.conversationId === tapped.conversationId) ?? tapped) : null;
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLElement | null>(null);
  const openId = open?.conversationId ?? null;

  const close = useCallback(() => {
    setTapped(null);
    requestAnimationFrame(() => rowRef.current?.focus());
  }, []);

  // Open: focus the close button; Escape closes; Tab stays inside (aria-modal).
  useEffect(() => {
    if (!openId) return undefined;
    const sheet = sheetRef.current;
    sheet?.querySelector<HTMLElement>('[data-testid="phone-job-close"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab' || !sheet) return;
      const all = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!all.length) return;
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openId, close]);

  if (!jobs.length && !open) return null;
  return (
    <div className="phone-jobs" data-testid="phone-jobs" aria-label={t('super.phoneJobs.title')} role="group">
      <div className="phone-jobs-list">
        {jobs.map((j) => (
          <button
            key={j.conversationId}
            type="button"
            className="phone-jobs-row"
            data-testid="phone-job-row"
            data-state={j.state}
            aria-haspopup="dialog"
            onClick={(e) => { rowRef.current = e.currentTarget; setTapped(j); }}
          >
            <span className="phone-jobs-dot" aria-hidden />
            <span className="phone-jobs-name">{j.title}</span>
            <span className="phone-jobs-state">{t(jobStateKey(j.state))}</span>
          </button>
        ))}
      </div>
      {open && (
        <div className="phone-agenda-layer">
          <div className="phone-agenda-backdrop" onClick={close} aria-hidden />
          <div ref={sheetRef} className="phone-agenda-sheet phone-job-sheet" role="dialog" aria-modal="true" aria-label={open.title} data-testid="phone-job-sheet">
            <div className="phone-job-head">
              <span className="phone-jobs-name phone-agenda-title">{open.title}</span>
              <span className="phone-jobs-state">{t(jobStateKey(open.state))}</span>
              <button type="button" className="phone-agenda-close" data-testid="phone-job-close" aria-label={t('super.phoneJobs.close')} onClick={close}>
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <path d="M5 5l10 10M15 5L5 15" />
                </svg>
              </button>
            </div>
            <div className="phone-job-body">
              <ChildTranscript key={open.conversationId} claudeId={open.conversationId} live={open.state !== 'done'} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
