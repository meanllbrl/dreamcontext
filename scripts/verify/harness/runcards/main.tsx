/**
 * The REAL run and secret cards (W4) in a chat host, Mac and phone, with their real CSS:
 *   ?host=mac|phone  &view=idle|live-telegram|done|unrecorded  &theme=light|dark
 */
import { SID, RUN_SPEC, SECRET_SPEC } from './stubs';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../../../dashboard/src/styles/global.css';
import '../../../../dashboard/src/components/sleepy/ChatPane.css';
import '../../../../dashboard/src/components/sleepy/chat/cards.css';
import '../../../../dashboard/src/components/sleepy/chat/ChatViews.css';
import { ThemeProvider } from '../../../../dashboard/src/context/ThemeContext';
import { I18nProvider } from '../../../../dashboard/src/context/I18nContext';
import { VaultProvider } from '../../../../dashboard/src/context/VaultContext';
import { RunCard } from '../../../../dashboard/src/components/sleepy/chat/RunCard';
import { SecretCard } from '../../../../dashboard/src/components/sleepy/chat/SecretCard';
import type { RunViewSpec, SecretViewSpec } from '../../../../dashboard/src/lib/chatViewSpec';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <VaultProvider vault="orbit" instanceId="harness" isActive bus={new EventTarget()}>
          <div style={{ minHeight: '100vh', background: 'var(--color-bg)', color: 'var(--color-text)' }} data-testid="harness">
            <div className="chat-pane" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, margin: '0 auto' }}>
              <RunCard spec={RUN_SPEC as RunViewSpec} sessionId={SID} />
              <SecretCard spec={SECRET_SPEC as SecretViewSpec} sessionId={SID} report={() => {}} />
            </div>
          </div>
        </VaultProvider>
      </QueryClientProvider>
    </I18nProvider>
  </ThemeProvider>,
);
