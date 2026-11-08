import { useLayoutEffect, useMemo } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../../context/ThemeContext';
import { I18nProvider, useI18n } from '../../context/I18nContext';
import { VaultProvider } from '../../context/VaultContext';
import { ShellModeContext } from '../../lib/uxMode';
import { createInstanceQueryClient } from '../../lib/instanceQueryClient';
import { AiTeamPage } from '../../pages/AiTeamPage';
import { TasksPage } from '../../pages/TasksPage';
import { RoadmapPage } from '../../pages/RoadmapPage';
import { InsightWidget } from '../whiteboard/widgets/InsightWidget';
import { APP_LINK_PAGES, type AppLinkPage } from '../../lib/appLink';
import type { EmbedGrant } from '../../lib/frameGuard';
import { EmbedProvider, openInMainHref } from './embedMode';
import { AppChat } from './AppChat';
import { embedTokens } from './embedTheme';
import './EmbedRoot.css';

const embedBus = new EventTarget();

function EmbedView({ grant }: { grant: EmbedGrant }) {
  const { t } = useI18n();
  // The board's links lead out of this frame: hypotheses are not embedded.
  const leave = useMemo(() => (page: string) => {
    if ((APP_LINK_PAGES as readonly string[]).includes(page)) window.open(openInMainHref(grant.vault, page as AppLinkPage), '_blank');
  }, [grant.vault]);
  switch (grant.view) {
    case 'chat':
      return <AppChat grant={grant} />;
    case 'team':
      return <AiTeamPage />;
    case 'tasks':
      return <TasksPage />;
    case 'roadmap':
      return <RoadmapPage onNavigate={leave} />;
    case 'insight':
      return grant.insight
        ? <InsightWidget elementId="embed" payload={{ v: 1, kind: 'insight', ref: grant.insight }} active size="xl" />
        : <p className="embed-empty">{t('embed.noInsight')}</p>;
    default:
      return null;
  }
}

/** The window root of an embedded screen (`?embed=`), after the frame check let it draw. */
export function EmbedRoot({ grant }: { grant: EmbedGrant }) {
  const client = useMemo(() => createInstanceQueryClient(), []);
  // The model picker's Settings links and a sign-in have no surface in a frame: the main app opens them.
  useLayoutEffect(() => {
    const open = (e: Event) => {
      const page = (e as CustomEvent<{ page?: string }>).detail?.page;
      if (page && (APP_LINK_PAGES as readonly string[]).includes(page)) window.open(openInMainHref(grant.vault, page as AppLinkPage), '_blank');
    };
    embedBus.addEventListener('dreamcontext-agent-open-page', open);
    return () => embedBus.removeEventListener('dreamcontext-agent-open-page', open);
  }, [grant.vault]);
  // On the document element, not the wrapper: the selection bar and the popovers portal to `body`.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const tokens = embedTokens(grant.colors);
    for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
    return () => { for (const k of Object.keys(tokens)) root.style.removeProperty(k); };
  }, [grant.colors]);
  return (
    <ThemeProvider forced={grant.theme ?? undefined}>
      <QueryClientProvider client={client}>
        <I18nProvider>
          <VaultProvider vault={grant.vault} instanceId="embed" isActive bus={embedBus}>
            <ShellModeContext.Provider value="classic">
              <EmbedProvider value={grant}>
                <div className="embed-root" data-embed={grant.view}>
                  <EmbedView grant={grant} />
                </div>
              </EmbedProvider>
            </ShellModeContext.Provider>
          </VaultProvider>
        </I18nProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
