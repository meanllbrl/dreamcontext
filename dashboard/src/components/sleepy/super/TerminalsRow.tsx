import { useI18n } from '../../../context/I18nContext';
import type { SessionStatusKind } from '../agentStatus';
import type { Rect } from './superLayout';

export interface TerminalRowItem {
  id: string;
  title: string;
  /** `shell` (a plain terminal) or `agent` (a terminal Claude). */
  kind: string;
  status: SessionStatusKind;
}

/**
 * The tabs a hand-over cannot adopt (plan-r7 D9): terminals are not chats, so the Super Agent
 * cannot read or answer them. They sit as small pills in the bottom band's left side, the dock
 * (plan-r8 F12); clicking one takes the screen back and focuses it.
 */
export function TerminalsRow({ terminals, rect, onOpen }: { terminals: readonly TerminalRowItem[]; rect: Rect; onOpen: (sid: string) => void }) {
  const { t } = useI18n();
  if (terminals.length === 0) return null;
  return (
    <div
      className="super-terminals-row"
      data-testid="super-terminals-row"
      role="toolbar"
      aria-label={t('super.terminals.label')}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <span className="super-terminals-label">{t('super.terminals.label')}</span>
      {terminals.map((term) => (
        <button
          key={term.id}
          type="button"
          className="super-terminal-chip"
          data-kind={term.status}
          title={t('super.terminals.open')}
          onClick={() => onOpen(term.id)}
        >
          <span className="super-terminal-glyph" aria-hidden>{term.kind === 'shell' ? '>_' : '◇'}</span>
          <span className="super-terminal-title">{term.title}</span>
        </button>
      ))}
    </div>
  );
}
