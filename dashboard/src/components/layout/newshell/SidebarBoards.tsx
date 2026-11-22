import { useI18n } from '../../../context/I18nContext';
import { DEFAULT_BOARD_SLUG } from '../../../pages/whiteboards/boardSwitcherLogic';
import type { BoardsEntry } from './boardsFanout';
import { boardRowKey, filterBoards } from './drawerModel';

interface SidebarBoardsProps {
  vault: string;
  entry: BoardsEntry | undefined;
  query: string;
  onOpen: (slug: string, el: HTMLElement) => void;
}

/**
 * Another project's boards in the sidebar's boards mode (tek-kenar C6, D8a): the mockup's flat
 * list, name and the Default chip. A row lands on that board in that project through the window's
 * prepare-then-activate move (`data-move`). A failed read says so and blocks no other row.
 */
export function SidebarBoards({ vault, entry, query, onOpen }: SidebarBoardsProps) {
  const { t } = useI18n();
  if (!entry || entry.state === 'loading') return <div className="ns-sb-note" data-testid="sidebar-boards-loading">{t('common.loading')}</div>;
  if (entry.state === 'failed') return <div className="ns-sb-note" data-testid="sidebar-boards-failed">{t('shell.sidebar.boardsFailed')}</div>;
  const rows = filterBoards(entry.boards, query);
  return (
    <div className="ns-sb-boards" data-testid="sidebar-boards" data-vault={vault}>
      {rows.map((b) => (
        <button key={b.slug} type="button" className="ns-dr-row ns-dr-child ns-sb-board" data-move="true"
          data-row-key={boardRowKey(vault, b.slug)} data-testid="sidebar-board-row" data-slug={b.slug}
          title={b.name} onClick={(e) => onOpen(b.slug, e.currentTarget)}>
          <svg className="ns-dr-ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2.5" /><path d="M2 6h12M6.5 6v7.5" /></svg>
          <span className="ns-dr-t">{b.name}</span>
          {b.slug === DEFAULT_BOARD_SLUG && <span className="ns-sb-chip">{t('whiteboard.switcher.default')}</span>}
        </button>
      ))}
    </div>
  );
}
