/**
 * The permission card of a crew session whose record holds the request (uye-bildirim K4): the
 * server's sizes replace the plain decide row, but every control that row offered stays while the
 * server offers nothing in its place (end review r1): "Run here" for a command that asks at the
 * keyboard (Allow would hang it headless), and the CLI's session-wide "always allow" box for a
 * request offered once only.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const view = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({}), useVaultId: () => ({ vault: 'acme' }) }));
vi.mock('../../dashboard/src/lib/desktop.js', () => ({ isDesktop: () => true }));
// The PTY terminal loads a browser-only library; the card's own controls are what is pinned.
vi.mock('../../dashboard/src/components/sleepy/chat/InlineTerminal.js', () => ({ InlineTerminal: () => null }));
vi.mock('../../dashboard/src/components/embed/embedMode.js', () => ({ useEmbed: () => null }));
vi.mock('../../dashboard/src/components/sleepy/super/ownerAnswer.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../dashboard/src/components/sleepy/super/ownerAnswer.js')>();
  return { ...real, useSessionGrantItems: () => ({ record: 'turing', memberTitle: 'Turing', items: view.items }) };
});

const { PermissionCard } = await import('../../dashboard/src/components/sleepy/chat/PermissionCard.js');

const pending = (command: string, toolName = 'Bash', input: unknown = { command }) => ({
  kind: 'permission', requestId: 'req-1', toolName, input, description: 'Turing wants to run this.',
});
const item = (sizes: string[], tool = 'Bash', input = 'x') => ({
  id: 'q-p1', sessionId: 'S', kind: 'permission', state: 'pending', createdAt: 1, requestId: 'req-1',
  call: { tool, input, whole: tool === 'Bash' }, offer: { sizes },
});
const card = (p: ReturnType<typeof pending>, i: ReturnType<typeof item>) => {
  view.items = [i];
  return renderToStaticMarkup(createElement(PermissionCard, {
    item: p as never, session: { claudeId: 'S', answer: () => true, alwaysAllow: () => {} } as never, permissionMode: 'auto',
  }));
};
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);

describe('the sizes keep what the plain row offered', () => {
  it('a command that asks at the keyboard keeps Run here beside the sizes', () => {
    const html = card(pending('sudo launchctl kickstart system/com.acme.agent'), item(['once', 'job'], 'Bash', 'sudo launchctl kickstart system/com.acme.agent'));
    expect(has(html, 'permission-sizes')).toBe(true);
    expect(html).toContain('perm.runHere');
  });

  it('a request offered once only keeps the session-wide always box; a wider size replaces it', () => {
    const edit = card(pending('', 'Edit', { file_path: 'src/pricing.ts', old_string: 'a', new_string: 'b' }), item(['once'], 'Edit', 'src/pricing.ts'));
    expect(has(edit, 'permission-sizes')).toBe(true);
    expect(has(edit, 'grant-cli-always')).toBe(true);
    const wide = card(pending('node tools/weekly-total.mjs'), item(['once', 'job', 'member'], 'Bash', 'node tools/weekly-total.mjs'));
    expect(has(wide, 'grant-size-job')).toBe(true);
    expect(has(wide, 'grant-cli-always')).toBe(false);
  });
});
