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
import { revealPath } from '../lib/reveal';
import './AppsPage.css';

/**
 * Apps (dreamcontext-apps plan r19, W2): this project's local web apps. An app is built only by
 * asking an agent (`/apps`), so the empty state has exactly one action: open Chat with `/apps`
 * ready to send.
 */
/** Beside this Mac's apps (plan-veri K5): a teammate's app (its note only) and a removed app's data. */
type AppOther =
  | { kind: 'team-note'; slug: string; title: string; note: string; knowledgeId: string }
  | { kind: 'orphan-data'; slug: string; dataPath: string };

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
  const openNote = (id: string) => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'knowledge', id });
  const revealData = (path: string) => { void revealPath(api, path, 'reveal'); };

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
    </div>
  );
}
