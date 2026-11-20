import type { SuperQueueItem } from '../../../lib/superTypes';
import { useI18n } from '../../../context/I18nContext';
import { askPendingOf } from './superQuestions';

/** The chat's row for a question asked beside the report (K8): its words, and Show, which brings
 *  the docked card into view. */
export function DockedAskRow({ item }: { item: SuperQueueItem }) {
  const { t } = useI18n();
  const show = () => {
    const dock = document.querySelector<HTMLElement>(`[data-testid="super-ask-dock"][data-item="${CSS.escape(item.id)}"]`);
    if (!dock) return;
    dock.setAttribute('data-revealed', 'true');
    window.setTimeout(() => dock.removeAttribute('data-revealed'), 1600);
    dock.querySelector<HTMLElement>('.chat-surveycard-page:not([inert])')?.focus({ preventScroll: true });
  };
  const words = askPendingOf(item).questions[0]?.question || item.ownerText || '';
  return (
    <div className="super-ask-row" data-testid="super-ask-row" data-item={item.id}>
      <span className="super-ask-row-text">{words}</span>
      <span className="super-ask-row-where">{t('super.ask.besideReport')}</span>
      <button type="button" className="super-ask-row-show" data-testid="super-ask-row-show" onClick={show}>{t('super.ask.show')}</button>
    </div>
  );
}
