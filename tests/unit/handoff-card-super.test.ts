/**
 * The handoff card for the Super Agent's own handoff (task super-agent-devrini-…): it says the
 * handoff went into the FILE, offers no task chip (a chip would open a task called
 * `.super/handoff`), and a task handoff's card keeps its wording and chip. Static markup, the
 * lab-*.test.ts precedent; the frame parser carries `kind`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({}) }));
vi.mock('../../dashboard/node_modules/@tanstack/react-query/build/modern/index.js', () => ({ useQueryClient: () => ({}) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('../../dashboard/src/hooks/useAgentCapabilities.js', () => ({ useClaudeAccounts: () => ({ data: undefined }) }));
vi.mock('../../dashboard/src/components/sleepy/AgentSetup.js', () => ({ BotMark: () => null }));

const { HandoffCard } = await import('../../dashboard/src/components/sleepy/chat/Banners.js');
const { toChatEvent } = await import('../../dashboard/src/lib/chatProtocol.js');

const run = (o: Record<string, unknown>) => ({ id: 1, stage: 'clearing', task: '.super/handoff', title: 'Super Agent', contextTokens: 780_000, ...o });
const render = (r: Record<string, unknown>) => renderToStaticMarkup(createElement(HandoffCard as never, { run: r, onDismiss: () => {}, onOpenTask: () => {} } as never));

describe('the Super Agent\'s handoff card', () => {
  it('while it runs: the file wording, no task chip', () => {
    const html = render(run({ kind: 'super' }));
    expect(html).toContain('Handoff written to the file');
    expect(html).toContain('Opening a fresh session');
    expect(html).not.toContain('State saved to task');
    expect(html).not.toContain('Resuming task');
    expect(html).not.toContain('is-task');
    expect(html).not.toContain('.super/handoff');
  });

  it('when done: no task chip either', () => {
    const html = render(run({ kind: 'super', stage: 'done', postTokens: 40_000 }));
    expect(html).not.toContain('is-task');
    expect(html).toContain('picked up');
  });

  it('a task handoff keeps its wording and its chip', () => {
    const html = render(run({ task: 'ship-the-thing', title: 'Ship the thing' }));
    expect(html).toContain('State saved to task');
    expect(html).toContain('Resuming task');
    expect(html).toContain('is-task');
    expect(html).toContain('Ship the thing');
  });

  it('the frame parser carries kind: super, and only that', () => {
    const frame = (o: Record<string, unknown>) => toChatEvent({ type: '_meta', subtype: 'handoff_progress', id: 7, stage: 'clearing', task: '.super/handoff', title: 'Super Agent', ...o });
    expect(frame({ kind: 'super' })).toMatchObject({ kind: 'handoff-progress', run: { kind: 'super' } });
    expect((frame({}) as { run: Record<string, unknown> }).run.kind).toBeUndefined();
    expect((frame({ kind: 'other' }) as { run: Record<string, unknown> }).run.kind).toBeUndefined();
  });
});
