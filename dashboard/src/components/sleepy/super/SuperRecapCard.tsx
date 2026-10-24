import { Children, useId, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { SuperEventGroup } from './superHandover';
import './superEventLine.css';

/**
 * The recap turn ("while you were away") as its own card (owner 2026-10-23): a header naming
 * it and the super agent's reply inside, OPEN unless the owner hid it. Its open state is the
 * absence of a hide, so a reload or a remount always draws it open. The body is the whole
 * turn (prose, tool runs, question cards); a turn with nothing in it yet draws the header
 * alone. Every other event turn stays a one-line `SuperEventLine`.
 */
export function SuperRecapCard({ group, hidden, onToggle, children }: {
  group: SuperEventGroup;
  hidden: boolean;
  onToggle: (anchor: string) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const id = useId();
  const body = Children.toArray(children);
  const open = !hidden && body.length > 0;
  return (
    <div
      role="group"
      className="super-recap-card"
      data-testid="super-recap-card"
      data-open={open ? 'true' : undefined}
      data-hidden={hidden ? 'true' : undefined}
      aria-labelledby={`${id}-title`}
    >
      <div className="super-recap-card-head">
        <span className="super-recap-card-mark" aria-hidden>◆</span>
        <span className="super-recap-card-title" id={`${id}-title`}>{t('super.recap.title')}</span>
        {group.commands > 0 && (
          <span className="super-event-line-cmds">· {t('super.event.commands').replace('{n}', String(group.commands))}</span>
        )}
        {(body.length > 0 || hidden) && <button
          type="button"
          className="super-event-line-toggle"
          data-testid="super-recap-card-toggle"
          aria-expanded={!hidden}
          aria-describedby={`${id}-title`}
          aria-controls={open ? `${id}-body` : undefined}
          onClick={() => onToggle(group.anchor)}
        >{hidden ? t('super.event.expand') : t('super.event.collapse')}</button>}
      </div>
      {open && <div className="super-recap-card-body" id={`${id}-body`}>{body}</div>}
    </div>
  );
}
