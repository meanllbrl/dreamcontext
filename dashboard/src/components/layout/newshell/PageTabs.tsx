import { useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useVault } from '../../../context/VaultContext';
import { openAgentSurface } from '../../../lib/agentSettings';
import { PAGE_LABEL_KEY } from '../../../lib/pageLabels';
import { useIsNarrowWindow } from '../../../hooks/useIsNarrowWindow';
import { useSuperUnreadCount } from '../../sleepy/super/superUnreadStore';
import { CanvasIcon, CheckedBoxIcon, NavIcon } from '../NavIcons';
import type { useNavBadges } from '../useNavBadges';
import type { Page } from '../Sidebar';
import { useChrome } from '../WindowChrome';
import { MoreMenu } from './MoreMenu';
import { litTab, tabsModel } from './railModel';

/** The width at and below which Insights and Apps move into More (tek-kenar C7, a fixed breakpoint). */
export const TABS_NARROW_PX = 900;

function MoreIcon({ page }: { page: Page }) {
  if (page === 'tasks') return <CheckedBoxIcon />;
  if (page === 'whiteboards') return <CanvasIcon />;
  return <NavIcon page={page} />;
}

interface PageTabsProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  badges: ReturnType<typeof useNavBadges>;
}

/**
 * The local new shell's pages as text tabs in the title bar (tek-kenar C7): Chat, Tasks, Insights,
 * Whiteboards, Apps, More ▾. Rendered by the ACTIVE instance's Shell and portalled into the window's
 * `tabs` slot, so every badge and click belong to the project on screen. The lit tab is what that
 * project shows. Device shells keep the rail (`Rail.tsx`).
 */
export function PageTabs({ activePage, onNavigate, badges }: PageTabsProps) {
  const { t } = useI18n();
  const { vault, bus } = useVault();
  const { dismissDrawer } = useChrome();
  const superUnread = useSuperUnreadCount(vault);
  const narrow = useIsNarrowWindow(TABS_NARROW_PX);
  const { tabs, more } = tabsModel(narrow);
  const { agentUnread, learningOff, showChat, chatRollup, chatOpen, appsWaiting } = badges;
  const lit = litTab(activePage, chatOpen, narrow);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const label = (page: Page) => (learningOff && page === 'hypotheses' ? `${t(PAGE_LABEL_KEY[page])} (${t('maturity.off')})` : t(PAGE_LABEL_KEY[page]));
  const dot = (page: Page) => (page === 'apps' && appsWaiting > 0) || (page === 'automations' && agentUnread > 0);
  const moreDot = more.some(dot);

  const tab = (entry: 'chat' | Page) => {
    const on = lit === entry;
    if (entry === 'chat') {
      const unread = superUnread > 0 ? t('super.unread.count').replace('{n}', String(superUnread)) : '';
      const name = unread ? `${t('nav.chat')} (${unread})` : chatRollup.live > 0 ? `${t('nav.chat')} (${chatRollup.live})` : t('nav.chat');
      return (
        <button key="chat" type="button" className="ns-tab" data-no-drag data-on={on ? 'true' : undefined}
          aria-current={on ? 'page' : undefined} aria-label={name} data-testid="ns-tab-chat"
          onClick={() => { dismissDrawer(); openAgentSurface(bus); }}>
          {t('nav.chat')}
          {(chatRollup.waiting > 0 || superUnread > 0) && <span className="ns-tab-dot" aria-hidden="true" />}
        </button>
      );
    }
    return (
      <button key={entry} type="button" className="ns-tab" data-no-drag data-on={on ? 'true' : undefined}
        data-off={learningOff && entry === 'hypotheses' ? 'true' : undefined}
        aria-current={on ? 'page' : undefined} data-testid={`ns-tab-${entry}`}
        onClick={() => { dismissDrawer(); onNavigate(entry); }}>
        {label(entry)}
        {dot(entry) && <span className="ns-tab-dot" aria-hidden="true" />}
      </button>
    );
  };

  return (
    <nav className="ns-tabs" aria-label="Primary" data-testid="ns-tabs" data-narrow={narrow ? 'true' : undefined}>
      {tabs.filter((e) => e !== 'chat' || showChat).map(tab)}
      <button ref={moreRef} type="button" className="ns-tab ns-tab-more" data-no-drag
        data-on={moreOpen || lit === 'more' ? 'true' : undefined} aria-haspopup="menu" aria-expanded={moreOpen}
        data-testid="ns-tab-more" onClick={() => setMoreOpen((o) => !o)}>
        {t('nav.more')}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.8 5 6.6 8 3.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {moreDot && <span className="ns-tab-dot" aria-hidden="true" />}
      </button>
      {moreOpen && (
        <MoreMenu
          anchor={moreRef.current}
          placement="below"
          pages={more}
          current={chatOpen ? null : activePage}
          label={label}
          icon={(p) => <MoreIcon page={p} />}
          onPick={(p) => { setMoreOpen(false); dismissDrawer(); onNavigate(p); }}
          onClose={() => setMoreOpen(false)}
        />
      )}
    </nav>
  );
}
