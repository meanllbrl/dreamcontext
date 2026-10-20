import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { DONE_SHOWN, elapsedLabel, type JobRow, type JobSection } from './superHandover';
import type { Rect } from './superLayout';

export const JOB_SECTIONS: readonly JobSection[] = ['waiting', 'working', 'pool', 'done'];

/**
 * The job list (plan r4 §2), open over the centre's top under the bar: the four sections, each
 * row its title, the super agent's doing/next line, a status chip, how long, its task and its
 * branch. An overlay: the centre never moves. Esc, a click outside or the bar's count closes it.
 * Rows come from the record the bar was handed (0 requests while open). A child row asks for
 * side by side; a task chip opens the task.
 */
export function JobList({ sections, rect, origin, focusSection, focusRow, bar, onClose, onShowChild, onOpenTask }: {
  sections: Record<JobSection, JobRow[]>;
  rect: Rect;
  /** The bar's own rect: the list is placed relative to it (it renders inside the bar). */
  origin: Rect;
  focusSection: JobSection | null;
  focusRow: string | null;
  bar: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onShowChild: (sid: string) => void;
  onOpenTask: (slug: string) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (ref.current?.contains(target) || bar.current?.contains(target))) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [onClose, bar]);
  // Opened at a row (an event line's name) or a section: bring it into view, inside the list only.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sel = focusRow ? `[data-row="${CSS.escape(focusRow)}"]` : focusSection ? `[data-section="${focusSection}"]` : null;
    const target = sel ? el.querySelector<HTMLElement>(sel) : null;
    if (target) el.scrollTop = Math.max(0, target.offsetTop - 8);
  }, [focusRow, focusSection]);
  const now = Date.now();
  return (
    <div
      ref={ref}
      className="super-job-list"
      data-testid="super-job-list"
      role="dialog"
      aria-label={t('super.jobs.label')}
      style={{ left: rect.x - origin.x, top: rect.y - origin.y, width: rect.width, maxHeight: rect.height }}
    >
      {JOB_SECTIONS.map((sec) => {
        const rows = sections[sec];
        const shown = sec === 'done' ? rows.slice(0, DONE_SHOWN) : rows;
        return (
          <section key={sec} className="super-job-section" data-section={sec} data-testid={`super-job-section-${sec}`}>
            <h3 className="super-job-section-title">
              <span>{t(`super.jobs.section.${sec}`)}</span>
              <span className="super-job-section-n">{rows.length}</span>
            </h3>
            {rows.length === 0 && <div className="super-job-empty">{t('super.jobs.empty')}</div>}
            {shown.map((r) => (
              <div
                key={r.key}
                className="super-job-row"
                data-row={r.key}
                data-testid="super-job-row"
                data-chip={r.chip ?? undefined}
                data-super-tone={r.tone ?? undefined}
                data-focus={r.key === focusRow ? 'true' : undefined}
              >
                <span className="super-job-dot" aria-hidden />
                <div className="super-job-main">
                  {r.sid && r.section !== 'waiting'
                    ? <button type="button" className="super-job-title super-job-title--link" title={r.title} onClick={() => onShowChild(r.sid as string)}>{r.title}</button>
                    : <span className="super-job-title" title={r.title}>{r.title}</span>}
                  {r.line && <span className="super-job-line">{r.line}</span>}
                </div>
                <div className="super-job-meta">
                  {r.chip && <span className="super-job-chip" data-chip={r.chip}>{t(`super.jobs.chip.${r.chip}`)}</span>}
                  {r.model && <span className="super-job-tag super-job-tag--model">{r.model}</span>}
                  {r.task && <button type="button" className="super-job-tag super-job-tag--task" onClick={() => onOpenTask(r.task as string)}>{r.task}</button>}
                  {r.branch && <span className="super-job-tag super-job-tag--branch" title={r.branch}>{r.branch}</span>}
                  {r.since ? <span className="super-job-since">{elapsedLabel(now - r.since)}</span> : null}
                </div>
              </div>
            ))}
            {sec === 'done' && rows.length > DONE_SHOWN && (
              <div className="super-job-more">{t('super.queue.more').replace('{n}', String(rows.length - DONE_SHOWN))}</div>
            )}
          </section>
        );
      })}
    </div>
  );
}
