import { useMemo, useSyncExternalStore } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useVaultId } from '../../../context/VaultContext';
import type { JobsViewSpec } from '../../../lib/chatViewSpec';
import { jobsRows, type JobRow } from '../../../../../src/lib/super/jobs-view.js';
import type { ChatSession } from '../chatSession';
import { readVaultSuperRecords, subscribeSuperRecords } from '../super/superRecordStore';
import { needsOwner, elapsedLabel, lastLineOf } from '../super/superHandover';
import { useSuperQuestions, openJobRow } from '../super/superJobsStore';
import { revealQuestion } from '../super/superQuestions';
import { useLiveSession } from '../super/liveSession';
import type { SuperStateView } from '../../../lib/superTypes';

/**
 * The `jobs` view (plan super-v3 K7, D6): the Super's status answer, drawn from the LIVE record of
 * the Super this chat is (main's or a member's), never from what the agent typed. One row per job:
 * name, its last line and when, what it waits on; Answer on a waiting row (scrolls to its question
 * in this chat), See it on the rest (shows the job beside the chat). No time left anywhere (D4).
 */
export function JobsView({ spec, session }: { spec: JobsViewSpec; session?: ChatSession }) {
  const { t } = useI18n();
  const vault = useVaultId().vault ?? null;
  const superSession = session?.claudeId || null;
  const records = useSyncExternalStore(subscribeSuperRecords, () => readVaultSuperRecords(vault), () => readVaultSuperRecords(vault));
  const record: SuperStateView | null = useMemo(
    () => records.find((r) => superSession && r.record.session === superSession)?.record ?? null,
    [records, superSession],
  );
  const sum = useMemo(() => (record ? jobsRows(record, needsOwner as (q: unknown) => boolean, spec.ids) : null), [record, spec.ids]);
  if (!sum) return <p className="chat-view-notice" data-testid="jobs-view-none">{t('super.jobs.none')}</p>;
  const head = t('super.jobs.head')
    .replace('{n}', String(sum.total)).replace('{w}', String(sum.waiting))
    .replace('{r}', String(sum.running)).replace('{d}', String(sum.done));
  return (
    <section className="chat-jobs" data-testid="jobs-view" aria-label={head}>
      <header className="chat-jobs-head">{head}</header>
      {sum.rows.length === 0
        ? <p className="chat-jobs-empty">{t('super.jobs.empty')}</p>
        : <ul className="chat-jobs-rows">{sum.rows.map((r) => <JobsRow key={r.id} row={r} superSession={superSession} />)}</ul>}
    </section>
  );
}

function JobsRow({ row, superSession }: { row: JobRow; superSession: string | null }) {
  const { t } = useI18n();
  const view = useSuperQuestions(superSession);
  const child = row.kind === 'child' ? view?.sessionFor(row.id) : undefined;
  useLiveSession(child, () => (child ? lastLineOf(child.getModel()?.items ?? []) : ''));
  const items = child?.getModel()?.items ?? [];
  const last = row.waitingOn || lastLineOf(items) || '';
  const when = elapsedLabel(Date.now() - row.at);
  return (
    <li className="chat-jobs-row" data-state={row.state} data-testid="jobs-view-row">
      <span className="chat-jobs-dot" data-state={row.state} aria-hidden />
      <span className="chat-jobs-text">
        <span className="chat-jobs-name">{row.name}</span>
        <span className="chat-jobs-line">
          <span className="chat-jobs-state">{t(`super.jobs.state.${row.state}`)}</span>
          {last && <> · <span className="chat-jobs-last">{last}</span></>}
          {' · '}{when}
        </span>
      </span>
      {row.state === 'waiting' && row.itemId
        ? <button type="button" className="chat-jobs-btn chat-jobs-btn--answer" onClick={() => revealQuestion(row.itemId!)}>{t('super.jobs.answer')}</button>
        : row.kind === 'child' && <button type="button" className="chat-jobs-btn" onClick={() => openJobRow(`c:${row.id}`)}>{t('super.jobs.see')}</button>}
    </li>
  );
}
