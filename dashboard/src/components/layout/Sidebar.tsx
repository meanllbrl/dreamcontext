import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { BrandMark } from '../brand/BrandMark';
import { NavIcon } from './NavIcons';
import './Sidebar.css';

/** The active vault's display name, as passed by the launcher via `?vault=`. */
function readVaultLabel(): string {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search).get('vault') ?? '';
  } catch {
    return '';
  }
}

export type Page = 'tasks' | 'roadmap' | 'core' | 'knowledge' | 'features' | 'sleep' | 'brain' | 'council' | 'settings' | 'packs' | 'about' | 'taxonomy';

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  /** Collapsed state, owned by the Shell and toggled from the title bar. */
  collapsed: boolean;
}

interface NavItem { page: Page; labelKey: string; lab?: boolean; beta?: boolean }
interface NavGroup { labelKey: string; items: NavItem[] }

// Grouped by job-to-be-done so the rail reads as a scannable hierarchy rather
// than one flat list of 9+ items:
//   Workspace    — daily surfaces you actively drive (ask/recall, tasks, debate)
//   Memory       — the brain's stored content you curate
//   Brain        — the brain's shape & health (graph + consolidation)
//   Control Panel— config / packs
// Naming: "Sleepy" stays the ask/recall surface; the consolidation page is
// "Sleep Cycle" (not "Sleep State") to avoid colliding with "Sleepy"; the graph
// is "Map" (not "Brain") to avoid Brain-in-Brain.
const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'nav.group.workspace',
    items: [
      { page: 'tasks', labelKey: 'nav.tasks' },
      { page: 'roadmap', labelKey: 'nav.roadmap', beta: true },
      { page: 'council', labelKey: 'nav.council', lab: true },
    ],
  },
  {
    labelKey: 'nav.group.memory',
    items: [
      { page: 'core', labelKey: 'nav.core' },
      { page: 'knowledge', labelKey: 'nav.knowledge' },
      { page: 'features', labelKey: 'nav.features' },
      { page: 'taxonomy', labelKey: 'nav.taxonomy' },
    ],
  },
  {
    labelKey: 'nav.group.brain',
    items: [
      { page: 'brain', labelKey: 'nav.brain' },
      { page: 'sleep', labelKey: 'nav.sleep' },
    ],
  },
  {
    labelKey: 'nav.group.control',
    items: [
      { page: 'packs', labelKey: 'nav.packs' },
      { page: 'settings', labelKey: 'nav.settings' },
    ],
  },
];

// One-time first-run nudge: the "What is this?" entry pulses until the user
// opens it once, then this flag persists so it never nags again.
const ABOUT_SEEN_STORAGE_KEY = 'dreamcontext.dashboard.aboutSeen';

function readAboutSeen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ABOUT_SEEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function Sidebar({ activePage, onNavigate, collapsed }: SidebarProps) {
  const { t } = useI18n();
  // aboutSeen: whether the user has opened "What is this?" at least once.
  // Until then, the entry bounces to invite the first click.
  const [aboutSeen, setAboutSeen] = useState<boolean>(readAboutSeen);

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

  const vaultLabel = readVaultLabel();

  return (
    <nav className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`} aria-label="Primary">
      {/* Brand lockup — the dream gem + wordmark + active vault. */}
      <div className="sidebar-brand" title="dreamcontext">
        <BrandMark size={30} glow />
        <div className="sidebar-brand-text">
          <span className="sidebar-brand-word">dream<span>context</span></span>
          {vaultLabel && <span className="sidebar-brand-vault">{vaultLabel}</span>}
        </div>
      </div>

      {NAV_GROUPS.map((group) => (
        <div key={group.labelKey} className="sidebar-group">
          <span className="sidebar-group-label">{t(group.labelKey)}</span>
          <ul className="sidebar-nav">
            {group.items.map(({ page, labelKey, lab, beta }) => {
              staggerIndex += 1;
              const label = t(labelKey);
              const tag = lab ? t('nav.lab') : beta ? t('nav.beta') : null;
              return (
                <li key={page} className={`animate-stagger animate-stagger-${staggerIndex}`}>
                  <button
                    className={`sidebar-item ${activePage === page ? 'sidebar-item--active' : ''}`}
                    onClick={() => onNavigate(page)}
                    title={tag ? `${label} — ${tag}` : label}
                    aria-current={activePage === page ? 'page' : undefined}
                  >
                    <span className="sidebar-icon"><NavIcon page={page} /></span>
                    <span className="sidebar-label">{label}</span>
                    {lab && <span className="sidebar-lab-tag">{t('nav.lab')}</span>}
                    {beta && <span className="sidebar-lab-tag sidebar-beta-tag">{t('nav.beta')}</span>}
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
          <span className="sidebar-icon"><NavIcon page="about" /></span>
          <span className="sidebar-label">{t('nav.about')}</span>
        </button>
      </div>
    </nav>
  );
}
