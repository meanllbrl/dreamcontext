import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi, useVault, emitInstance } from '../context/VaultContext';
import { useI18n } from '../context/I18nContext';
import { isDesktop } from '../lib/desktop';
import { isPhoneSurface } from '../lib/phoneSurface';
import { openAgentSurface } from '../lib/agentSettings';
import { COMPOSER_PREFILL_EVENT } from '../components/sleepy/chat/Composer';
import { useIsNewShell } from '../lib/uxMode';
import { PageBar } from '../components/layout/PageBar';
import { AppCard, type AppRow } from '../components/apps/AppCard';
import './AppsPage.css';

/**
 * Apps (dreamcontext-apps plan r19, W2): this project's local web apps. An app is built only by
 * asking an agent (`/apps`), so the empty state has exactly one action: open Chat with `/apps`
 * ready to send.
 */
export function AppsPage() {
  const api = useApi();
  const { vault, bus } = useVault();
  const { t } = useI18n();
  const newShell = useIsNewShell();
  const qc = useQueryClient();
  const key = ['apps', vault];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ apps: AppRow[]; platform?: string; runner?: boolean; macOnly?: boolean; setup?: { scheduler: boolean; notifications: boolean } }>('/apps'),
    refetchInterval: 3000,
  });
  const canLaunch = isDesktop() && !isPhoneSurface() && !data?.macOnly && (data?.platform ?? 'darwin') === 'darwin';
  const apps = data?.apps ?? [];

  const askAgent = () => {
    openAgentSurface(bus);
    // The surface mounts its composer a beat after it opens: ask a few times until one takes it.
    let tries = 0;
    const ask = () => {
      const detail: { text: string; accepted?: boolean } = { text: '/apps ' };
      emitInstance(bus, COMPOSER_PREFILL_EVENT, detail);
      if (!detail.accepted && ++tries < 10) window.setTimeout(ask, 150);
    };
    window.setTimeout(ask, 60);
  };

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
      {isLoading && <p className="apps-page__muted">{t('apps.loading')}</p>}
      {error && <p className="error-state">{(error as Error).message}</p>}
      {!isLoading && !error && apps.length === 0 && (
        <section className="apps-empty">
          <h2>{t('apps.empty.title')}</h2>
          <p>{t('apps.empty.body')}</p>
          <button type="button" className="apps-empty__cta" onClick={askAgent}>{t('apps.empty.cta')}</button>
        </section>
      )}
      {apps.length > 0 && (
        <div className="apps-grid">
          {apps.map((a) => (
            <AppCard key={a.slug} app={a} vault={vault ?? ''} canLaunch={canLaunch} setup={data?.setup} onChanged={() => void qc.invalidateQueries({ queryKey: key })} />
          ))}
        </div>
      )}
    </div>
  );
}
