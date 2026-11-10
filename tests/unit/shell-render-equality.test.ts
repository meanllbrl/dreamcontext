/**
 * The new shell's OFF lock, at the markup level (task codex-tarzi-yeni-kabuk W1, AC 2): with the
 * switch off, the classic sidebar (rail + footer) and the project chip strip render EXACTLY what
 * they rendered on the merged base before any shell code. The fixtures were written by this file
 * running on that base (super/yeni-kabuk @a5a80264, UPDATE_SHELL_FIXTURES=1); W1 moved code out
 * of both components (useNavBadges, ProjectChipBubbles) and these prove the moves are pure.
 * The sidebar-* fixtures were regenerated for 0.40.0 after 50308a20 (Apps, beta, above the alpha rows): a pure reorder.
 * Regenerated again for 0.41.14 (super/duyuru-kalkar): the footer's Announcements row and Memory's Taxonomy row are gone, nothing else moved.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const FIXTURES = join(__dirname, 'fixtures', 'shell-render-equality');
const UPDATE = process.env.UPDATE_SHELL_FIXTURES === '1';

const state = vi.hoisted(() => ({
  agentUnread: 0,
  learningEnabled: true as boolean | undefined,
  desktop: true,
  signedIn: false,
  hasRemote: false,
}));

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'en', setLocale: () => {} }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/VaultContext.js', async (orig) => ({
  ...(await orig<object>()),
  useVault: () => ({ vault: 'acme', instanceId: 'inst-1', isActive: true, bus: new EventTarget() }),
  useInstanceEvent: () => {},
  emitInstance: () => {},
}));
vi.mock('../../dashboard/src/hooks/useBrainStatus.js', () => ({
  useAuthStatus: () => ({ data: { connected: state.signedIn } }),
  useBrainStatus: () => ({ data: { hasRemote: state.hasRemote } }),
}));
vi.mock('../../dashboard/src/hooks/useAutomations.js', () => ({
  useAgentFeed: () => ({ data: { unreadTotal: state.agentUnread } }),
}));
vi.mock('../../dashboard/src/hooks/useTheses.js', () => ({
  useTheses: () => ({ data: state.learningEnabled === undefined ? undefined : { enabled: state.learningEnabled } }),
}));
vi.mock('../../dashboard/src/hooks/useAgentCapabilities.js', () => ({
  useAgentCapabilities: () => ({ data: { desktop: state.desktop } }),
}));
vi.mock('../../dashboard/src/lib/agentSettings.js', async (orig) => ({
  ...(await orig<object>()),
  readAgentSettings: () => ({ enabled: true }),
  onAgentSettings: () => () => {},
}));
vi.mock('../../dashboard/src/lib/scopedStorage.js', async (orig) => ({
  ...(await orig<object>()),
  readScopedRaw: () => null,
  writeScopedRaw: () => {},
}));
// The surface itself (xterm, sockets) is never rendered here; only its event name is read.
vi.mock('../../dashboard/src/components/sleepy/AgentSurface.js', () => ({ PROJECT_ROLLUP_EVENT: 'dc-project-rollup' }));
vi.mock('../../dashboard/src/components/brain/BrainSyncControl.js', () => ({
  BrainSyncControl: () => createElement('div', { 'data-stub': 'brain-sync-control' }),
}));

const { Sidebar } = await import('../../dashboard/src/components/layout/Sidebar.js');
const { ProjectTabs } = await import('../../dashboard/src/components/layout/ProjectTabs.js');

function check(name: string, html: string): void {
  const file = join(FIXTURES, `${name}.html`);
  if (UPDATE) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, html + '\n');
    return;
  }
  expect(existsSync(file), `missing fixture ${name}.html`).toBe(true);
  expect(html + '\n').toBe(readFileSync(file, 'utf-8'));
}

const noop = () => {};

describe('classic sidebar renders as on the base', () => {
  const cases: Array<[string, () => void, Record<string, unknown>]> = [
    ['sidebar-plain', () => {}, { activePage: 'tasks', collapsed: false }],
    ['sidebar-collapsed', () => {}, { activePage: 'knowledge', collapsed: true }],
    ['sidebar-badges', () => { state.agentUnread = 3; state.learningEnabled = false; }, { activePage: 'automations', collapsed: false }],
    ['sidebar-synced', () => { state.signedIn = true; state.hasRemote = true; }, { activePage: 'agents', collapsed: false }],
    ['sidebar-nochat', () => { state.desktop = false; state.learningEnabled = undefined; }, { activePage: 'settings', collapsed: false }],
  ];
  for (const [name, arrange, props] of cases) {
    it(name, () => {
      Object.assign(state, { agentUnread: 0, learningEnabled: true, desktop: true, signedIn: false, hasRemote: false });
      arrange();
      check(name, renderToStaticMarkup(createElement(Sidebar, { onNavigate: noop, ...props } as never)));
    });
  }
});

describe('project chips render as on the base', () => {
  const chip = (vault: string, over: Record<string, unknown> = {}) => ({
    vault, active: false, preview: false, cold: false, worst: 'ended', live: 0, waiting: 0,
    asking: 0, working: 0, idle: 0, flagged: 0, bounceNonce: 0, ...over,
  });
  it('chips-mixed', () => {
    const chips = [
      chip('acme', { active: true, worst: 'working', live: 3, asking: 1, working: 1, idle: 1, flagged: 1 }),
      chip('globex', { cold: true }),
      chip('initech', { preview: true, worst: 'asking', live: 12, asking: 2, working: 10, waiting: 2 }),
    ];
    check('chips-mixed', renderToStaticMarkup(createElement(ProjectTabs, { chips, onActivate: noop, onClose: noop, onAdd: noop, onDetach: noop } as never)));
  });
  it('chips-tunnel', () => {
    check('chips-tunnel', renderToStaticMarkup(createElement(ProjectTabs, { chips: [chip('acme', { active: true })], onActivate: noop, onClose: noop, onAdd: noop } as never)));
  });
});
