import { useI18n } from '../../../context/I18nContext';
import { eventLine, type SuperEventGroup } from './superHandover';
import { openJobRow } from './superJobsStore';
import './superEventLine.css';

const KNOWN = ['question', 'done', 'gone', 'stuck', 'recap', 'handover', 'idle', 'fresh'];

/**
 * One event turn in the centre chat as ONE line (plan r4 D2, D8): which job(s) and what
 * happened, "ran N commands" when the super agent used other tools. A name opens the job list
 * at its row; a click on the line expands the super agent's reply (and folds it back). A batch
 * the super agent asked the owner in renders full: this line heads it, nothing is folded.
 */
export function SuperEventLine({ group, titleFor, expanded, onToggle }: {
  group: SuperEventGroup;
  titleFor: (child: string) => string;
  expanded: boolean;
  onToggle: (anchor: string) => void;
}) {
  const { t } = useI18n();
  const words = eventLine(group, titleFor);
  const what = words.kinds.map((k) => t(`super.event.what.${KNOWN.includes(k) ? k : 'other'}`)).join(', ');
  const canFold = !group.full || expanded;
  return (
    <div
      className="super-event-line"
      role="note"
      data-testid="super-event-line"
      data-kind={group.kind}
      data-full={group.full ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
    >
      <span className="super-event-chip-mark" aria-hidden>◆</span>
      {words.names.length > 0 && (
        <span className="super-event-line-names">
          {words.names.map((n, i) => (
            <span key={n.child}>
              {i > 0 && ', '}
              <button type="button" className="super-event-line-name" title={n.title} onClick={() => openJobRow(`c:${n.child}`)}>{n.title}</button>
            </span>
          ))}
          {words.more > 0 && <span className="super-event-line-more"> +{words.more}</span>}
        </span>
      )}
      <span className="super-event-line-what">{what}</span>
      {group.commands > 0 && (
        <span className="super-event-line-cmds">· {t('super.event.commands').replace('{n}', String(group.commands))}</span>
      )}
      {canFold && (group.folded.length > 0 || expanded) && (
        <button
          type="button"
          className="super-event-line-toggle"
          data-testid="super-event-line-toggle"
          aria-expanded={expanded}
          onClick={() => onToggle(group.anchor)}
        >{expanded ? t('super.event.collapse') : t('super.event.expand')}</button>
      )}
    </div>
  );
}
