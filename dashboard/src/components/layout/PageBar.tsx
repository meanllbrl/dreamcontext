import type { ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import './PageBar.css';

interface PageBarProps {
  title: string;
  /** The page's own toolbar (views, filters, actions), drawn on the same row. */
  children?: ReactNode;
  /** Set when the page was opened from a chat link: the bar offers "← Chat" back. */
  onBackToChat?: () => void;
}

/**
 * The new shell's one-row page header (52px, an 18px title, one 1px rule): the page's name and
 * its existing toolbar on a single row. Built in W1 for Project Relations; W2 wraps every other
 * page's toolbar in it.
 */
export function PageBar({ title, children, onBackToChat }: PageBarProps) {
  const { t } = useI18n();
  return (
    <div className="page-bar" data-testid="page-bar">
      {onBackToChat && (
        <button type="button" className="page-bar-back" onClick={onBackToChat} data-testid="page-bar-back">
          {t('shell.backToChat')}
        </button>
      )}
      <h1 className="page-bar-title">{title}</h1>
      {children && <div className="page-bar-tools">{children}</div>}
    </div>
  );
}
