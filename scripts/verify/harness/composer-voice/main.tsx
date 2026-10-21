/**
 * The REAL chat composer (dashboard/src/components/sleepy/chat/Composer.tsx), its real CSS and
 * the real theme tokens, mounted alone in a pane-sized box so the voice row can be driven and
 * photographed without building the app. `?mode=assistant|super|chat`, `?theme=dark|light`,
 * `?lang=en|tr`, `?readAloud=0|1`. `?overlay=1` draws the notch's listening card instead
 * (`ListeningOverlay`, on the notch's own night surface), driven through `window.__voice(phase, attempt)`.
 */
import './stubs';
import { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../../../dashboard/src/styles/global.css';
import '../../../../dashboard/src/components/sleepy/ChatPane.css';
import { ThemeProvider } from '../../../../dashboard/src/context/ThemeContext';
import { I18nProvider, useI18n } from '../../../../dashboard/src/context/I18nContext';
import { Composer } from '../../../../dashboard/src/components/sleepy/chat/Composer';
import type { ComposerHost } from '../../../../dashboard/src/components/sleepy/chat/composerHost';
import type { ChatMode } from '../../../../dashboard/src/lib/chatModes';
import '../../../../dashboard/src/components/assistant/notch.css';
import { ListeningOverlay } from '../../../../dashboard/src/components/assistant/ListeningOverlay';
import { publishVoiceActivity, type VoicePhase } from '../../../../dashboard/src/lib/voice/voiceActivity';

const params = new URLSearchParams(location.search);
const mode = (params.get('mode') ?? 'assistant') as ChatMode;

const session: ComposerHost = {
  claudeId: '00000000-0000-4000-8000-000000000001',
  getModel: () => ({ draft: '', draftEpoch: 0, history: [], items: [] }),
  syncDraft: () => {},
  setFocusTarget: () => {},
  send: () => {},
  steer: () => false,
  enqueue: () => {},
  interrupt: () => {},
  bargeInSpeech: () => {},
  armSpoken: (text) => { (window as unknown as { __armed?: string[] }).__armed = [...((window as unknown as { __armed?: string[] }).__armed ?? []), text]; },
  onSpeaking: (fn) => { fn(false); return () => {}; },
};

function Locale() {
  const { setLocale } = useI18n();
  useEffect(() => { if (params.get('lang') === 'tr') setLocale('tr'); }, [setLocale]);
  return null;
}

const OVERLAY_VAULT = '__harness__';
(window as unknown as { __voice: (phase: VoicePhase, attempt?: number) => void }).__voice = (phase, attempt = 0) =>
  publishVoiceActivity({ vault: OVERLAY_VAULT, phase, elapsed: 3, attempt, error: phase === 'error' ? 'The microphone is not available. Check the permission in System Settings.' : '' });

function Overlay() {
  return (
    <div className="dc-notch surface-night" data-testid="notch" style={{ position: 'relative', height: 340, width: 'min(100vw, 520px)', margin: '0 auto', background: 'var(--notch-surface)' }}>
      <ListeningOverlay vault={OVERLAY_VAULT} avatar={null} name="Claude" mode="hold" />
    </div>
  );
}

function Harness() {
  const modelConfig = useMemo(() => ({ models: [{ id: 'opus', label: 'Opus' }], efforts: ['medium', 'high'], defaultModel: 'opus', defaultEffort: 'high' }), []);
  return (
    <div className="chat-pane" data-testid="pane" style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <Composer
        session={session}
        model="opus"
        effort="high"
        modelConfig={modelConfig as never}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        busy={false}
        connected
        quote={null}
        onClearQuote={() => {}}
        onSignIn={() => {}}
        mode={mode}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <Locale />
        {params.has('overlay') ? <Overlay /> : <Harness />}
      </I18nProvider>
    </QueryClientProvider>
  </ThemeProvider>,
);
