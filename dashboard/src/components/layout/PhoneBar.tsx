import { useI18n } from '../../context/I18nContext';
import { useVault } from '../../context/VaultContext';
import { openAgentSurface } from '../../lib/agentSettings';
import { ChatIcon } from './NavIcons';
import { PAGE_LABEL_KEY, type Page } from './Sidebar';
import './PhoneBar.css';

/**
 * The phone's ONE top bar (body[data-phone]): the page menu, the page's name, and Chat. It
 * replaces the window chrome (a phone has no window) and the rail (a drawer here), so a page
 * starts 44px below the safe area instead of under two rows of desktop chrome.
 */
export function PhoneBar({ page, menuOpen, onMenu }: { page: Page; menuOpen: boolean; onMenu: () => void }) {
  const { t } = useI18n();
  const { bus } = useVault();
  return (
    <header className="phone-bar" data-testid="phone-bar">
      <button
        type="button"
        className="phone-bar-btn"
        onClick={onMenu}
        aria-label={t('nav.menu')}
        aria-expanded={menuOpen}
        data-testid="phone-menu"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M3 5.5h14M3 10h14M3 14.5h14" />
        </svg>
      </button>
      <h1 className="phone-bar-title">{t(PAGE_LABEL_KEY[page])}</h1>
      <button
        type="button"
        className="phone-bar-btn"
        onClick={() => openAgentSurface(bus)}
        aria-label={t('nav.chat')}
        data-testid="phone-chat"
      >
        <ChatIcon />
      </button>
    </header>
  );
}
