/**
 * Live links on the owner's screens (tunel-paylasim, review r1): every shell that draws the pill
 * gets a face that fits it (the collapsed classic sidebar gets the rail's glyph face, never the
 * text pill squeezed into 56 px), and a form opened again from anywhere (the pill's Yeniden aç,
 * a broken row) never shows less than the app page's form: the AI choice, the password choice,
 * the AI switch and the keys line all come back without the caller passing them.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { QueryClient, QueryClientProvider } from '../../dashboard/node_modules/@tanstack/react-query/build/modern/index.js';

const rows = vi.hoisted(() => ({ data: [] as unknown[] }));

vi.mock('../../dashboard/src/lib/sharesApi.js', () => ({
  useLiveShares: () => ({ data: rows.data }),
  useRefreshShares: () => () => {},
  LIVE_SHARES_KEY: ['live-shares'],
  openLiveShare: async () => ({}),
  closeLiveShare: async () => ({}),
  closeAllLiveShares: async () => ({}),
  revealLiveShare: async () => ({ link: '' }),
}));
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'en', setLocale: () => {} }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
// The real Sheet portals into document.body; inline it for a static render.
vi.mock('../../dashboard/src/components/apps/Sheet.js', async () => {
  const React = await import('../../dashboard/node_modules/react/index.js');
  return {
    useShareT: () => (k: string) => k,
    Sheet: ({ children, foot }: { children: unknown; foot?: unknown }) => React.createElement('div', { 'data-sheet': '' }, children as never, foot as never),
  };
});

const { LiveSharesPill } = await import('../../dashboard/src/components/shares/LiveSharesPill.js');
const { ShareSheet } = await import('../../dashboard/src/components/shares/ShareSheet.js');

const row = (over: Record<string, unknown> = {}) => ({
  id: 's1', kind: 'app', vault: 'acme', slug: 'crm', name: 'CRM', state: 'open', stage: null, error: null,
  password: true, ai: true, people: 0, openedAt: Date.now(), ...over,
});

function withQuery(el: unknown, seed: (qc: QueryClient) => void = () => {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(qc);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, el as never));
}

describe('the live links pill in every shell face', () => {
  it('the open sidebar draws the text pill', () => {
    rows.data = [row()];
    const html = renderToStaticMarkup(createElement(LiveSharesPill, { variant: 'sidebar' }));
    expect(html).toContain('class="live-pill"');
    expect(html).toContain('liveShare.pill.one');
    expect(html).not.toContain('<svg');
  });

  it('the collapsed sidebar draws the glyph face with its name in aria-label and data-tip', () => {
    rows.data = [row({ state: 'broken', error: 'tunnel_exited' })];
    const html = renderToStaticMarkup(createElement(LiveSharesPill, { variant: 'sidebar', collapsed: true }));
    expect(html).toContain('live-pill--glyph');
    expect(html).toContain('aria-label="liveShare.pill.one"');
    expect(html).toContain('data-tip="liveShare.pill.one"');
    expect(html).toContain('<svg');
    expect(html).toContain('live-share__dot--bad');
    // No visible text squeezed into the 56 px column.
    expect(html.replace(/<[^>]+>/g, '')).toBe('');
  });

  it('the new shell rail keeps its own rail button face', () => {
    rows.data = [row()];
    const html = renderToStaticMarkup(createElement(LiveSharesPill, { variant: 'rail' }));
    expect(html).toContain('ns-rail-btn live-rail');
    expect(html).toContain('data-tip="liveShare.pill.one"');
  });
});

describe('a share form opened again keeps the owner\'s choices', () => {
  const seedApp = (qc: QueryClient) => {
    qc.setQueryData(['apps', 'acme'], { apps: [{ slug: 'crm', agent: 'atlas', stoppedByOwner: false }] });
    qc.setQueryData(['app-store', 'acme', 'crm'], { can: [{ kind: 'settings', text: 'HubSpot key' }] });
  };

  it('from the pill (no app props): the AI switch, the keys line, AI on and the password on come back', () => {
    rows.data = [];
    const html = withQuery(createElement(ShareSheet, { kind: 'app', vault: 'acme', slug: 'crm', name: 'CRM', onClose: () => {}, prior: { ai: true, password: true } }), seedApp);
    expect(html).toContain('liveShare.can.keys');
    expect(html).toContain('liveShare.ai.warn');
    const toggles = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0]);
    expect(toggles).toHaveLength(2);
    expect(toggles.every((t) => /checked/.test(t))).toBe(true);
    expect(html).toContain('id="live-share-pw"');
  });

  it('a broken row\'s AI choice seeds the form\'s retry, never silently off', () => {
    rows.data = [row({ state: 'broken', error: 'tunnel_exited', ai: true, password: false })];
    const html = withQuery(createElement(ShareSheet, { kind: 'app', vault: 'acme', slug: 'crm', name: 'CRM', onClose: () => {} }), seedApp);
    expect(html).toContain('liveShare.retry');
    rows.data = [];
    // The same sheet after the broken row is gone (closed), reopened from the pill with its prior.
    const again = withQuery(createElement(ShareSheet, { kind: 'app', vault: 'acme', slug: 'crm', name: 'CRM', onClose: () => {}, prior: { ai: true, password: false } }), seedApp);
    expect(again).toContain('liveShare.ai.warn');
  });

  it('while the app facts load, Linki aç waits (the owner never confirms an incomplete form)', () => {
    rows.data = [];
    const html = withQuery(createElement(ShareSheet, { kind: 'app', vault: 'acme', slug: 'crm', name: 'CRM', onClose: () => {} }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>liveShare\.open<\/button>/);
  });

  it('the app page passing its facts reads nothing more and opens at once', () => {
    rows.data = [];
    const html = withQuery(createElement(ShareSheet, { kind: 'app', vault: 'acme', slug: 'crm', name: 'CRM', onClose: () => {}, agent: null, settingsLine: null, stopped: false }));
    expect(html).toMatch(/<button[^>]*class="app-card__launch"[^>]*>liveShare\.open<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>liveShare\.open<\/button>/);
    expect(html).not.toContain('liveShare.ai');
  });
});
