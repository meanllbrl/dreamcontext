import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi, useVault, emitInstance } from '../context/VaultContext';
import { useI18n } from '../context/I18nContext';
import { isDesktop } from '../lib/desktop';
import { isPhoneSurface } from '../lib/phoneSurface';
import { useIsNewShell } from '../lib/uxMode';
import { PageBar } from '../components/layout/PageBar';
import { useState } from 'react';
import { AppPage, AppTile, SetupLine, appIconSrc, type AppRow } from '../components/apps/AppCard';
import { InstallSheet, SharedApps, TrashList, type SharedList } from '../components/apps/ShareSheets';
import { askAgent } from '../components/apps/askAgent';
import { revealPath } from '../lib/reveal';
import './AppsPage.css';

/**
 * Apps (dreamcontext-apps plan r19; store look app-paylasim-magaza r2): two tabs. My apps holds
 * everything on this Mac on two shelves, "Made here" and "From others"; Shared Apps is where an
 * app shared with you is found and got. An app is built only by asking an agent (`/apps`), so the
 * empty state has exactly one action: open Chat with `/apps` ready to send.
 */
/** Beside this Mac's apps (plan-veri K5): a teammate's app (its note only) and a removed app's data. */
type AppOther =
  | { kind: 'team-note'; slug: string; title: string; note: string; knowledgeId: string }
  | { kind: 'orphan-data'; slug: string; dataPath: string };

type Tab = 'mine' | 'shared';

