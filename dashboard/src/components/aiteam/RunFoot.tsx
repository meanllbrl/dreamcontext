import { useI18n } from '../../context/I18nContext';
import { runFootOf, type FeedMeta } from '../sleepy/chat/chatFeed';
import { RunDocumentTile } from './RunDocumentTile';
import { RunView } from './RunView';

/**
 * Under a routine run's last row in a member's conversation: its steps, and the document it
 * published as a tile that opens in the chat's side file panel (owner 2026-11-08: no underlined
 * "Full report", no inline expand). A run with no document shows nothing extra.
 */
export function RunFoot({ meta, steps, onSteps, onOpenFile }: {
  meta: FeedMeta;
  steps: boolean;
  onSteps: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const foot = runFootOf(meta);
  if (!foot.steps && !foot.document) return null;
  return (
    <div className="run-foot" data-run-foot={meta.sessionKey}>
      {foot.steps && (
        <div className="run-foot-row">
          <button type="button" className="chat-feed-link" aria-expanded={steps} data-run-steps={meta.sessionKey} onClick={onSteps}>
            {t(steps ? 'aiteam.run.hideSteps' : 'aiteam.run.steps')}
          </button>
        </div>
      )}
      {foot.document && onOpenFile && <RunDocumentTile doc={foot.document} onOpenFile={onOpenFile} />}
      {steps && meta.claudeId && <RunView claudeId={meta.claudeId} live={meta.status === 'running'} />}
    </div>
  );
}
