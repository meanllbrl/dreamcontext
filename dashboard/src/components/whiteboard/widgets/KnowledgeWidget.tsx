import type { KeyboardEvent, ReactNode } from 'react';
import { useKnowledgeList } from '../../../hooks/useKnowledge';
import { emitInstance, useVault } from '../../../context/VaultContext';
import { pageRefKind } from '../../../lib/whiteboardWidgets';
import { knowledgeTitle, pageCardTitle, pageTypeLabel } from '../widgetModel';
import { usePagePopup } from '../PagePopup';
import { useWbText } from '../whiteboardHost';
import { WidgetButton, WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';
import './pageCard.css';

/**
 * A page on the board: a knowledge file (ref = its slug: the entry's title, never the bare slug
 * (A19), and meta) or any project .md / .pdf / .html file (ref = its project-relative path: the
 * file name read as a title, and its folder). The header label says what the page is
 * ("Knowledge", or the file's MD / PDF / HTML), so the body carries no type chip. Opening it, by the Open button or a click on the card once it is active,
 * reads it in the board's page popup; the board stays where it is.
 *
 * A knowledge slug is read from the list query rather than the per-slug one: the list is
 * already cached and polled, and a slug is looked up in it without building a URL from
 * board-supplied text.
 */
export function KnowledgeWidget({ payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const { bus } = useVault();
  const popup = usePagePopup();
  const refKind = pageRefKind(payload.ref);
  const ref = refKind ? (payload.ref as string) : null;
  const isPath = refKind !== null && refKind !== 'knowledge';
  const { data, isLoading, isError } = useKnowledgeList();
  const entry = ref && !isPath ? data?.find((e) => e.slug === ref) : undefined;
  // A stamp that is only the ref or the raw file name (older pickers) reads as no title.
  const title = ref
    ? pageCardTitle(ref, payload.title, entry ? knowledgeTitle(entry) : undefined)
    : tx('whiteboard.kind.knowledge', 'Knowledge');
  // A file states its own type; a knowledge slug keeps the kind's (translated) label.
  const label = isPath ? pageTypeLabel(ref) ?? undefined : undefined;

  const open = () => {
    if (!ref) return;
    if (popup?.openPage({ kind: 'knowledge', ref })) return;
    // Outside a board page there is no popup: a knowledge page still opens where it lives.
    if (!isPath) emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'knowledge', id: ref });
  };
  // A file path has nowhere to open without the popup; a knowledge slug needs its entry.
  const canOpen = !!ref && (isPath ? !!popup : !!entry);

  let body: ReactNode;
  if (!ref) {
    body = <WidgetNotice tone="missing">{tx('whiteboard.widget.badRef', 'This widget has no valid reference.')}</WidgetNotice>;
  } else if (isPath) {
    // The title, then where the file lives as one quiet line: never the raw file name again.
    const folder = ref.includes('/') ? ref.slice(0, ref.lastIndexOf('/')) : '';
    body = (
      <PageBody onOpen={canOpen ? open : undefined}>
        <p className="wb-entity-title">{title}</p>
        {folder && <p className="wb-entity-meta wb-page-card-where" title={ref}>{folder}</p>}
      </PageBody>
    );
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
      <PageBody onOpen={canOpen ? open : undefined}>
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
      </PageBody>
    );
  }

  return (
    <WidgetFrame
      kind="knowledge"
      label={label}
      title={entry || isPath ? '' : title}
      active={active}
      size={size}
      actions={canOpen && (
        <WidgetButton onClick={open}>{tx('whiteboard.widget.open', 'Open')}</WidgetButton>
      )}
    >
      {body}
    </WidgetFrame>
  );
}

/**
 * The card's content, clickable once the widget is active (Excalidraw passes pointer events in
 * only then): a click or Enter/Space reads the page in the popup.
 */
export function PageBody({ onOpen, children }: { onOpen?: () => void; children: ReactNode }) {
  if (!onOpen) return <div className="wb-entity">{children}</div>;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onOpen();
  };
  return (
    <div className="wb-entity wb-entity--open" role="button" tabIndex={0} onClick={onOpen} onKeyDown={onKey}>
      {children}
    </div>
  );
}
