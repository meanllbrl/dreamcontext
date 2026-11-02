import { Fragment, useRef, useState } from 'react';
import { SidebarTeam } from './SidebarTeam';
import { isMacPhoneSurface } from '../../lib/phoneSurface';
import { useI18n } from '../../context/I18nContext';
import { BrandMark } from '../brand/BrandMark';
import { MaturityTag } from '../common/MaturityTag';
import { NavIcon, ChatIcon } from './NavIcons';
import { RailTip } from './RailTip';
import { GitHubMark } from '../brain/GitHubLogin';
import { useAuthStatus, useBrainStatus } from '../../hooks/useBrainStatus';
import { useNavBadges } from './useNavBadges';
import { BrainSyncControl } from '../brain/BrainSyncControl';
import { useVault } from '../../context/VaultContext';
import { openAgentSurface } from '../../lib/agentSettings';
import { useSuperUnreadCount } from '../sleepy/super/superUnreadStore';
import { readScopedRaw, writeScopedRaw } from '../../lib/scopedStorage';
import './Sidebar.css';

export type Page = 'relations' | 'tasks' | 'roadmap' | 'hypotheses' | 'lab' | 'automations' | 'agents' | 'core' | 'knowledge' | 'sleep' | 'brain' | 'council' | 'settings' | 'packs' | 'taxonomy' | 'announcements' | 'whiteboards' | 'stats' | 'apps';

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page, id?: string) => void;
  /** Collapsed state, owned by the Shell and toggled from the title bar. */
  collapsed: boolean;
}

export { PAGE_LABEL_KEY } from '../../lib/pageLabels';

/** Pages the phone never shows (laptop administration). */
export const PHONE_HIDDEN_PAGES: readonly Page[] = ['settings'];

/**
 * How finished a surface is — ONE field replacing the `lab`/`beta` booleans, and the same
 * vocabulary the composer menu and Settings now speak. See `MaturityTag.tsx` for why "Lab"
 * is gone: the style guide says the `lab` CLI name never surfaces to a user, and the rail
 * was printing it on five rows including the Insights page itself.
 */
export type MaturityLevel = 'alpha' | 'beta' | 'off';

export interface NavItem {
  page: Page;
  labelKey: string;
  maturity?: MaturityLevel;
  /**
   * The one item the product is built around. Emphasis on HUE-NEUTRAL channels only —
   * weight, ink and position — because the rail's colour channel is fully spent (accent =
   * active + unread) and K8 caps the accent budget. See `.sidebar-item[data-hero]`.
   */
  hero?: boolean;
}
/** `hue` is a CSS CUSTOM PROPERTY NAME, not a colour: the group sets `--nav-hue` from it
 *  and `.sidebar-icon` mixes it into a tinted surface. Keeping the name (not the value)
 *  here is what keeps every hue resolving through `tokens.css` in both themes. */
/**
 * A row that LAUNCHES rather than routes. Chat is the always-mounted agent overlay, not a
 * page: making it a route would re-home live PTYs and chat portals on every navigation, which
 * is the one thing `AgentSurface` exists to never do. So the row only asks the surface to
 * expand, and `activePage` never becomes 'chat'.
 */
export interface NavLauncher { launch: 'chat'; labelKey: string }
export interface NavGroup { labelKey: string; hue: string; items: (NavItem | NavLauncher)[] }

