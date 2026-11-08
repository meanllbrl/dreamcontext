import { useAgentFeed, useAgentThread } from '../../hooks/useAutomations';
import { AgentFiles } from '../agents/AgentMessage';
import { documentHead } from '../sleepy/chat/chatFeed';

export interface RunDocument { path: string; name: string; head?: string }

/**
 * A run's published document as the Agents feed draws a file: the same card (`AgentFiles`), its
 * opening lines under the name. It opens through `onOpenFile`, the chat's side file panel.
 */
export function RunDocumentTile({ doc, onOpenFile }: { doc: RunDocument; onOpenFile: (path: string) => void }) {
  return (
    <div className="run-doc-tile" data-run-doc={doc.path}>
      <AgentFiles files={[{ path: doc.path, name: doc.name }]} notes={doc.head ? { [doc.path]: doc.head } : undefined} onOpenFile={onOpenFile} layout="feed" />
    </div>
  );
}

/** The same tile for a run known by routine slug and run id (a team job's card): the document
 *  from the Agents feed, its opening lines from the run's thread. Nothing when there is none. */
export function RunDocumentTileFor({ slug, runId, onOpenFile }: { slug: string; runId: string; onOpenFile: (path: string) => void }) {
  const feed = useAgentFeed().data;
  const document = feed?.messages.find((m) => m.slug === slug && m.runId === runId)?.document ?? null;
  const thread = useAgentThread(document ? slug : null, document ? runId : null).data;
  if (!document) return null;
  return <RunDocumentTile doc={{ ...document, head: documentHead(thread?.answer?.text) }} onOpenFile={onOpenFile} />;
}
