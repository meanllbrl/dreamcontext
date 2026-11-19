import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { COPIED_MS, copyTaskSlug } from '../../lib/taskDelete';
import './TaskDeleteDialog.css';

/**
 * A small copy icon that puts the task's slug on the clipboard (only the slug) and shows a
 * check with "Copied" for 1.5 s. It never opens the task it sits on: the click and the pointer
 * down stop here, so a board card or a subtask row under it stays shut.
 */
export function CopySlugButton({ slug, className = '' }: { slug: string; className?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<'' | 'ok' | 'failed'>('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const label = copied === 'ok' ? t('tasks.copy.copied') : copied === 'failed' ? t('tasks.copy.failed') : t('tasks.copy.label');
  return (
    <button
      type="button"
      className={`task-copy-btn ${copied === 'ok' ? 'task-copy-btn--done' : copied === 'failed' ? 'task-copy-btn--failed' : ''} ${className}`.trim()}
      data-testid="task-copy-slug"
      data-slug={slug}
      title={copied ? label : `${label}: ${slug}`}
      aria-label={label}
      draggable={false}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void copyTaskSlug(slug).then((ok) => {
          setCopied(ok ? 'ok' : 'failed');
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(''), COPIED_MS);
        });
      }}
    >
      {copied === 'ok' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>
      )}
      {/* Always in the DOM, so a screen reader announces the text when it appears. */}
      <span className="task-copy-btn-text" role="status" aria-live="polite">{copied ? label : ''}</span>
    </button>
  );
}
