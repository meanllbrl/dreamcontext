/**
 * Ü2 (plan super-v3, frame T2-sonra): a member opens as a TAB in the presentation window: who it
 * is, Chat / Routines / Approvals, and its one conversation; "Read full answer" opens that tab.
 * Fictional members and jobs (synthetic-fixtures).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => {
  const t = (key: string) => (key === 'super.team.projectTeam' ? '{project} team' : key);
  return { useI18n: () => ({ locale: 'en', setLocale: () => {}, t }), I18nProvider: ({ children }: { children: unknown }) => children };
});
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useVaultId: () => ({ vault: '/projects/acme' }), useApi: () => ({}) }));
vi.mock('../../dashboard/src/hooks/useAgents.js', () => ({
  useAgent: () => ({ data: { agent: { slug: 'sage', title: 'Sage', roleLine: 'Strategy', hasPhoto: false } } }),
}));
vi.mock('../../dashboard/src/components/agents/AgentAvatar.js', () => ({ AgentAvatar: () => null }));
vi.mock('../../dashboard/src/components/sleepy/super/MemberCardBody.js', () => ({
  MemberCardBody: () => createElement('div', { 'data-testid': 'routines' }),
  useMemberRoutines: () => [{ slug: 'weekly' }, { slug: 'daily' }],
}));

const { MemberTab } = await import('../../dashboard/src/components/sleepy/super/MemberTab.js');
const { memberCardOf } = await import('../../dashboard/src/components/sleepy/super/memberQuote.js');

const job = { id: 'team-a', member: 'sage', runId: 'r1', jobKind: 'run', queued: false, brief: 'Fiyat sayfası' };
const card = (over: Record<string, unknown> = {}) => ({ job, status: 'done', lastLine: '', ...over }) as never;

describe('the member tab', () => {
  it('who it is, the switch with counts, and the one conversation under it', () => {
    const html = renderToStaticMarkup(createElement(MemberTab, { card: card(), conversation: createElement('div', { 'data-testid': 'convo' }) }));
    expect(html).toContain('data-testid="super-member-tab"');
    expect(html).toContain('>Sage<');
    expect(html).toContain('Strategy · acme team');
    expect(html).toContain('super.memberTab.chat');
    expect(html).toMatch(/super\.memberTab\.routines<i>2<\/i>/);
    expect(html).toContain('data-testid="convo"');
    // No approval waiting: Approvals is there but asks nothing.
    expect(html).toMatch(/data-testid="super-member-tab-approvals" disabled/);
  });
  it('a waiting approval counts on the switch', () => {
    const html = renderToStaticMarkup(createElement(MemberTab, { card: card({ approval: { id: 'ap1' } }), conversation: null }));
    expect(html).toMatch(/data-waiting="true">super\.memberTab\.approvals<i>1<\/i>/);
  });
});

describe('memberCardOf: the member\'s one card on the stage', () => {
  const containers = [{ id: 'chat-1', kind: 'chat', ref: 'team-a' }, { id: 'team-1', kind: 'team', ref: 'team-a' }];
  it('finds the team card standing on one of its jobs', () => {
    expect(memberCardOf('sage', [job], containers)).toBe('team-1');
  });
  it('another member, or no card, is null', () => {
    expect(memberCardOf('nova', [job], containers)).toBeNull();
    expect(memberCardOf('sage', [job], [])).toBeNull();
  });
});

describe('the wiring', () => {
  const D = join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy');
  it('a member opens as a window tab (present), drawn as MemberTab in the window', () => {
    const surface = readFileSync(join(D, 'super', 'SuperSurface.tsx'), 'utf-8');
    expect(surface).toContain("c.kind === 'team' ? { mode: 'present' as const, cards: [id] }");
    const container = readFileSync(join(D, 'super', 'SuperContainer.tsx'), 'utf-8');
    expect(container).toContain('p.teamConversation?.(p.team, !!p.plan.inWindow)');
    // MemberTab is chat UI (it mounts MemberCardBody): the stage modules never import it.
    expect(container).not.toContain('MemberTab');
    const agent = readFileSync(join(D, 'AgentSurface.tsx'), 'utf-8');
    expect(agent).toContain('return tab ? <MemberTab card={card} conversation={convo} /> : convo;');
  });
  it('Read full answer asks the stage for the member\'s tab first', () => {
    const quote = readFileSync(join(D, 'super', 'MemberQuoteCard.tsx'), 'utf-8');
    expect(quote).toContain('stage?.showMember?.(answer.member)');
  });
});
