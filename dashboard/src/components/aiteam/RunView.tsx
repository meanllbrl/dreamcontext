import { useI18n } from '../../context/I18nContext';
import { useAgentThread } from '../../hooks/useAutomations';
import { FoldedReport } from '../agents/FoldedReport';

/** A run's published document, in place. Needs no session, so every run with a document has it. */
export function RunReport({ slug, runId, onOpenFile }: { slug: string; runId: string; onOpenFile?: (path: string) => void }) {
  const { t } = useI18n();
  const thread = useAgentThread(slug, runId);
  const answer = thread.data?.answer ?? null;
  if (thread.isError) {
    return (
      <div className="run-view-note" role="alert" data-run-report-failed>
        <span>{t('aiteam.run.reportFailed')}</span>
        <button type="button" className="chat-feed-link" onClick={() => { void thread.refetch(); }}>{t('aiteam.history.retry')}</button>
      </div>
    );
  }
  if (thread.isLoading) return <div className="run-view-note">{t('aiteam.history.loading')}</div>;
  if (!answer?.text) return <div className="run-view-note" data-run-report-none>{t('aiteam.run.noReport')}</div>;
  return <div className="run-report" data-testid="run-report"><FoldedReport text={answer.text} onOpenFile={onOpenFile} /></div>;
}
