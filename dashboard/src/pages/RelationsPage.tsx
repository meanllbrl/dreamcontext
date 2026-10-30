import { useCallback } from 'react';
import { useI18n } from '../context/I18nContext';
import { useChrome } from '../components/layout/WindowChrome';
import { PageBar } from '../components/layout/PageBar';
import { LauncherOpenContext } from '../lib/uxMode';
import { LauncherPage } from './LauncherPage';
import './RelationsPage.css';

/**
 * The new shell's Project Relations page: the Space graph (drag one project onto another to
 * connect them) inside the page frame. Opening a project there lands in THIS window through
 * `addTab`, never in a new window. New shell only; classic never offers the `relations` id.
 */
export function RelationsPage() {
  const { t } = useI18n();
  const chrome = useChrome();
  const open = useCallback((name: string) => { void chrome.addTab(name); }, [chrome]);
  return (
    <div className="relations-page" data-testid="relations-page">
      <PageBar title={t('nav.relations')} />
      <LauncherOpenContext.Provider value={open}>
        <LauncherPage embedded={{}} />
      </LauncherOpenContext.Provider>
    </div>
  );
}
