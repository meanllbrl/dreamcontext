import { useI18n } from '../../context/I18nContext';
import { runFootOf, type FeedMeta } from '../sleepy/chat/chatFeed';
import { RunReport, RunView } from './RunView';

/**
 * Under a routine run's last row in a member's conversation: its steps and its full report (the
 * document it published). The AI Team stage's own foot, back on the member's Super page (owner
 * 2026-11-08); "Continue" stays retired, the member's Super chat is where a talk goes.
 */
export function RunFoot({ meta, steps, report, onSteps, onReport, onOpenFile }: {
  meta: FeedMeta;
  steps: boolean;
  report: boolean;
  onSteps: () => void;
  onReport: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const foot = runFootOf(meta);
  if (!foot.steps && !foot.report && !foot.noReport) return null;
  return (
    <div className="run-foot" data-run-foot={meta.sessionKey}>
      <div className="run-foot-row">
        {foot.steps && (
          <button type="button" className="chat-feed-link" aria-expanded={steps} data-run-steps={meta.sessionKey} onClick={onSteps}>
            {t(steps ? 'aiteam.run.hideSteps' : 'aiteam.run.steps')}
          </button>
        )}
        {foot.report && (
          <button type="button" className="chat-feed-link" aria-expanded={report} data-feed-report={meta.sessionKey} onClick={onReport}>
            {t(report ? 'aiteam.run.hideReport' : 'aiteam.history.fullReport')}
          </button>
        )}
        {foot.noReport && <span data-run-no-report={meta.sessionKey}>{t('aiteam.run.noReport')}</span>}
      </div>
      {steps && meta.claudeId && <RunView claudeId={meta.claudeId} live={meta.status === 'running'} />}
      {report && meta.runId && <RunReport slug={meta.source} runId={meta.runId} onOpenFile={onOpenFile} />}
    </div>
  );
}
