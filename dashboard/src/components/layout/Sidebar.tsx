import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import './Sidebar.css';

export type Page = 'tasks' | 'core' | 'knowledge' | 'features' | 'sleep' | 'brain' | 'council' | 'settings' | 'packs';

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

function readCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // localStorage unavailable — ignore
      }
      return next;
    });
  };

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
    </nav>
  );
}
