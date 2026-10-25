import { useI18n } from '../../context/I18nContext';
import type { HomeRow } from './phoneHome';

/**
 * The phone chat screen's one-line toast (hands-free sekmeler W3): another chat started waiting
 * on the owner. Drawn above the composer, never over it; a tap opens that chat. The live region is
 * always mounted, so a screen reader hears it arrive.
 */
export function PhoneWaitingToast({ row, onOpen }: { row: HomeRow | null; onOpen: () => void }) {
  const { t } = useI18n();
  const title = !row ? '' : row.kind === 'super' ? t('handsfree.super.title') : (row.row.title || t('handsfree.mac.untitled'));
  return (
    <div role="status" aria-live="polite" className="mchat-toast-region">
      {row && (
        <button type="button" className="mchat-toast" data-testid="chat-waiting-toast" onClick={onOpen}>
          <span className="mchat-toast-dot" aria-hidden />
          <span className="mchat-toast-text">{t('handsfree.chat.waitingToast').replace('{title}', () => title)}</span>
          <span className="mchat-toast-go" aria-hidden>{t('handsfree.chat.waitingOpen')} ›</span>
        </button>
      )}
    </div>
  );
}
