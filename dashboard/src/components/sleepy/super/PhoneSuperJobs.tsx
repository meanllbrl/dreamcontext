import { useEffect, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { SuperJobWire } from '../../handsfree/macContract';
import { ChildTranscript } from './ChildTranscript';
import './PhoneAgenda.css';

/** The state a job's row says. An idle child has done what it was given. */
export function jobStateKey(state: SuperJobWire['state']): 'super.phoneJobs.working' | 'super.phoneJobs.asking' | 'super.phoneJobs.done' {
  if (state === 'working') return 'super.phoneJobs.working';
  if (state === 'asking') return 'super.phoneJobs.asking';
  return 'super.phoneJobs.done';
}

/**
 * What the Super Agent gave out, on the hands-free phone: the jobs it runs and the ones it just
 * finished, under the agenda strip. The stage does not come to a phone; this list does. It reads
 * the Mac's record (`supers[].jobs` of `live-chats`), and a tap reads that job's transcript
 * through `/agent/chat-history`: nothing here opens a socket to a child or can write to one.
 */
export function PhoneSuperJobs({ jobs }: { jobs: readonly SuperJobWire[] }) {
  const { t } = useI18n();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = jobs.find((j) => j.conversationId === openId) ?? null;

  useEffect(() => {
    if (!openId) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpenId(null); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openId]);

  if (!jobs.length) return null;
  return (
    <div className="phone-jobs" data-testid="phone-jobs" aria-label={t('super.phoneJobs.title')} role="group">
      <div className="phone-jobs-list">
        {jobs.map((j) => (
          <button key={j.conversationId} type="button" className="phone-jobs-row" data-testid="phone-job-row" data-state={j.state} onClick={() => setOpenId(j.conversationId)}>
            <span className="phone-jobs-dot" aria-hidden />
            <span className="phone-jobs-name">{j.title}</span>
            <span className="phone-jobs-state">{t(jobStateKey(j.state))}</span>
          </button>
        ))}
      </div>
      {open && (
        <div className="phone-agenda-layer">
          <div className="phone-agenda-backdrop" onClick={() => setOpenId(null)} aria-hidden />
          <div className="phone-agenda-sheet phone-job-sheet" role="dialog" aria-modal="true" aria-label={open.title} data-testid="phone-job-sheet">
            <div className="phone-job-head">
              <span className="phone-jobs-name phone-agenda-title">{open.title}</span>
              <span className="phone-jobs-state">{t(jobStateKey(open.state))}</span>
              <button type="button" className="phone-agenda-close" data-testid="phone-job-close" aria-label={t('super.phoneJobs.close')} onClick={() => setOpenId(null)}>
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <path d="M5 5l10 10M15 5L5 15" />
                </svg>
              </button>
            </div>
            <div className="phone-job-body">
              <ChildTranscript key={open.conversationId} claudeId={open.conversationId} live={open.state === 'working' || open.state === 'asking'} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