// Grouped by job-to-be-done so the rail reads as a scannable hierarchy rather
// than one flat list of 9+ items:
//   Workspace    — daily surfaces you actively drive (ask/recall, tasks, debate)
//   Memory       — the brain's stored content you curate
//   Brain        — the brain's shape & health (graph + consolidation)
//   System       — config / packs / about (was "Control Panel"; the default board took the name)
// Naming: "Sleepy" stays the ask/recall surface; the consolidation page is
// "Sleep Cycle" (not "Sleep State") to avoid colliding with "Sleepy"; the graph
// is "Map" (not "Brain") to avoid Brain-in-Brain.
export const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'nav.group.workspace',
    hue: '--nav-hue-workspace',
    items: [
      // Chat, Tasks, Automations (owner, 2026-10-02): what you drive yourself leads, what
      // runs without you follows. Automations keeps the hero weight, not position.
      // REVERSED (2026-10-12): ad04364c (14998f3a after the history scrub) ("the rail says Automations, not Agents", 2026-09-29)
      // retired "Agents" as a rail word, because next to Chat it named the same page as
      // Automations. That reason is gone: an agent is now its own entity
      // (`_dream_context/agents/<slug>.md`) with its own page, the roster you create, edit,
      // approve and talk to, while Automations is only WHEN an agent runs and on what. So
      // "Agents" returns as its own row, right after the Automations that pick one.
      // Then the beta pages (Insights, Roadmap), and the alpha ones last, so maturity reads
      // top to bottom instead of alternating.
      { launch: 'chat', labelKey: 'nav.chat' },
      { page: 'tasks', labelKey: 'nav.tasks' },
      // NO AI TEAM ROW (plan-r10 1d, owner `uv773y`): each project's members are ONE Ekip row
      // under Chat, opened, switched on/off and seen there; created and edited in "Üyeleri
      // yönet". The `automations` and `agents` page ids stay only as deep-link aliases.
      { page: 'lab', labelKey: 'nav.labpage', maturity: 'beta' },
      { page: 'roadmap', labelKey: 'nav.roadmap', maturity: 'beta' },
      // dreamcontext Apps: this project's own local web apps, each in its own Mac window.
      // Beta, so it sits above the alpha rows (owner rule, 2026-10-02).
      { page: 'apps', labelKey: 'nav.apps', maturity: 'beta' },
      { page: 'hypotheses', labelKey: 'nav.hypotheses', maturity: 'alpha' },
      // "Whiteboard" opens the default board, "Control Panel", directly (A15). The page id
      // stays 'whiteboards': persisted nav state and the chat's appNav deep links carry it.
      { page: 'whiteboards', labelKey: 'nav.whiteboard', maturity: 'alpha' },
      { page: 'council', labelKey: 'nav.council', maturity: 'alpha' },
    ],
  },
  {
    labelKey: 'nav.group.memory',
    hue: '--nav-hue-memory',
    items: [
      { page: 'core', labelKey: 'nav.core' },
      { page: 'knowledge', labelKey: 'nav.knowledge' },
      { page: 'taxonomy', labelKey: 'nav.taxonomy' },
    ],
  },
  {
    labelKey: 'nav.group.brain',
    hue: '--nav-hue-brain',
    items: [
      { page: 'brain', labelKey: 'nav.brain' },
      { page: 'sleep', labelKey: 'nav.sleep' },
    ],
  },
  {
    labelKey: 'nav.group.system',
    hue: '--nav-hue-control',
    items: [
      { page: 'packs', labelKey: 'nav.packs' },
      { page: 'settings', labelKey: 'nav.settings' },
      // 'announcements' is pinned to the footer (below), not this rail — it's an
      // announcement of dreamcontext itself, not a per-project surface.
    ],
  },
];

// Same first-run pattern for the GitHub cloud-sync CTA pinned to the rail footer, but
// PER VAULT: what this CTA *does* (`brain enable`) is per-project, so
// dismissing it in a synced project must not hide it in one that is still unsynced.
const GITHUB_SYNC_SEEN_STORAGE_KEY = 'dreamcontext.dashboard.githubSyncSeen';

