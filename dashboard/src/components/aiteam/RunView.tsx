import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAgentThread } from '../../hooks/useAutomations';
import { FoldedReport } from '../agents/FoldedReport';
import { ChildTranscript, useChildHistory } from '../sleepy/super/ChildTranscript';
import { runViewItems } from './agentHistory';

/** Is the element on screen? Off screen a running run stops asking the server. */
function useOnScreen<T extends Element>(): { ref: React.RefObject<T | null>; on: boolean } {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new IntersectionObserver((rows) => { const last = rows[rows.length - 1]; if (last) setOn(last.isIntersecting); });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return { ref, on };
}

/**
 * THE STEPS OF A RUN, in place: the run's own transcript in the pane a finished child's card
 * shows, read only, without the prompt the runner composed (that is the run's instructions, not
 * something the owner said). A running run re-reads every 4 s only while it is on screen. The
 * server decides what a phone gets (`phoneRunItems`): there it is the agent's words and tool names.
 */
export function RunView({ claudeId, live = false, endSlot }: { claudeId: string; live?: boolean; endSlot?: ComponentProps<typeof ChildTranscript>['endSlot'] }) {
  const { t } = useI18n();
  const { ref, on } = useOnScreen<HTMLDivElement>();
  const shownLive = live && on;
  const history = useChildHistory(claudeId, shownLive);
  if (history.isError && !history.data) {
    return (
      <div className="run-view-note" role="alert" data-run-view-failed ref={ref}>
        <span>{t('aiteam.run.stepsFailed')}</span>
        <button type="button" className="chat-feed-link" onClick={() => { void history.refetch(); }}>{t('aiteam.history.retry')}</button>
      </div>
    );
  }
  if (history.data && runViewItems(history.data).length === 0) {
    return <div className="run-view-note" data-run-view-empty ref={ref}>{t('aiteam.run.noSteps')}</div>;
  }
  return (
    <div className="run-view" data-testid="run-view" ref={ref}>
      <ChildTranscript key={claudeId} claudeId={claudeId} live={shownLive} foot="own" prepare={runViewItems} endSlot={endSlot} />
    </div>
  );
}

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
