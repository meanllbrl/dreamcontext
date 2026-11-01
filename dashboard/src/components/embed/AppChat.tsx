import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../../context/I18nContext';
import { AiTeamPage } from '../../pages/AiTeamPage';
import { ChatHistoryPicker } from '../sleepy/ChatHistoryPicker';
import { CardChat } from '../whiteboard/widgets/AgentWidget';
import type { EmbedGrant } from '../../lib/frameGuard';
import { APP_LINK_PAGES, type AppLinkPage } from '../../lib/appLink';
import { openInMainHref } from './embedMode';
import { createAppChatStore } from './appChatStore';
import './AppChat.css';

/**
 * An app's chat (plan r9, D15): the real Chat pane under a strip of its open conversations. Reuse,
 * not rewrite: `CardChat pane` is the AI Team's own mount, and the history is Chat's picker with the
 * app's filter. AgentSurface is not mounted, so nothing of the main app's tabs comes along.
 */
/** Pages have no home in the frame: the main app opens them. */
function leaveFrame(grant: EmbedGrant, page: string, id?: string | null): void {
  if ((APP_LINK_PAGES as readonly string[]).includes(page)) window.open(openInMainHref(grant.vault, page as AppLinkPage, id ?? null), '_blank');
}

export function AppChat({ grant }: { grant: EmbedGrant }) {
  const { t } = useI18n();
  const store = useMemo(() => createAppChatStore(grant), [grant]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [history, setHistory] = useState(false);
  useEffect(() => { void store.load(); }, [store]);

  if (state.assistant === 'none') return <AiTeamPage />;
  if (state.error) return <p className="embed-empty">{t('embed.chatLoadFailed')}</p>;
  const active = state.rows.find((r) => r.id === state.active) ?? null;
  const title = state.name ? t('embed.assistantOf').replace('{name}', state.name) : '';
  return (
    <div className="app-chat">
      <header className="app-chat-head">
        <h1 className="app-chat-title">{title}</h1>
        <div className="app-chat-strip" role="tablist" aria-label={title}>
          {state.rows.map((row, i) => (
            <span key={row.id} className="app-chat-tab" data-active={row.id === state.active || undefined}>
              {row.state !== 'idle' && row.id !== state.active && (
                <span className="app-chat-tab-dot" data-state={row.state} role="img" aria-label={t(row.state === 'asking' ? 'embed.chatAsking' : 'embed.chatWorking')} />
              )}
              <button type="button" role="tab" aria-selected={row.id === state.active} className="app-chat-tab-name" onClick={() => store.show(row.id)}>
                {row.title || t('embed.chatN').replace('{n}', String(i + 1))}
              </button>
              {state.rows.length > 1 && (
                <button type="button" className="app-chat-tab-close" aria-label={t('embed.closeChat')} onClick={() => store.close(row.id)}>×</button>
              )}
            </span>
          ))}
        </div>
        <button type="button" className="app-chat-new" aria-label={t('embed.newChat')} title={t('embed.newChat')} onClick={store.newChat}>+</button>
        <button type="button" className="app-chat-history" onClick={() => setHistory(true)}>{t('embed.history')}</button>
      </header>
      <div className="app-chat-body">
        {active?.session && (
          <CardChat
            key={active.id}
            session={active.session}
            pane
            placeholder={t('embed.askPlaceholder').replace('{name}', state.name)}
            reopen={() => store.respawn(active.id)}
            openPage={(page, id) => leaveFrame(grant, page, id)}
          />
        )}
      </div>
      <ChatHistoryPicker
        open={history}
        onClose={() => setHistory(false)}
        onPick={(s) => { setHistory(false); store.reopen(s.id, s.title); }}
        openIds={state.rows.map((r) => r.id)}
        app={grant.slug}
        noSuper
      />
    </div>
  );
}