export function Sidebar({ activePage, onNavigate, collapsed }: SidebarProps) {
  // Mac mode's tunnel, phone OR remote computer (hands-free sekmeler W2): Settings and the brain's
  // GitHub sync are the laptop's administration, never drawn there.
  const tunnel = isMacPhoneSurface();
  const { t } = useI18n();
  // Which project this rail belongs to. Read from the instance, NOT from `?vault=`: the
  // window's URL names the first chip, and several projects render their own rail here.
  const { vault, bus } = useVault();
  const [githubSyncSeen, setGithubSyncSeen] = useState<boolean>(
    () => readScopedRaw(vault, GITHUB_SYNC_SEEN_STORAGE_KEY) === '1',
  );

  const { data: authStatus } = useAuthStatus();
  const { data: brainStatus } = useBrainStatus();
  const { unread, agentUnread, learningOff, showChat, chatRollup, chatOpen } = useNavBadges();
  // What the owner has not read in this project's Super Agent chat (the pane publishes it).
  const superUnread = useSuperUnreadCount(vault);
  // `agents`/`automations` are deep-link aliases now (they open "Üyeleri yönet"): no row lights.
  const current: Page | null = chatOpen && showChat ? null : activePage;
  const vaultLabel = vault ?? '';

  // 3-state cloud-sync CTA: not signed in → invite sign-in; signed in but no
  // remote configured yet → invite setup; connected → the sync control
  // (BrainSyncControl owns the sync row + every failure/handoff surface).
  const signedIn = !!authStatus?.connected;
  const hasRemote = !!brainStatus?.hasRemote;

  const openGithubSync = () => {
    if (!githubSyncSeen) {
      setGithubSyncSeen(true);
      writeScopedRaw(vault, GITHUB_SYNC_SEEN_STORAGE_KEY, '1');
    }
    onNavigate('settings', 'brain');
  };

  const nudgeGithubSync = !githubSyncSeen;

  // Connect / set-up CTA label for the pre-connected states.
  const githubSyncLabel = !signedIn
    ? t('brain.sidebar.connect')
    : !hasRemote
      ? t('brain.sidebar.setup')
      : t('brain.sidebar.synced');

  // Continuous stagger index across groups for the entrance animation.
  let staggerIndex = 0;

  // Collapsed, the label is gone: the row's name moves to `aria-label` (so it keeps an
  // accessible name) and to `data-tip`, which RailTip shows at once. The native `title` is
  // dropped there, or every hover would show the name twice.
  const railRef = useRef<HTMLElement>(null);
  const named = (hint: string) => collapsed
    ? { 'aria-label': hint, 'data-tip': hint }
    : { title: hint };

  return (
    <>
    <nav
      ref={railRef}
      className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}
      aria-label="Primary"
    >
      <RailTip railRef={railRef} enabled={collapsed} />
      {/* Brand lockup — the dream gem + wordmark + active vault. */}
      <div className="sidebar-brand" title="dreamcontext">
        <BrandMark size={30} glow />
        <div className="sidebar-brand-text">
          <span className="sidebar-brand-word">dream<span>context</span></span>
          {vaultLabel && <span className="sidebar-brand-vault">{vaultLabel}</span>}
        </div>
      </div>

      {NAV_GROUPS.map((group) => (
        // The group publishes its hue ONCE, as a custom property; `.sidebar-icon` and
        // `.sidebar-group-label` read `--nav-hue` from the cascade. No per-item plumbing,
        // and a group without a hue falls back to the neutral default in the CSS.
        <div
          key={group.labelKey}
          className="sidebar-group"
          style={{ '--nav-hue': `var(${group.hue})` } as React.CSSProperties}
        >
          <span className="sidebar-group-label">{t(group.labelKey)}</span>
          <ul className="sidebar-nav">
            {group.items.map((item) => {
              if ('launch' in item) {
                if (!showChat) return null;
                staggerIndex += 1;
                const label = t(item.labelKey);
                const { live, waiting } = chatRollup;
                const showUnread = superUnread > 0;
                return (
                  <Fragment key={item.launch}>
                  <li className={`animate-stagger animate-stagger-${staggerIndex}`}>
                    <button
                      className={`sidebar-item sidebar-item--launcher${chatOpen ? ' sidebar-item--active' : ''}`}
                      aria-current={chatOpen ? 'page' : undefined}
                      onClick={() => openAgentSurface(bus)}
                      {...named(showUnread ? `${label} (${t('super.unread.count').replace('{n}', String(superUnread))})` : live > 0 ? `${label} (${live} open)` : label)}
                    >
                      <span className="sidebar-icon"><ChatIcon /></span>
                      <span className="sidebar-label">{label}</span>
                      {/* A COUNT of what is open, not an unread number — so it wears the quiet
                          pill, and only takes the accent when a session is waiting on you. */}
                      {(live > 0 || showUnread) && (
                        <span className="sidebar-item-end">
                          {showUnread
                            ? <span className="sidebar-badge sidebar-badge--count" data-testid="super-unread-badge">{superUnread}</span>
                            : <span className={`sidebar-badge${waiting > 0 ? '' : ' sidebar-badge--quiet'}`}>{live}</span>}
                        </span>
                      )}
                    </button>
                  </li>
                  {/* ONE Ekip row under Chat (plan-r10 1d, r8-05). */}
                  {!tunnel && <SidebarTeam kind="project" />}
                  </Fragment>
                );
              }
              const { page, labelKey, maturity, hero } = item as NavItem;
              if (tunnel && PHONE_HIDDEN_PAGES.includes(page)) return null;
              staggerIndex += 1;
              const label = t(labelKey);
              // An off layer replaces its maturity tag rather than adding a second
              // one — two tags on one row is noise, and "off" is the more
              // useful of the two to whoever is looking.
              const off = page === 'hypotheses' && learningOff;
              const level: MaturityLevel | undefined = off ? 'off' : maturity;
              const tag = level ? t(`maturity.${level}`) : null;
              const badgeCount = page === 'announcements' ? unread.length
                : page === 'automations' ? agentUnread
                  : 0;
              return (
                <li key={page} className={`animate-stagger animate-stagger-${staggerIndex}`}>
                  <button
                    className={`sidebar-item ${current === page ? 'sidebar-item--active' : ''}${off ? ' sidebar-item--off' : ''}`}
                    onClick={() => onNavigate(page)}
                    {...named(tag ? `${label} (${tag})` : label)}
                    aria-current={current === page ? 'page' : undefined}
                    data-hero={hero || undefined}
                  >
                    <span className="sidebar-icon"><NavIcon page={page} /></span>
                    <span className="sidebar-label">{label}</span>
                    {/* The count and the maturity tag STACK at the row's trailing edge, so a long
                        label keeps the width to wrap onto two lines in full (the old "Agentic Automations"
                        read "Agentic A…" beside both). Only rendered when it holds something, so a
                        plain row pays no extra gap. */}
                    {(badgeCount > 0 || level) && (
                      <span className="sidebar-item-end">
                        {badgeCount > 0 && <span className="sidebar-badge">{badgeCount}</span>}
                        <MaturityTag level={level} className="sidebar-maturity" />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {/* Pinned to the bottom. Announcements sits here (not in a nav group)
          because it's an announcement of dreamcontext itself, not a per-project
          surface. Below it: the cloud-sync control — not connected → a single
          connect/set-up button; connected → the sync row: the big button SYNCS
          on click (label shows live status), the gear opens Settings, and a
          teammate-conflict surfaces as a one-click "Resolve with AI" banner. */}
      <div className="sidebar-footer">
        {/* "Projelerden bağımsız": the Global ekip row (plan-r10 1f, r8-12). */}
        {!tunnel && <SidebarTeam kind="global" />}
        <button
          className={`sidebar-item sidebar-item--announcements ${activePage === 'announcements' ? 'sidebar-item--active' : ''}`}
          onClick={() => onNavigate('announcements')}
          {...named(t('nav.announcements'))}
          aria-current={activePage === 'announcements' ? 'page' : undefined}
        >
          <span className="sidebar-icon"><NavIcon page="announcements" /></span>
          <span className="sidebar-label">{t('nav.announcements')}</span>
          {unread.length > 0 && <span className="sidebar-badge">{unread.length}</span>}
        </button>

        {tunnel ? null : signedIn && hasRemote ? (
          <BrainSyncControl onOpenSettings={openGithubSync} />
        ) : (
          <button
            className={`sidebar-item sidebar-item--brain-sync${nudgeGithubSync ? ' sidebar-item--nudge' : ''}`}
            onClick={openGithubSync}
            {...named(githubSyncLabel)}
          >
            <span className="sidebar-icon"><GitHubMark size={14} /></span>
            <span className="sidebar-label">{githubSyncLabel}</span>
          </button>
        )}
      </div>
    </nav>
    </>
  );
}
