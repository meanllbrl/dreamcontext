import { runFootOf, type FeedMeta } from '../sleepy/chat/chatFeed';
import { RunDocumentTile } from './RunDocumentTile';
import { RunStars } from '../sleepy/super/ScorecardCard';

/**
 * Under a routine run's last row in a member's chat: the document it published, as a tile that
 * opens in the chat's side file panel (owner 2026-11-08: no underlined "Full report", no inline
 * expand). A run with no document shows nothing extra. Under a finished run in a member's chat:
 * its stars and note (plan uye-karnesi), read from the Scorecard's shared cache.
 *
 * No steps here (owner 2026-11-14, learned rule h7tjatns3j): a member's chat draws a run as a
 * normal Super turn, so a landed run shows only its answer, and a run in flight the chat's own
 * live steps line (`RunLiveLine`, drawn by the pane). The old "Steps" link opened the run's whole
 * transcript as a second chat in a clipped box under the answer.
 */
export function RunFoot({ meta, onOpenFile, member }: {
  meta: FeedMeta;
  onOpenFile?: (path: string) => void;
  /** The member whose chat this is: a finished run gets its stars and note (the Scorecard). */
  member?: string;
}) {
  const { document } = runFootOf(meta);
  const doc = document && onOpenFile ? document : null;
  const stars = !!member && meta.sessionKind === 'run';
  if (!doc && !stars) return null;
  return (
    <div className="run-foot" data-run-foot={meta.sessionKey}>
      {doc && onOpenFile && <RunDocumentTile doc={doc} onOpenFile={onOpenFile} />}
      {stars && member && <RunStars member={member} sessionKey={meta.sessionKey} request={meta.request} />}
    </div>
  );
}
