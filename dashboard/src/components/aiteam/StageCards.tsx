import { useEffect, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import type { AgentStageView, StageFileKind } from '../../hooks/useAgents';
import { AgentFigure } from '../agents/AgentFigure';
import { plainLine } from './teamModel';

/**
 * The cards around an agent's live conversation on its stage: what it is doing right now, what it
 * delivered last, its routines, and its latest reports. All derived from the stage route; none of
 * them acts as the agent (no agent verbs here), and nothing about their layout is saved.
 */

/** "4 min", "1 h 5 min": how long a job has been running. */
export function elapsedWords(sinceMs: number, nowMs: number, t: (k: string) => string): string {
  const min = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (min < 1) return t('aiteam.stage.justNow');
  if (min < 60) return t('aiteam.stage.min').replace('{n}', String(min));
  return t('aiteam.stage.hourMin').replace('{h}', String(Math.floor(min / 60))).replace('{n}', String(min % 60));
}

/** "Today 09:12", "24 Oct 18:40": when something was posted. */
export function postedWords(iso: string, now: Date, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${time}`;
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

const fileName = (path: string): string => path.split('/').pop() ?? path;

export function RunningCards({ stage, onActivity }: { stage: AgentStageView; onActivity: (slug: string | null) => void }) {
  const { t } = useI18n();
  const now = useNow(30_000);
  if (stage.liveJobs.length === 0) {
    return (
      <section className="aiteam-card aiteam-card--quiet" aria-label={t('aiteam.stage.runningNow')}>
        <p className="aiteam-card-empty">{t('aiteam.stage.idle')}</p>
      </section>
    );
  }
  return (
    <>
      {stage.liveJobs.map((job) => {
        const routine = stage.routines.find((r) => r.slug === job.slug);
        return (
          <section key={job.slug} className="aiteam-card aiteam-card--running" aria-label={job.title}>
            <div className="aiteam-card-head">
              <AgentFigure slug={job.slug} face={routine?.face ?? stage.face} size={24} />
              <span className="aiteam-card-title">{job.title}</span>
              <span className="aiteam-card-state">{t('aiteam.stage.running').replace('{elapsed}', elapsedWords(job.since, now, t))}</span>
            </div>
            <p className="aiteam-card-sub">{routine ? t('aiteam.stage.routineKind') : t('aiteam.stage.callKind')}</p>
            {job.lastLine && <p className="aiteam-card-line">{plainLine(job.lastLine)}</p>}
            <div className="aiteam-card-foot">
              <button type="button" className="aiteam-linkbtn" onClick={() => onActivity(job.slug)}>{t('aiteam.stage.seeActivity')}</button>
            </div>
          </section>
        );
      })}
    </>
  );
}

const KIND_WORD: Record<StageFileKind, string> = {
  doc: 'aiteam.stage.kind.doc',
  board: 'aiteam.stage.kind.board',
  image: 'aiteam.stage.kind.image',
  data: 'aiteam.stage.kind.data',
  other: 'aiteam.stage.kind.other',
};

export function DeliveryCards({ stage, onOpenFile, limit }: { stage: AgentStageView; onOpenFile: (path: string) => void; limit: number }) {
  const { t, locale } = useI18n();
  const now = new Date();
  if (stage.files.length === 0) {
    return (
      <section className="aiteam-card aiteam-card--quiet" aria-label={t('aiteam.stage.deliveries')}>
        <p className="aiteam-card-empty">{t('aiteam.stage.noFiles')}</p>
      </section>
    );
  }
  return (
    <>
      {stage.files.slice(0, limit).map((f) => (
        <button
          key={f.path}
          type="button"
          className="aiteam-card aiteam-card--file"
          data-kind={f.kind}
          onClick={() => onOpenFile(f.path)}
          title={f.path}
        >
          <span className="aiteam-card-head">
            <span className="aiteam-card-title">{t('aiteam.stage.delivered').replace('{kind}', t(KIND_WORD[f.kind]))}</span>
            <span className="aiteam-card-when">{postedWords(f.at, now, locale)}</span>
          </span>
          <span className="aiteam-card-file">{fileName(f.path)}</span>
          <span className="aiteam-card-sub aiteam-card-path">{f.path}</span>
        </button>
      ))}
    </>
  );
}

export function RoutinesCard({ stage, onOpen }: { stage: AgentStageView; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <section className="aiteam-card" aria-label={t('aiteam.stage.routines')}>
      <div className="aiteam-card-head">
        <span className="aiteam-card-title">{t('aiteam.stage.routines')}</span>
        <button type="button" className="aiteam-linkbtn" onClick={onOpen}>{t('aiteam.stage.manage')}</button>
      </div>
      {stage.routines.length === 0 ? (
        <p className="aiteam-card-empty">{t('aiteam.stage.noRoutines')}</p>
      ) : (
        <ul className="aiteam-card-list">
          {stage.routines.map((r) => (
            <li key={r.slug} className="aiteam-card-routine">
              <AgentFigure slug={r.slug} face={r.face} size={20} />
              <span className="aiteam-card-routine-name">{r.title}</span>
              <span className="aiteam-card-sub">{r.enabled ? r.cadence : t('aiteam.stage.paused')}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ReportsCard({ stage, onActivity }: { stage: AgentStageView; onActivity: (slug: string | null) => void }) {
  const { t, locale } = useI18n();
  const now = new Date();
  return (
    <section className="aiteam-card aiteam-card--reports" aria-label={t('aiteam.stage.reports')}>
      <div className="aiteam-card-head">
        <span className="aiteam-card-title">{t('aiteam.stage.reports')}</span>
        <button type="button" className="aiteam-linkbtn" onClick={() => onActivity(null)}>{t('aiteam.stage.openAll')}</button>
      </div>
      {stage.reports.length === 0 ? (
        <p className="aiteam-card-empty">{t('aiteam.stage.noReports')}</p>
      ) : (
        <ul className="aiteam-card-list">
          {stage.reports.map((r) => (
            <li key={r.id}>
              <button type="button" className="aiteam-report" onClick={() => onActivity(r.slug)}>
                <span className="aiteam-card-when">{postedWords(r.at, now, locale)}</span>
                <span className="aiteam-report-text">{plainLine(r.text)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
