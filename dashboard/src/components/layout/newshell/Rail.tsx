import { useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useVault } from '../../../context/VaultContext';
import { openAgentSurface } from '../../../lib/agentSettings';
import { useSuperUnreadCount } from '../../sleepy/super/superUnreadStore';
import { PAGE_LABEL_KEY } from '../../../lib/pageLabels';
import { useIsNarrowWindow } from '../../../hooks/useIsNarrowWindow';
import { CanvasIcon, ChatIcon, CheckedBoxIcon, MoreDotsIcon, NavIcon } from '../NavIcons';
import { RailTip } from '../RailTip';
import type { useNavBadges } from '../useNavBadges';
import type { Page } from '../Sidebar';
import { MoreMenu } from './MoreMenu';
import { BOTTOM_BAR, MORE_PAGES, RAIL_ENTRIES, RAIL_FOOT, morePagesNarrow, railPageOf } from './railModel';

/** The new rail draws the prototype's glyph where it differs from the classic sidebar's. */
function RailIcon({ page }: { page: Page }) {
  if (page === 'tasks') return <CheckedBoxIcon />;
  if (page === 'whiteboards') return <CanvasIcon />;
  return <NavIcon page={page} />;
}

interface RailProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  /** The project's badges, from `useNavBadges` held by the caller for the project's lifetime. */
  badges: ReturnType<typeof useNavBadges>;
}

/**
 * The new shell's left rail: icon rows with a tooltip, the page's badges, More, Settings at the
 * foot. Rendered by the ACTIVE instance's `Shell` and portalled into the window's rail slot
 * (`chromeSlots.tsx`), because every badge and every click belong to that project. At 600px and
 * below it becomes a bottom bar of five.
 */
export function Rail({ activePage, onNavigate, badges }: RailProps) {
  const { t } = useI18n();
  const { vault, bus } = useVault();
  // What the owner has not read in this project's Super Agent chat (the pane publishes it).
  const superUnread = useSuperUnreadCount(vault);
  const { unread, agentUnread, learningOff, showChat, chatRollup, chatOpen } = badges;
  const narrow = useIsNarrowWindow(600);
  const railRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const current: Page | null = chatOpen && showChat ? null : railPageOf(activePage);

  const label = (page: Page) => t(PAGE_LABEL_KEY[page]);
  const badgeOf = (page: Page): 'dot' | null => {
    if (page === 'automations' && agentUnread > 0) return 'dot';
    if (page === 'announcements' && unread.length > 0) return 'dot';
    return null;
  };
  const morePages = narrow ? morePagesNarrow() : [...MORE_PAGES];
  const moreCurrent = current !== null && morePages.includes(current);
  const moreBadge = morePages.some((p) => badgeOf(p) !== null);

  const pageRow = (page: Page) => {
    const name = learningOff && page === 'hypotheses' ? `${label(page)} (${t('maturity.off')})` : label(page);
    return (
      <button
        key={page}
        type="button"
        className="ns-rail-btn"
        data-on={current === page ? 'true' : undefined}
        data-off={learningOff && page === 'hypotheses' ? 'true' : undefined}
        aria-current={current === page ? 'page' : undefined}
        aria-label={name}
        data-tip={name}
        data-testid={`ns-rail-${page}`}
        onClick={() => onNavigate(page)}
      >
        <RailIcon page={page} />
        {badgeOf(page) && <span className="ns-rail-badge" aria-hidden="true" />}
      </button>
    );
  };

  const chatRow = () => {
    if (!showChat) return null;
    const unreadLabel = superUnread > 0 ? t('super.unread.count').replace('{n}', String(superUnread)) : '';
    const name = unreadLabel ? `${t('nav.chat')} (${unreadLabel})` : chatRollup.live > 0 ? `${t('nav.chat')} (${chatRollup.live})` : t('nav.chat');
    return (
      <button
        key="chat"
        type="button"
        className="ns-rail-btn"
        data-on={chatOpen ? 'true' : undefined}
        aria-current={chatOpen ? 'page' : undefined}
        aria-label={name}
        data-tip={name}
        data-testid="ns-rail-chat"
        onClick={() => openAgentSurface(bus)}
      >
        <ChatIcon />
        {(chatRollup.waiting > 0 || superUnread > 0) && <span className="ns-rail-badge" aria-hidden="true" />}
      </button>
    );
  };

  const moreRow = () => (
    <button
      key="more"
      ref={moreRef}
      type="button"
      className="ns-rail-btn"
      data-on={moreOpen || moreCurrent ? 'true' : undefined}
      aria-haspopup="menu"
      aria-expanded={moreOpen}
      aria-label={t('nav.more')}
      data-tip={t('nav.more')}
      data-testid="ns-rail-more"
      onClick={() => setMoreOpen((o) => !o)}
    >
      <MoreDotsIcon />
      {moreBadge && <span className="ns-rail-badge" aria-hidden="true" />}
    </button>
  );

  return (
    <nav ref={railRef} className="ns-rail" data-narrow={narrow ? 'true' : undefined} aria-label="Primary" data-testid="ns-rail">
      <RailTip railRef={railRef} enabled={!narrow} />
      {narrow
        ? BOTTOM_BAR.map((e) => (e === 'chat' ? chatRow() : e === 'more' ? moreRow() : pageRow(e)))
        : (
          <>
            {RAIL_ENTRIES.map((e, i) => (
              e.kind === 'chat' ? chatRow()
                : e.kind === 'more' ? moreRow()
                  : e.kind === 'sep' ? <hr key={`sep-${i}`} className="ns-rail-sep" />
                    : pageRow(e.page)
            ))}
            <div className="ns-rail-grow" />
            {pageRow(RAIL_FOOT)}
          </>
        )}
      {moreOpen && (
        <MoreMenu
          anchor={moreRef.current}
          pages={morePages}
          current={current}
          unread={unread.length}
          label={label}
          icon={(p) => <RailIcon page={p} />}
          onPick={(p) => { setMoreOpen(false); onNavigate(p); }}
          onClose={() => setMoreOpen(false)}
        />
      )}
    </nav>
  );
}
