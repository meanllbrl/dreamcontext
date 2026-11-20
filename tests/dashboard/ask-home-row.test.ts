/**
 * K8 (plan super-v3, D7): while a Super question is docked under the window's page, the chat holds
 * one row for it and the dock holds the full card: one full card per question on the Mac.
 * Fictional fixtures (synthetic-fixtures).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ locale: 'en', setLocale: () => {}, t }), useOwnerCardT: () => t, I18nProvider: ({ children }: { children: unknown }) => children };
});
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({ get: async () => ({}), ownerPost: async () => ({}) }), useVaultId: () => ({ vault: 'acme-shop' }) }));
vi.mock('../../dashboard/src/hooks/useAgents.js', () => ({ useAgent: () => ({ data: undefined }) }));
vi.mock('../../dashboard/src/hooks/useAutomations.js', () => ({ useAutomation: () => ({ data: undefined }) }));
vi.mock('../../dashboard/src/components/agents/AgentAvatar.js', () => ({ AgentAvatar: () => null }));
vi.mock('../../dashboard/src/components/sleepy/chat/SurveyCard.js', () => ({
  SurveyCard: () => createElement('div', { 'data-testid': 'survey-card' }), SurveyReceipt: () => null,
}));
vi.mock('../../dashboard/src/components/sleepy/chat/InlineTerminal.js', () => ({ InlineTerminal: () => null }));

const { publishSuperQuestions } = await import('../../dashboard/src/components/sleepy/super/superJobsStore.js');
const { setDockedAsk } = await import('../../dashboard/src/components/sleepy/super/superQuestions.js');
const { SuperQuestionCard } = await import('../../dashboard/src/components/sleepy/super/SuperQuestionCard.js');
const { ReportAskDock } = await import('../../dashboard/src/components/sleepy/super/ReportAskDock.js');

const item = { id: 'q-plan', kind: 'ask', state: 'escalated', sessionId: 'SUPER', createdAt: 1, ownerText: 'Ship the pricing page?', read: ['web-plan'] };
const session = { claudeId: 'SUPER', status: 'open', busy: false, steer: () => true, send: () => true } as never;
const ask = { item: 'q-plan', kind: 'ask' as const, toolItemId: 't1', live: true };
let n = 0;

beforeEach(() => {
  publishSuperQuestions('SUPER', { open: [item], superSession: session, sessionFor: () => undefined } as never, `k${++n}`);
  setDockedAsk('SUPER', null);
});

describe('one full card per question (K8)', () => {
  it('not docked: the chat draws the full card', () => {
    const html = renderToStaticMarkup(createElement(SuperQuestionCard, { ask, session }));
    expect(html).toContain('data-testid="survey-card"');
    expect(html).not.toContain('super-ask-row');
  });
  it('docked: the chat draws one row, the dock the full card', () => {
    setDockedAsk('SUPER', 'q-plan');
    const chat = renderToStaticMarkup(createElement(SuperQuestionCard, { ask, session }));
    expect(chat).not.toContain('data-testid="survey-card"');
    expect(chat).toContain('data-testid="super-ask-row"');
    expect(chat).toContain('Ship the pricing page?');
    expect(chat).toContain('super.ask.besideReport');
    const dock = renderToStaticMarkup(createElement(ReportAskDock, { rect: { x: 600, y: 500, width: 700, height: 300 }, item: 'q-plan', session }));
    expect((dock.match(/data-testid="survey-card"/g) ?? []).length).toBe(1);
    expect(dock).toContain('data-testid="super-ask-dock"');
  });
  it('another chat\'s docked question changes nothing here', () => {
    setDockedAsk('OTHER', 'q-plan');
    const html = renderToStaticMarkup(createElement(SuperQuestionCard, { ask, session }));
    expect(html).toContain('data-testid="survey-card"');
    setDockedAsk('OTHER', null);
  });
});
