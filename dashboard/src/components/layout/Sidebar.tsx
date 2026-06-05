import { useState, useEffect } from 'react';
import { useI18n } from '../../context/I18nContext';
import './Sidebar.css';

export type Page = 'tasks' | 'core' | 'knowledge' | 'features' | 'sleep' | 'brain' | 'council' | 'settings' | 'packs' | 'about';

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
}

interface NavItem { page: Page; icon: string; labelKey: string }
interface NavGroup { labelKey: string; items: NavItem[] }

// Grouped so the nav reads as a sensible structure rather than a flat list:
// the project "Workspace" views vs. the "Control Panel" (config/packs).
const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'nav.group.workspace',
    items: [
      { page: 'brain', icon: '◉', labelKey: 'nav.brain' },
      { page: 'tasks', icon: '▦', labelKey: 'nav.tasks' },
      { page: 'knowledge', icon: '✦', labelKey: 'nav.knowledge' },
      { page: 'features', icon: '⚑', labelKey: 'nav.features' },
      { page: 'core', icon: '◈', labelKey: 'nav.core' },
      { page: 'council', icon: '⚔', labelKey: 'nav.council' },
      { page: 'sleep', icon: '◑', labelKey: 'nav.sleep' },
    ],
  },
  {
    labelKey: 'nav.group.control',
    items: [
      { page: 'packs', icon: '◳', labelKey: 'nav.packs' },
      { page: 'settings', icon: '⚙', labelKey: 'nav.settings' },
    ],
  },
];

const COLLAPSE_STORAGE_KEY = 'dreamcontext.dashboard.sidebarCollapsed';
// One-time first-run nudge: the "What is this?" entry pulses until the user
// opens it once, then this flag persists so it never nags again.
const ABOUT_SEEN_STORAGE_KEY = 'dreamcontext.dashboard.aboutSeen';

// CSS cannot drive @media from custom properties in this Vite setup, so 1024
// is a documented literal matching the responsive breakpoint in Sidebar.css.
// Guard against non-browser environments (SSR, jsdom-less test runners).
const NARROW_QUERY =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(max-width: 1024px)')
    : null;

function readUserPref(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function readAboutSeen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ABOUT_SEEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { t } = useI18n();
  // userPref: the user's explicit toggle preference, persisted to localStorage.
  const [userPref, setUserPref] = useState<boolean>(readUserPref);
  // forced: derived from matchMedia; auto-collapses the rail at <=1024px.
  // It never writes to localStorage — it's a viewport state, not a preference.
  const [forced, setForced] = useState<boolean>(NARROW_QUERY?.matches ?? false);
  // aboutSeen: whether the user has opened "What is this?" at least once.
  // Until then, the entry bounces to invite the first click.
  const [aboutSeen, setAboutSeen] = useState<boolean>(readAboutSeen);

  useEffect(() => {
    if (!NARROW_QUERY) return;
    const handler = (e: MediaQueryListEvent) => setForced(e.matches);
    NARROW_QUERY.addEventListener('change', handler);
    return () => NARROW_QUERY.removeEventListener('change', handler);
  }, []);

  // The rendered state is the union: forced viewport OR user preference.
  const collapsed = forced || userPref;

  // Toggle mutates only userPref (persists to localStorage).
  // When forced dominates the toggle is effectively inert, which is acceptable —
  // no overlay/hamburger is added per the design constraints.
  const toggle = () => {
    setUserPref((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // localStorage unavailable — ignore
      }
      return next;
    });
  };

  // Opening "What is this?" retires the first-run nudge for good.
  const openAbout = () => {
    if (!aboutSeen) {
      setAboutSeen(true);
      try {
        window.localStorage.setItem(ABOUT_SEEN_STORAGE_KEY, '1');
      } catch {
        // localStorage unavailable — ignore
      }
    }
    onNavigate('about');
  };

  // The nudge stops once the page has been opened (now or in a past session).
  const nudgeAbout = !aboutSeen && activePage !== 'about';

  // Continuous stagger index across groups for the entrance animation.
  let staggerIndex = 0;

  return (
    <nav className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`} aria-label="Primary">
      <button
        type="button"
        className="sidebar-toggle"
        data-testid="sidebar-collapse"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
        title={collapsed ? t('nav.expand') : t('nav.collapse')}
      >
        <span className="sidebar-toggle-icon">{collapsed ? '»' : '«'}</span>
        <span className="sidebar-label">{t('nav.collapse')}</span>
      </button>

      {NAV_GROUPS.map((group) => (
        <div key={group.labelKey} className="sidebar-group">
          <span className="sidebar-group-label">{t(group.labelKey)}</span>
          <ul className="sidebar-nav">
            {group.items.map(({ page, icon, labelKey }) => {
              staggerIndex += 1;
              const label = t(labelKey);
              return (
                <li key={page} className={`animate-stagger animate-stagger-${staggerIndex}`}>
                  <button
                    className={`sidebar-item ${activePage === page ? 'sidebar-item--active' : ''}`}
                    onClick={() => onNavigate(page)}
                    title={label}
                    aria-current={activePage === page ? 'page' : undefined}
                  >
                    <span className="sidebar-icon">{icon}</span>
                    <span className="sidebar-label">{label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {/* Pinned to the bottom: the "What is this?" explainer / landing page. */}
      <div className="sidebar-footer">
        <button
          className={`sidebar-item sidebar-item--about ${activePage === 'about' ? 'sidebar-item--active' : ''}${nudgeAbout ? ' sidebar-item--nudge' : ''}`}
          onClick={openAbout}
          title={t('nav.about')}
          aria-current={activePage === 'about' ? 'page' : undefined}
        >
          <span className="sidebar-icon">✷</span>
          <span className="sidebar-label">{t('nav.about')}</span>
        </button>
      </div>
    </nav>
  );
}
