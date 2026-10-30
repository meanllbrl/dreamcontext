import { createContext, useContext, type ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import './PageBar.css';

/**
 * Where the open page came from, for "← Chat" (D12): set by the instance's page router in the
 * new shell. Null outside it (classic, or a page rendered on its own).
 */
export interface PageOrigin {
  fromChat: boolean;
  backToChat: () => void;
}
export const PageOriginContext = createContext<PageOrigin | null>(null);

interface PageBarProps {
  title: string;
  /** The page's own toolbar (views, filters, actions), drawn on the same row. */
  children?: ReactNode;
  /** Set when the page was opened from a chat link: the bar offers "← Chat" back. Defaults to
   *  the page origin the router provides. */
  onBackToChat?: () => void;
  /** Drawn at the top of a padded page: reaches the frame's edges, as the toolbar rows do. */
  flush?: boolean;
}

/** "← Chat", when the page was opened from a chat link. */
function BackToChat({ onBack }: { onBack?: () => void }) {
  const { t } = useI18n();
  const origin = useContext(PageOriginContext);
  const back = onBack ?? (origin?.fromChat ? origin.backToChat : undefined);
  if (!back) return null;
  return (
    <button type="button" className="page-bar-back" onClick={back} data-testid="page-bar-back">
      {t('shell.backToChat')}
    </button>
  );
}

/**
 * The new shell's one-row page header (52px, an 18px title, one 1px rule): the page's name and
 * its existing toolbar on a single row. Pages with a title of their own and no toolbar get this
 * bar; pages with a toolbar row put {@link PageTitle} at the left of that row instead.
 */
export function PageBar({ title, children, onBackToChat, flush }: PageBarProps) {
  return (
    <div className={`page-bar${flush ? ' page-bar--flush' : ''}`} data-testid="page-bar">
      <BackToChat onBack={onBackToChat} />
      <h1 className="page-bar-title">{title}</h1>
      {children && <div className="page-bar-tools">{children}</div>}
    </div>
  );
}

/**
 * The same title, for a page whose toolbar row already exists: put it first in that row (and
 * mark the row `data-page-row`, which gives it the bar's height and rule). New shell only; the
 * caller renders nothing in classic, so classic markup stays byte-identical.
 */
export function PageTitle({ title }: { title: string }) {
  return (
    <>
      <BackToChat />
      <h1 className="page-bar-title page-bar-title--inline" data-testid="page-bar">{title}</h1>
    </>
  );
}
