import { runFootOf, type FeedMeta } from '../sleepy/chat/chatFeed';
import { RunDocumentTile } from './RunDocumentTile';

/**
 * Under a routine run's last row in a member's chat: the document it published, as a tile that
 * opens in the chat's side file panel (owner 2026-11-08: no underlined "Full report", no inline
 * expand). A run with no document shows nothing extra.
 *
 * No steps here (owner 2026-11-14, learned rule h7tjatns3j): a member's chat draws a run as a
 * normal Super turn, so a landed run shows only its answer, and a run in flight the chat's own
 * live steps line (`RunLiveLine`, drawn by the pane). The old "Steps" link opened the run's whole
 * transcript as a second chat in a clipped box under the answer.
 */
export function RunFoot({ meta, onOpenFile }: {
  meta: FeedMeta;
  onOpenFile?: (path: string) => void;
}) {
  const { document } = runFootOf(meta);
  if (!document || !onOpenFile) return null;
  return (
    <div className="run-foot" data-run-foot={meta.sessionKey}>
      <RunDocumentTile doc={document} onOpenFile={onOpenFile} />
    </div>
  );
}
