/**
 * The REAL Telegram screens (W3 lane A) with their real CSS and theme tokens, mounted alone so
 * each state can be photographed without building the app or running W2's server:
 *
 *   ?view=menu-unbound|menu-bound            the Super head ⋯ menu (opened by the script)
 *   ?view=sheet-manager|sheet-nomanager|sheet-connected|bindflow   the bind sheet
 *   ?view=member-unbound|member-bound        the member's Telegram section in its profile
 *   ?view=settings-none|settings-ready|settings-alarm   Settings → Telegram (`&browser=1`: a tab)
 *   &real=1 &vault=             no faked routes: /api is proxied to a real server (telegram-manager-real.ts)
 *   ?view=card                               a Telegram turn in the chat, and a Mac turn beside it
 *   &theme=light|dark  &lang=tr|en
 */
import './stubs';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../../../dashboard/src/styles/global.css';
import '../../../../dashboard/src/components/sleepy/ChatPane.css';
import '../../../../dashboard/src/components/sleepy/chat/cards.css';
import '../../../../dashboard/src/components/sleepy/super/SuperSurface.css';
import '../../../../dashboard/src/components/agents/AgentProfilePanel.css';
import '../../../../dashboard/src/components/settings/window/SettingsWindow.css';
import '../../../../dashboard/src/components/settings/SettingRow.css';
import { ThemeProvider } from '../../../../dashboard/src/context/ThemeContext';
import { I18nProvider, useI18n } from '../../../../dashboard/src/context/I18nContext';
import { VaultProvider } from '../../../../dashboard/src/context/VaultContext';
import { SuperHeadMenu } from '../../../../dashboard/src/components/sleepy/super/SuperHeadMenu';
import { TelegramBindSheet } from '../../../../dashboard/src/components/telegram/TelegramBindSheet';
import { TelegramMemberSection } from '../../../../dashboard/src/components/telegram/TelegramMemberSection';
import { TelegramPage } from '../../../../dashboard/src/components/settings/window/pages/SimplePages';
import { ItemView } from '../../../../dashboard/src/components/sleepy/chat/TranscriptItem';
import type { ChatItem } from '../../../../dashboard/src/components/sleepy/chatSession';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'sheet-manager';

function Locale() {
  const { setLocale } = useI18n();
  useEffect(() => { if (params.get('lang') !== 'en') setLocale('tr'); }, [setLocale]);
  return null;
}

function View() {
  const [sheet, setSheet] = useState(true);
  if (view.startsWith('menu-')) {
    return (
      <div className="super-centre-head" style={{ justifyContent: 'flex-end', padding: 16 }}>
        <SuperHeadMenu fresh={{ pending: false, onPress: async () => true }} onTurnOff={() => {}} onAdd={() => {}} />
      </div>
    );
  }
  if (view.startsWith('sheet-') || view === 'bindflow') {
    return sheet ? <TelegramBindSheet target="super" name={null} onClose={() => setSheet(false)} /> : <p data-testid="sheet-closed">closed</p>;
  }
  if (view.startsWith('member-')) {
    return (
      <aside className="agp-panel" style={{ maxWidth: 420, margin: '0 auto' }}>
        <section className="agp-section" data-section="job"><h3 className="agp-h">İş</h3><p className="agp-prompt">Meta ve TikTok bütçelerini her sabah kontrol eder.</p></section>
        <TelegramMemberSection slug="ua-lead" name="UA Lead" />
        <section className="agp-section" data-section="pattern"><h3 className="agp-h">Desen</h3></section>
      </aside>
    );
  }
  if (view.startsWith('settings-')) {
    return <div className="sw-body" style={{ padding: 24, maxWidth: 720 }}><TelegramPage /></div>;
  }
  // card: one Telegram turn and one Mac turn, as the Super chat draws them.
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', ts: Date.parse('2026-11-08T14:32:00Z'), ref: 'k3x9a1', source: 'telegram', text: 'Dünkü kampanyanın sonuçlarına baktın mı? Bütçeyi yarın sabah yüzde on artır.' },
    { kind: 'text', id: 't1', index: 0, done: true, ts: 0, text: 'Baktım: dönüşüm maliyeti hedefin altında. Yarın sabah bütçeyi yüzde on artırıyorum.' },
    { kind: 'user', id: 'u2', ts: Date.parse('2026-11-08T14:40:00Z'), text: 'Mac\'ten yazdığım normal bir mesaj.' },
  ];
  return (
    <div className="chat-pane" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {items.map((it) => <ItemView key={it.id} item={it} onOpenFile={() => {}} />)}
    </div>
  );
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <I18nProvider>
      <Locale />
      <QueryClientProvider client={qc}>
        <VaultProvider vault={params.get("vault") ?? "proj"} instanceId="harness" isActive bus={new EventTarget()}>
          <div style={{ minHeight: '100vh', background: 'var(--color-bg)', color: 'var(--color-text)' }} data-testid="harness"><View /></div>
        </VaultProvider>
      </QueryClientProvider>
    </I18nProvider>
  </ThemeProvider>,
);
