/**
 * The REAL left drawer (ChatDrawer + TeamSection, their real CSS, the real row model) at a fixed
 * width with staged facts, so every state the owner judges can be drawn on demand:
 *   ?s=idle|working|member-asking|super-asking|super-2|team-folded-asking|collapsed-asking|selected-asking
 *   &theme=light|dark  &w=200|320
 */
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../../../dashboard/src/styles/global.css';
import '../../../../dashboard/src/components/layout/newshell/NewShell.css';
import { ThemeProvider } from '../../../../dashboard/src/context/ThemeContext';
import { I18nProvider, useI18n } from '../../../../dashboard/src/context/I18nContext';
import { ChatDrawer } from '../../../../dashboard/src/components/layout/newshell/ChatDrawer';
import { buildDrawerRows, type DrawerFacts, type DrawerProjectInput } from '../../../../dashboard/src/components/layout/newshell/drawerModel';

const q = new URLSearchParams(location.search);
const s = q.get('s') ?? 'idle';
const theme = (q.get('theme') ?? 'dark') as 'light' | 'dark';
const width = Number(q.get('w') ?? 200);

const base = { global: false, enabled: true, ownerWorking: 0, asking: false, approval: false, unread: 0, superOnly: false, lastAt: 9, pending: 0 };
const meta = {
  ...base,
  slug: 'meta-the-unicorn',
  ownerWorking: s === 'working' ? 1 : 0,
  asking: ['member-asking', 'team-folded-asking', 'collapsed-asking', 'selected-asking'].includes(s),
};
const members = [meta, ...(s === 'selected-asking' ? [{ ...base, slug: 'pacioli', unread: 3, lastAt: 8 }, { ...base, slug: 'deneme-rutin', approval: true, lastAt: 7 }] : [])];
const identities = [
  { slug: 'meta-the-unicorn', title: 'Meta · The Unicorn', hasPhoto: false },
  { slug: 'pacioli', title: 'Pacioli', hasPhoto: false },
  { slug: 'deneme-rutin', title: 'Deneme Rutin', hasPhoto: false },
];

// The Team list's fold state lives in localStorage, per project.
try {
  if (s === 'team-folded-asking') localStorage.removeItem('dc.drawer.team.Tilki');
  else localStorage.setItem('dc.drawer.team.Tilki', '1');
  localStorage.removeItem('dc.drawer.team.dreamcontext');
} catch { /* private */ }

const project = (name: string, mounted: boolean): DrawerProjectInput => ({ name, logo: false, logoStamp: null, mounted, asleep: false, otherWindow: false, rollup: null });
const projects = [project('Tilki', true), project('dreamcontext', true), project('Second-brain', false), project('kader-mat', false)];
const tilki: DrawerFacts = {
  superOn: true,
  superSelected: s === 'selected-asking',
  chatOpen: true,
  team: [],
  windows: [{ id: 'main', name: 'Chat', tabs: 1, working: s === 'working' ? 1 : 0, asking: s === 'collapsed-asking' ? 1 : 0, flagged: 0, other: s === 'working' || s === 'collapsed-asking' ? 0 : 1 }],
  activeWindowId: 'main',
  superMarks: { working: s === 'super-2' ? 2 : 0, asking: s === 'super-asking' || s === 'selected-asking' },
  members,
  identities,
};
const dc: DrawerFacts = { superOn: s !== 'idle', superSelected: false, chatOpen: false, team: [], windows: [], members: [], identities: [] };
const expanded = s === 'collapsed-asking' ? ['dreamcontext'] : ['Tilki', 'dreamcontext'];
const rows = buildDrawerRows({ projects, activeVault: 'Tilki', expanded, facts: { Tilki: tilki, dreamcontext: dc }, fanout: {} });

const noop = () => {};
function Tr() {
  const { setLocale } = useI18n();
  useEffect(() => { setLocale('tr'); }, [setLocale]);
  return null;
}
const qc = new QueryClient({ defaultOptions: { queries: { retry: 0, enabled: false } } });
createRoot(document.getElementById('root')!).render(
  <ThemeProvider forced={theme}>
    <I18nProvider>
      <Tr />
      <QueryClientProvider client={qc}>
        <div style={{ height: '100vh', display: 'flex', background: 'var(--color-bg)', color: 'var(--color-text)' }}>
          <div data-testid="harness-drawer" style={{ position: 'relative', display: 'flex', height: 640, width, background: 'var(--color-bg-secondary)' }}>
            <ChatDrawer rows={rows} width={width} floating={false} onClose={noop} onResize={noop} onToggleExpanded={noop}
              onIntent={(v, i) => { ((window as unknown as { __intents: unknown[] }).__intents ??= []).push([v, i]); }} onHistory={noop} onRelations={noop} onMove={noop} onDrop={noop} onMoveWindow={noop}
              onOpenInWindow={noop} onCloseProject={noop} onNewProject={noop} newWindowNonce={0} onManage={noop} />
          </div>
        </div>
      </QueryClientProvider>
    </I18nProvider>
  </ThemeProvider>,
);
