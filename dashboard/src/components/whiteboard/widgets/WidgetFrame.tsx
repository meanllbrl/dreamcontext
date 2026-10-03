import { useEffect, useRef, type ReactNode } from 'react';
import { useWbText } from '../whiteboardHost';
import type { WidgetKind } from '../widgetModel';
import type { WidgetSize } from '../../../lib/whiteboardWidgets';
import './widgets.css';

/**
 * The chrome every widget wears: a rounded card with a quiet header (kind + title) and a body
 * that renders to the widget's grid size (A17, A18).
 *
 * Excalidraw passes pointer events into an embeddable only while it is the `activeEmbeddable`
 * (a click in its centre third, a double-click, or a tap). The "Click to interact" hint is
 * Excalidraw's own, shown only while the pointer is over the centre of an INACTIVE widget
 * (its `activeEmbeddable.state === 'hover'`); `WhiteboardCanvas.css` restyles it with tokens.
 * The card itself carries no hint, so a board of widgets reads as content, not instructions.
 */
export function WidgetFrame({ kind, label: explicitLabel, title, active, size, actions, children }: {
  kind: WidgetKind | 'unknown';
  /** The header label when the kind alone would mislabel the card: a page card over a PDF
   *  says "PDF", not "Knowledge". Shown as given. */
  label?: string;
  title: string;
  active: boolean;
  size?: WidgetSize;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const tx = useWbText();
  const label = explicitLabel || tx(`whiteboard.kind.${kind}`, KIND_LABEL[kind] ?? KIND_LABEL.unknown);
  // A title that only repeats the kind ("Note" on a note) is left out of the header.
  const showTitle = !!title && title.toLowerCase() !== label.toLowerCase();
  return (
    <div
      className={`wb-widget wb-widget--${kind} wb-widget--size-${size ?? 'm'}${active ? ' is-active' : ''}`}
      data-widget-kind={kind}
      data-widget-size={size ?? 'm'}
    >
      <div className="wb-widget-head">
        <span className="wb-widget-kind">{label}</span>
        {showTitle && <span className="wb-widget-title" title={title}>{title}</span>}
        {active && actions && <span className="wb-widget-actions">{actions}</span>}
      </div>
      <div className="wb-widget-body">{children}</div>
    </div>
  );
}

// String-keyed, not `Record<WidgetKind, …>`: a kind added to the contract before its label here
// still compiles and reads "Widget" through the lookup fallback.
const KIND_LABEL: Readonly<Record<string, string>> = {
  insight: 'Insight',
  knowledge: 'Knowledge',
  task: 'Task',
  todo: 'Todo',
  note: 'Note',
  html: 'HTML',
  web: 'Web',
  wiki: 'Wiki',
  unknown: 'Widget',
};

/** A widget's honest non-content state. A dangling ref says "not found", never a blank. */
export function WidgetNotice({ tone, children, onClick }: {
  tone: 'missing' | 'error' | 'empty' | 'loading';
  children: ReactNode;
  /** An empty state that is also the way in (an empty note or HTML block opens its editor). */
  onClick?: () => void;
}) {
  if (onClick) {
    return (
      <button type="button" className={`wb-widget-notice wb-widget-notice--${tone} wb-widget-notice--action`} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <div className={`wb-widget-notice wb-widget-notice--${tone}`} role={tone === 'missing' || tone === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  );
}

export function WidgetButton({ onClick, children, title, disabled }: {
  onClick: () => void;
  children: ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="wb-widget-btn" onClick={onClick} title={title} disabled={disabled}>
      {children}
    </button>
  );
}

/**
 * An empty note or HTML block opens its editor on the same centre click that activates it:
 * the widget only receives pointer events once active, so that click never reaches the card,
 * and "click it, then Edit" would be two steps. Once per activation, so Cancel sticks until the
 * widget is left and entered again.
 */
export function useOpenEditorWhenEmpty(
  active: boolean,
  empty: boolean,
  draft: string | null,
  setDraft: (v: string) => void,
): void {
  const opened = useRef(false);
  useEffect(() => {
    if (!active) { opened.current = false; return; }
    if (opened.current || !empty || draft !== null) return;
    opened.current = true;
    setDraft('');
  }, [active, empty, draft, setDraft]);
}
