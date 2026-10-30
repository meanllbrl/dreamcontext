import { useI18n } from '../../../context/I18nContext';
import type { SuperUnread } from './useSuperUnread';
import './superUnread.css';

/** "↑ 3 unread · go to the first unread" + "Mark as read", over the chat's top edge. Shown only
 *  while something unread is out of view. */
export function SuperUnreadBar({ unread, onJump }: { unread: SuperUnread; onJump: () => void }) {
  const { t } = useI18n();
  if (!unread.edge || unread.count === 0) return null;
  return (
    <div className="super-unread-bar" data-testid="super-unread-bar" role="status">
      <button type="button" className="super-unread-jump" data-testid="super-unread-jump" onClick={onJump}>
        <span aria-hidden>{unread.edge === 'up' ? '↑' : '↓'}</span>
        <span className="super-unread-count">{t('super.unread.count').replace('{n}', String(unread.count))}</span>
        <span className="super-unread-go">· {t('super.unread.go')}</span>
      </button>
      <button type="button" className="super-unread-all" data-testid="super-unread-all" onClick={unread.markAll}>{t('super.unread.markAll')}</button>
    </div>
  );
}
