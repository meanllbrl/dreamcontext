import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { BrandMark } from '../brand/BrandMark';
import { NavIcon } from './NavIcons';
import { GitHubMark } from '../brain/GitHubLogin';
import { TeamUpdatesBadge } from '../brain/TeamUpdatesBadge';
import { useAuthStatus, useBrainStatus } from '../../hooks/useBrainStatus';
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

export type Page = 'tasks' | 'roadmap' | 'lab' | 'core' | 'knowledge' | 'sleep' | 'brain' | 'council' | 'settings' | 'packs' | 'about' | 'taxonomy';

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page, id?: string) => void;
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
//   Control Panel— config / packs / about
// Naming: "Sleepy" stays the ask/recall surface; the consolidation page is
// "Sleep Cycle" (not "Sleep State") to avoid colliding with "Sleepy"; the graph
// is "Map" (not "Brain") to avoid Brain-in-Brain.
const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'nav.group.workspace',
    items: [
      { page: 'tasks', labelKey: 'nav.tasks' },
      { page: 'roadmap', labelKey: 'nav.roadmap', beta: true },
      { page: 'lab', labelKey: 'nav.labpage', lab: true },
      { page: 'council', labelKey: 'nav.council', lab: true },
    ],
  },
  {
    labelKey: 'nav.group.memory',
    items: [
      { page: 'core', labelKey: 'nav.core' },
      { page: 'knowledge', labelKey: 'nav.knowledge' },
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
      // 'about' entry ("What is this?") intentionally not in the rail — page/logic kept, just unlinked.
    ],
  },
];

// One-time first-run nudge: the "What is this?" entry pulses until the user
// opens it once, then this flag persists so it never nags again.
const ABOUT_SEEN_STORAGE_KEY = 'dreamcontext.dashboard.aboutSeen';
// Same pattern for the GitHub cloud-sync CTA pinned to the rail footer.
const GITHUB_SYNC_SEEN_STORAGE_KEY = 'dreamcontext.dashboard.githubSyncSeen';

function readFlag(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // localStorage unavailable — ignore
  }
}

export function Sidebar({ activePage, onNavigate, collapsed }: SidebarProps) {
  const { t } = useI18n();
  // aboutSeen: whether the user has opened "What is this?" at least once.
  // Until then, the entry bounces to invite the first click.
  const [aboutSeen, setAboutSeen] = useState<boolean>(() => readFlag(ABOUT_SEEN_STORAGE_KEY));
  const [githubSyncSeen, setGithubSyncSeen] = useState<boolean>(() => readFlag(GITHUB_SYNC_SEEN_STORAGE_KEY));

  const { data: authStatus } = useAuthStatus();
  const { data: brainStatus } = useBrainStatus();
  const vaultLabel = readVaultLabel();

  // Opening "What is this?" retires the first-run nudge for good.
  const openAbout = () => {
    if (!aboutSeen) {
      setAboutSeen(true);
      writeFlag(ABOUT_SEEN_STORAGE_KEY);
    }
    onNavigate('about');
  };

  const openGithubSync = () => {
    if (!githubSyncSeen) {
      setGithubSyncSeen(true);
      writeFlag(GITHUB_SYNC_SEEN_STORAGE_KEY);
    }
    onNavigate('settings', 'brain');
  };

  // The nudge stops once the page has been opened (now or in a past session).
  const nudgeAbout = !aboutSeen && activePage !== 'about';
  const nudgeGithubSync = !githubSyncSeen;

  // 3-state cloud-sync CTA: not signed in → invite sign-in; signed in but no
  // remote configured yet → invite setup; connected → quiet "Synced" / badge.
  const signedIn = !!authStatus?.connected;
  const hasRemote = !!brainStatus?.hasRemote;
  const githubSyncLabel = !signedIn
    ? t('brain.sidebar.connect')
    : !hasRemote
      ? t('brain.sidebar.setup')
      : t('brain.sidebar.synced');

  // Continuous stagger index across groups for the entrance animation.
  let staggerIndex = 0;

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
              const isAbout = page === 'about';
              return (
                <li key={page} className={`animate-stagger animate-stagger-${staggerIndex}`}>
                  <button
                    className={`sidebar-item ${activePage === page ? 'sidebar-item--active' : ''}${isAbout && nudgeAbout ? ' sidebar-item--nudge' : ''}`}
                    onClick={isAbout ? openAbout : () => onNavigate(page)}
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

      {/* Pinned to the bottom: the GitHub cloud-sync CTA — 3 states (connect /
          set up team sync / synced), reusing the team-updates pill once a
          remote is configured so a pending pull surfaces right on the rail. */}
      <div className="sidebar-footer">
        {signedIn && hasRemote ? (
          <div className="sidebar-brain-sync sidebar-brain-sync--connected">
            <TeamUpdatesBadge compact />
            <button
              className="sidebar-item sidebar-item--synced"
              onClick={openGithubSync}
              title={t('brain.sidebar.synced')}
            >
              <span className="sidebar-icon"><GitHubMark size={14} /></span>
              <span className="sidebar-label">{t('brain.sidebar.synced')}</span>
            </button>
          </div>
        ) : (
          <button
            className={`sidebar-item sidebar-item--brain-sync${nudgeGithubSync ? ' sidebar-item--nudge' : ''}`}
            onClick={openGithubSync}
            title={githubSyncLabel}
          >
            <span className="sidebar-icon"><GitHubMark size={14} /></span>
            <span className="sidebar-label">{githubSyncLabel}</span>
          </button>
        )}
      </div>
    </nav>
  );
}
