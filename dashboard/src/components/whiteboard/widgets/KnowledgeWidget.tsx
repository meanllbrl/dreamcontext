import { useKnowledgeList } from '../../../hooks/useKnowledge';
import { emitInstance, useVault } from '../../../context/VaultContext';
import { isValidWidgetRef, knowledgeTitle } from '../widgetModel';
import { useWbText } from '../whiteboardHost';
import { WidgetButton, WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';

/**
 * A knowledge file on the board: its title (never the bare slug, A19) and meta, and an Open button that lands on it in
 * the Knowledge page through the app's existing open-page event (on this project's bus only).
 *
 * Read from the list query rather than the per-slug one: the list is already cached and
 * polled, and a slug is looked up in it without building a URL from board-supplied text.
 */
export function KnowledgeWidget({ payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const { bus } = useVault();
  const ref = isValidWidgetRef(payload.ref) ? payload.ref : null;
  const { data, isLoading, isError } = useKnowledgeList();
  const entry = ref ? data?.find((e) => e.slug === ref) : undefined;
  // A title stamped as the bare slug (older pickers did) reads as no title.
  const stamped = payload.title && payload.title !== ref ? payload.title : '';
  const title = stamped || (entry ? knowledgeTitle(entry) : ref) || tx('whiteboard.kind.knowledge', 'Knowledge');

  let body;
  if (!ref) {
    body = <WidgetNotice tone="missing">{tx('whiteboard.widget.badRef', 'This widget has no valid reference.')}</WidgetNotice>;
  } else if (isLoading) {
    body = <WidgetNotice tone="loading">{tx('whiteboard.widget.loading', 'Loading…')}</WidgetNotice>;
  } else if (isError) {
    body = <WidgetNotice tone="error">{tx('whiteboard.widget.loadFailed', 'Could not load this.')}</WidgetNotice>;
  } else if (!entry) {
    body = (
      <WidgetNotice tone="missing">
        {tx('whiteboard.knowledge.notFound', 'Knowledge not found:')}&nbsp;<code>{ref}</code>
      </WidgetNotice>
    );
  } else {
    // S: the title and one meta line. M and up: the summary under it, then the chips.
    const metaLine = [entry.type, entry.status].filter(Boolean).join(' · ');
    body = (
      <div className="wb-entity">
        <p className="wb-entity-title">{title}</p>
        {size === 's' ? (
          metaLine && <p className="wb-entity-meta">{metaLine}</p>
        ) : (
          <>
            {entry.description && <p className="wb-entity-summary">{entry.description}</p>}
            <div className="wb-widget-meta">
              {entry.type && <span className="wb-widget-chip">{entry.type}</span>}
              {entry.status && <span className="wb-widget-chip">{entry.status}</span>}
              {entry.tags.slice(0, size === 'm' ? 2 : 6).map((tag) => <span key={tag} className="wb-widget-chip">#{tag}</span>)}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <WidgetFrame
      kind="knowledge"
      title={entry ? '' : title}
      active={active}
      size={size}
      actions={entry && (
        <WidgetButton onClick={() => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'knowledge', id: entry.slug })}>
          {tx('whiteboard.widget.open', 'Open')}
        </WidgetButton>
      )}
    >
      {body}
    </WidgetFrame>
  );
}
