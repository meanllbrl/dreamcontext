import { useUnreleased, useVersions } from '../hooks/useVersions';
import { useI18n } from '../context/I18nContext';
import type { Page } from '../components/layout/Sidebar';
import { ReleaseList, UnreleasedBlock } from '../components/releases/ReleaseList';
import '../components/releases/Releases.css';

/**
 * Releases (plan r3 § 5d): what shipped, and what is done but in no release yet. Read-only,
 * on the existing release routes; the Versions popover this replaces is retired.
 */
export function ReleasesPage({ onNavigate }: { onNavigate: (page: Page, id: string | null) => void }) {
  const { t } = useI18n();
  const releases = useVersions();
  const unreleased = useUnreleased();
  // Settled when each read has an answer, a list or an error: a failed request shows an alert
  // instead of "Loading…" forever, and the page still says it is ready. A failed background
  // refetch keeps the list it already has (the alert is only for a read that never answered).
  const ready = (!!releases.data || releases.isError) && (!!unreleased.data || unreleased.isError);
  const failed = <p className="rel-empty" role="alert">{t('releases.loadFailed')}</p>;
  const loading = <p className="rel-empty">{t('taskPage.loading')}</p>;
  return (
    <div className="rel-page" data-releases-ready={ready ? 'true' : undefined}>
      <h1 className="rel-page-title">{t('nav.releases')}</h1>
      <section className="rel-section" aria-labelledby="rel-unreleased">
        <h2 className="rel-section-title" id="rel-unreleased">{t('releases.unreleased.title')}</h2>
        {unreleased.isError && !unreleased.data ? failed : unreleased.data
          ? <UnreleasedBlock data={unreleased.data} onOpenTask={(slug) => onNavigate('task', slug)} />
          : loading}
      </section>
      <section className="rel-section" aria-labelledby="rel-list">
        <h2 className="rel-section-title" id="rel-list">{t('releases.list.title')}</h2>
        {releases.isError && !releases.data ? failed : releases.data ? <ReleaseList releases={releases.data} /> : loading}
      </section>
    </div>
  );
}