export function AppsPage() {
  const api = useApi();
  const { vault, bus } = useVault();
  const { t } = useI18n();
  const newShell = useIsNewShell();
  const qc = useQueryClient();
  const key = ['apps', vault];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ apps: AppRow[]; others?: AppOther[]; platform?: string; runner?: boolean; macOnly?: boolean; setup?: { scheduler: boolean; notifications: boolean } }>('/apps'),
    refetchInterval: 3000,
  });
  const canLaunch = isDesktop() && !isPhoneSurface() && !data?.macOnly && (data?.platform ?? 'darwin') === 'darwin';
  const apps = data?.apps ?? [];
  const others = data?.others ?? [];
  const own = apps.filter((a) => a.origin !== 'installed');
  const fromOthers = apps.filter((a) => a.origin === 'installed');
  const openNote = (id: string) => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'knowledge', id });
  const revealData = (path: string) => { void revealPath(api, path, 'reveal'); };
  const [tab, setTab] = useState<Tab>('mine');
  // Install: `''` = the link sheet, a repo name = an app from Shared Apps.
  const [installRef, setInstallRef] = useState<string | null>(null);
  const [pageSlug, setPageSlug] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const appsKey = apps.map((a) => `${a.slug}:${a.origin ?? ''}:${a.source ? 'f' : ''}`).join(',');

  // Shared Apps is read once for the tab's count (pending invitations) and the tab itself.
  const sharedKey = ['apps-shared', vault, appsKey];
  const shared = useQuery({
    queryKey: sharedKey,
    queryFn: () => api.get<SharedList>('/apps/shared'),
    enabled: canLaunch,
    staleTime: 60_000,
  });
  const refreshShared = async () => {
    try { qc.setQueryData(sharedKey, await api.get<SharedList>('/apps/shared?refresh=1')); } catch { void shared.refetch(); }
  };
  const invitations = shared.data?.invitations.length ?? 0;
  const pageApp = pageSlug ? apps.find((a) => a.slug === pageSlug) ?? null : null;
  const installedLook = (slug: string) => {
    const a = apps.find((x) => x.slug === slug);
    return a ? { slug: a.slug, name: a.name, icon: appIconSrc(a, vault ?? '', canLaunch), update: !!a.source?.available } : null;
  };

  const shelf = (title: string, rows: AppRow[], id: string) => rows.length > 0 && (
    <section className="apps-shelf" aria-labelledby={id}>
      <div className="apps-shelf__head"><h2 id={id}>{title}</h2></div>
      <div className="apps-tiles">
        {rows.map((a) => <AppTile key={a.slug} app={a} vault={vault ?? ''} canLaunch={canLaunch} onOpen={() => setPageSlug(a.slug)} onChanged={refresh} />)}
      </div>
    </section>
  );

  return (
    <div className={`apps-page${newShell ? ' apps-page--ns' : ''}`}>
      {newShell ? (
        <PageBar flush title={t('nav.apps')} />
      ) : (
        <header className="apps-page__head">
          <h1 className="page-title">{t('nav.apps')}</h1>
          <p className="apps-page__lede">{t('apps.lede')}</p>
        </header>
      )}
      {canLaunch && (
        <div className="apps-tabs">
          <div className="agents-switch" role="tablist" aria-label={t('nav.apps')}>
            <button type="button" role="tab" aria-selected={tab === 'mine'} className={`agents-switch-opt${tab === 'mine' ? ' agents-switch-opt--on' : ''}`} onClick={() => setTab('mine')}>{t('store.tab.mine')}</button>
            <button type="button" role="tab" aria-selected={tab === 'shared'} className={`agents-switch-opt${tab === 'shared' ? ' agents-switch-opt--on' : ''}`} onClick={() => setTab('shared')}>
              {t('store.tab.shared')}
              {invitations > 0 && <span className="apps-tabs__count" aria-label={t('store.tab.pending').replace('{n}', String(invitations))}>{invitations}</span>}
            </button>
          </div>
          <button type="button" className="share-link apps-tabs__act" onClick={() => setInstallRef('')}>{t('store.fromLink')}</button>
        </div>
      )}
      {tab === 'mine' && (
        <>
          {canLaunch && <SetupLine setup={data?.setup} apps={apps} onChanged={refresh} />}
          {isLoading && <p className="apps-page__muted">{t('apps.loading')}</p>}
          {error && <p className="error-state">{(error as Error).message}</p>}
          {!isLoading && !error && apps.length === 0 && (
            <section className="apps-empty">
              <h2>{t('apps.empty.title')}</h2>
              <p>{t('apps.empty.body')}</p>
              <button type="button" className="apps-empty__cta" onClick={() => askAgent(bus, '/apps ')}>{t('apps.empty.cta')}</button>
            </section>
          )}
          {shelf(t('store.madeHere'), own, 'apps-made-h')}
          {shelf(t('store.fromOthers'), fromOthers, 'apps-others-h')}
          {canLaunch && <TrashList key={`t:${appsKey}`} onChanged={refresh} />}
          {others.length > 0 && (
            <ul className="apps-others" aria-label={t('apps.others.label')}>
              {others.map((o) => (
                <li key={`${o.kind}:${o.slug}`} className="apps-other">
                  <div className="apps-other__text">
                    <span className="apps-other__name">{o.kind === 'team-note' ? o.title : o.slug}</span>
                    <span className="apps-other__note">{o.kind === 'team-note' ? t('apps.others.teamNote') : t('apps.others.orphan')}</span>
                  </div>
                  {o.kind === 'team-note' ? (
                    <button type="button" className="apps-other__btn" onClick={() => openNote(o.knowledgeId)}>{t('apps.others.openNote')}</button>
                  ) : (
                    <button type="button" className="apps-other__btn" onClick={() => revealData(o.dataPath)}>{t('apps.others.openFolder')}</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {tab === 'shared' && canLaunch && (
        <SharedApps
          list={shared.data ?? null}
          err={shared.error ? (shared.error as Error).message : null}
          loading={shared.isLoading}
          installedLook={installedLook}
          onRefresh={() => void refreshShared()}
          onInstall={(fullName) => setInstallRef(fullName)}
          onOpen={(slug) => setPageSlug(slug)}
          onAccepted={() => { void refreshShared(); refresh(); }}
        />
      )}
      {pageApp && <AppPage key={pageApp.slug} app={pageApp} vault={vault ?? ''} canLaunch={canLaunch} onClose={() => setPageSlug(null)} onChanged={refresh} />}
      {installRef !== null && <InstallSheet key={installRef} initialRef={installRef || undefined} onClose={() => setInstallRef(null)} onDone={(slug) => { setInstallRef(null); refresh(); setTab('mine'); setPageSlug(slug); }} />}
    </div>
  );
}
