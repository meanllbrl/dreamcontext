import { useI18n } from '../../context/I18nContext';
import './Sidebar.css';

export type Page = 'tasks' | 'core' | 'knowledge' | 'features' | 'sleep' | 'brain' | 'council';

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
}

const NAV_ITEMS: { page: Page; icon: string; labelKey: string }[] = [
  { page: 'brain', icon: '◉', labelKey: 'nav.brain' },
  { page: 'tasks', icon: '▦', labelKey: 'nav.tasks' },
  { page: 'core', icon: '◈', labelKey: 'nav.core' },
  { page: 'knowledge', icon: '✦', labelKey: 'nav.knowledge' },
  { page: 'features', icon: '⚑', labelKey: 'nav.features' },
  { page: 'council', icon: '⚔', labelKey: 'nav.council' },
  { page: 'sleep', icon: '◑', labelKey: 'nav.sleep' },
];

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { t } = useI18n();

  return (
    <nav className="sidebar">
      <ul className="sidebar-nav">
        {NAV_ITEMS.map(({ page, icon, labelKey }, index) => (
          <li key={page} className={`animate-stagger animate-stagger-${index + 1}`}>
            <button
              className={`sidebar-item ${activePage === page ? 'sidebar-item--active' : ''}`}
              onClick={() => onNavigate(page)}
            >
              <span className="sidebar-icon">{icon}</span>
              <span className="sidebar-label">{t(labelKey)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
