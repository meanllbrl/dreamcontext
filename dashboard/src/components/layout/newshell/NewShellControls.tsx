import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { useVault } from '../../../context/VaultContext';
import { SearchIcon } from '../../sleepy/TypeIcons';
import { useChromeSlots } from '../chromeSlots';
import { SleepDebtTracker } from '../SleepDebtTracker';
import { UpdateBadge } from '../UpdateBadge';
import type { Page } from '../Sidebar';
import { useNavBadges } from '../useNavBadges';
import { Rail } from './Rail';

interface NewShellControlsProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  onOpenSearch: () => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

/**
 * One project's part of the new shell's window chrome, portalled into the window's slots the
 * way `Header` does it for the classic bar: the rail, the search button and ← →, the sleep
 * tracker and update badge. They stay mounted HERE, inside this instance's providers, because
 * every one of them is per project. Only the ACTIVE instance renders them (a portal escapes the
 * hidden instance's `inert` shroud).
 */
export function NewShellControls({ activePage, onNavigate, onOpenSearch, canBack, canForward, onBack, onForward }: NewShellControlsProps) {
  const { isActive } = useVault();
  const slots = useChromeSlots();
  const { t } = useI18n();
  // Above the `isActive` return, so it lives as long as the project: the chat surface publishes
  // its rollup and expanded state on CHANGE only, and a rail that remounted on every switch back
  // would start from zero and miss them (no badge, the wrong row lit).
  const badges = useNavBadges();
  if (!isActive) return null;
  return (
    <>
      {slots.rail && createPortal(<Rail activePage={activePage} onNavigate={onNavigate} badges={badges} />, slots.rail)}
      {slots.left && createPortal(
        <>
          <button type="button" className="ns-tb-btn" data-no-drag onClick={onOpenSearch} title={t('shell.search')} aria-label={t('shell.search')} data-testid="ns-search">
            <SearchIcon size={15} />
          </button>
          <span className="ns-tb-nav">
            <button type="button" className="ns-tb-btn" data-no-drag disabled={!canBack} onClick={onBack} title={t('shell.back')} aria-label={t('shell.back')}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M8.5 3 4.5 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button type="button" className="ns-tb-btn" data-no-drag disabled={!canForward} onClick={onForward} title={t('shell.forward')} aria-label={t('shell.forward')}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M5.5 3 9.5 7l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </span>
        </>,
        slots.left,
      )}
      {slots.right && createPortal(
        <>
          <SleepDebtTracker onOpen={() => onNavigate('sleep')} />
          <UpdateBadge onManagePacks={() => onNavigate('packs')} />
        </>,
        slots.right,
      )}
    </>
  );
}
