import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { SuperJobWire } from '../../handsfree/macContract';
import type { HistoryEntry } from '../chatSession';
import { ChildTranscript, useChildHistory } from './ChildTranscript';
import { PhoneSheet, PhoneSheetClose } from './PhoneSheet';
import './PhoneAgenda.css';

/** The word a job's row says. */
export function jobStateKey(state: SuperJobWire['state']): `super.phoneJobs.${SuperJobWire['state']}` {
  return `super.phoneJobs.${state}`;
}

/** What the agents chip counts: `running` has a process behind it, `asking` of those wait on the owner. */
export function jobCounts(jobs: readonly SuperJobWire[]): { running: number; asking: number } {
  const on = jobs.filter((j) => j.state !== 'done' && j.state !== 'stopped');
  return { running: on.length, asking: on.filter((j) => j.state === 'asking').length };
}

/** Long enough to tell what it did, short enough for a glance; the chat has the rest. */
const LAST_OUTPUT_MAX = 600;

/** The last thing the agent wrote: its words only, never a tool call. Null when it wrote nothing. */
export function lastOutput(items: readonly HistoryEntry[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const h = items[i];
    const text = h.kind === 'text' ? h.text?.trim() : '';
    if (!text) continue;
    return text.length <= LAST_OUTPUT_MAX ? text : `…${text.slice(-LAST_OUTPUT_MAX).trimStart()}`;
  }
  return null;
}

function JobCard({ job, onOpenChat }: { job: SuperJobWire; onOpenChat: () => void }) {
  const { t } = useI18n();
  const history = useChildHistory(job.conversationId, job.state !== 'done');
  const last = history.data ? lastOutput(history.data) : null;
  return (
    <div className="phone-job-card" data-testid="phone-job-card">
      <h3 className="phone-job-label">{t('super.phoneJobs.lastOutput')}</h3>
      <p className="phone-job-last" data-testid="phone-job-last" data-empty={last ? undefined : 'true'}>
        {last ?? t(history.isLoading ? 'super.phoneJobs.reading' : 'super.phoneJobs.noOutput')}
      </p>
      <button type="button" className="phone-job-open" data-testid="phone-job-open-chat" onClick={onOpenChat}>
        {t('super.phoneJobs.openChat')}
      </button>
    </div>
  );
}

/**
 * What the Super Agent gave out, on the hands-free phone: a chip in the chat's header and a sheet
 * listing the jobs it runs and the ones it just finished. A tap shows one job, its state and last
 * output, and from there its whole chat. The stage does not come to a phone; this does. It reads
 * the Mac's record (`supers[].jobs` of `live-chats`) and `/agent/chat-history`: nothing here opens
 * a socket to a child or can write to one, so the chat it opens is read only.
 */
export function PhoneSuperJobs({ jobs, onScreen }: {
  jobs: readonly SuperJobWire[];
  /** The chat is on screen. Off (a link opened the drawer or another project): no sheet stays up. */
  onScreen: boolean;
}) {
  const { t } = useI18n();
  const [listOpen, setListOpen] = useState(false);
  // The job as it was tapped: it may leave the list while it is being read.
  const [tapped, setTapped] = useState<SuperJobWire | null>(null);
  const [chat, setChat] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const open = tapped ? (jobs.find((j) => j.conversationId === tapped.conversationId) ?? tapped) : null;

  const close = useCallback(() => {
    setListOpen(false);
    setTapped(null);
    setChat(false);
    requestAnimationFrame(() => chipRef.current?.focus({ preventScroll: true }));
  }, []);
  useEffect(() => {
    if (onScreen) return;
    setListOpen(false);
    setTapped(null);
    setChat(false);
  }, [onScreen]);
  const back = () => { setTapped(null); setChat(false); };

  if (!jobs.length && !listOpen) return null;
  const { running, asking } = jobCounts(jobs);
  const summary = [
    ...(asking > 0 ? [t('super.phoneJobs.asking.count').replace('{n}', String(asking))] : []),
    t('super.phoneJobs.running').replace('{n}', String(running)),
  ].join(' · ');

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="phone-chip phone-chip--agents"
        data-testid="phone-agents-chip"
        data-waiting={asking > 0 ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-expanded={listOpen}
        aria-label={`${t('super.phoneJobs.chip')}: ${summary}`}
        title={t('super.phoneJobs.open')}
        onClick={() => setListOpen(true)}
      >
        <span className="phone-chip-label">{t('super.phoneJobs.chip')}</span>
        <span className="phone-chip-count" data-testid="phone-agents-count">
          {asking > 0 && <span className="phone-chip-dot" aria-hidden />}
          {running}
        </span>
      </button>
      {listOpen && onScreen && (
        <PhoneSheet
          testId="phone-agents-sheet"
          label={open?.title ?? t('super.phoneJobs.title')}
          className={chat ? 'phone-job-sheet' : undefined}
          focusKey={open ? `${open.conversationId}:${chat}` : 'list'}
          onClose={close}
          handle={open ? (
            <div className="phone-job-head">
              <button type="button" className="phone-agenda-close phone-job-back" data-testid="phone-job-back" aria-label={t('super.phoneJobs.backToList')} onClick={back}>
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12.5 4.5L7 10l5.5 5.5" />
                </svg>
              </button>
              <span className="phone-jobs-name phone-agenda-title">{open.title}</span>
              <span className="phone-jobs-state" data-testid="phone-job-state">{t(jobStateKey(open.state))}</span>
              <PhoneSheetClose testId="phone-job-close" label={t('super.phoneJobs.close')} onClick={close} />
            </div>
          ) : (
            <div className="phone-agenda-head">
              <div className="phone-agenda-titles">
                <h2 className="phone-agenda-title">{t('super.phoneJobs.title')}</h2>
                <span className="phone-agenda-sub">{summary}</span>
              </div>
              <PhoneSheetClose testId="phone-agents-close" label={t('super.phoneJobs.close')} onClick={close} />
            </div>
          )}
        >
          {!open && (
            <div className="phone-agenda-body">
              {jobs.length === 0 && <p className="phone-job-last" data-empty="true">{t('super.phoneJobs.none')}</p>}
              {jobs.map((j) => (
                <button
                  key={j.conversationId}
                  type="button"
                  className="phone-jobs-row"
                  data-testid="phone-job-row"
                  data-state={j.state}
                  onClick={() => setTapped(j)}
                >
                  <span className="phone-jobs-dot" aria-hidden />
                  <span className="phone-jobs-name">{j.title}</span>
                  <span className="phone-jobs-state">{t(jobStateKey(j.state))}</span>
                </button>
              ))}
            </div>
          )}
          {open && !chat && <div className="phone-agenda-body"><JobCard job={open} onOpenChat={() => setChat(true)} /></div>}
          {open && chat && (
            <div className="phone-job-body" data-testid="phone-job-chat">
              {/* The sheet is on the body; the phone's chat rules (MobileChat.css) hang off this. */}
              <div className="agent-surface phone-job-scope" data-mobile="true">
                <ChildTranscript key={open.conversationId} claudeId={open.conversationId} live={open.state !== 'done'} />
              </div>
            </div>
          )}
        </PhoneSheet>
      )}
    </>
  );
}
