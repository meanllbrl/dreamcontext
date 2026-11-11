/**
 * The W6 owner-reach pieces MOUNTED where the owner meets them (uye-bildirim K4, K11, criterion 12):
 *  - the side menu's red count (drawer and classic rail) counts every item main's record holds for
 *    a member (`memberWaitCounts` into `buildEkip`), not only the summary's one `asking`;
 *  - a session's own chat draws its refused calls (`SessionRefusalCards`) from the items the
 *    surface holding the record published for it, and draws nothing once they are unpublished;
 *  - the surface publishes those items per session, feeds the drawer the counts and names a
 *    member by its title on the bar (a routine's head fetches its own title).
 * The pure parts are driven for real; the mounts inside AgentSurface and ChatPane (too large to
 * render here) are pinned on their source, the way super-command-frame.test.ts pins the surface.
 * Fictional members and commands (synthetic-fixtures pattern).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const { TEMPLATES } = vi.hoisted(() => ({
  TEMPLATES: { 'owner.answer.refusedLead': '{name} wanted to run this. Nothing ran.' } as Record<string, string>,
}));
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => TEMPLATES[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({}), useVaultId: () => ({ vault: 'acme' }) }));
// A face is not what is pinned here.
vi.mock('../../dashboard/src/components/agents/AgentAvatar.js', () => ({ AgentAvatar: () => null }));

const { SessionRefusalCards } = await import('../../dashboard/src/components/sleepy/chat/RefusalCard.js');
const { publishSessionGrantItems, refusalItemsOf, callOf, _resetOwnerItems } = await import('../../dashboard/src/components/sleepy/super/ownerAnswer.js');
const { memberWaitCounts } = await import('../../dashboard/src/components/aiteam/teamModel.js');
const { ekipOf, teamChildOf } = await import('../../dashboard/src/components/layout/newshell/drawerModel.js');
type SuperQueueItem = import('../../dashboard/src/lib/superTypes.js').SuperQueueItem;

const here = fileURLToPath(new URL('.', import.meta.url));
const src = (rel: string) => readFileSync(join(here, '../../dashboard/src', rel), 'utf8');
const has = (html: string, testid: string) => html.includes(`data-testid="${testid}"`);

const SCRIPT = 'node _dream_context/tmp/turing/report.cjs --week 46';
const refused = (over: Partial<SuperQueueItem> = {}): SuperQueueItem => ({
  id: 'q-r1', sessionId: 'turing-child', kind: 'owner', state: 'escalated', createdAt: 5,
  ownerText: `Bash ${SCRIPT}`,
  wait: { kind: 'refusal', id: 'rf-1', refusal: { tool: 'Bash', input: SCRIPT, whole: true, source: 'classifier' } },
  offer: { sizes: ['once', 'job', 'member'] },
  ...over,
} as SuperQueueItem);
const summary = { slug: 'turing', global: false, enabled: true, ownerWorking: 0, asking: false, approval: false, unread: 0, superOnly: false, lastAt: 1, pending: 0 };

describe('the side menu counts what main holds for a member', () => {
  it('the drawer passes the counts through to the Ekip row', () => {
    const queue = [
      { id: 'a', kind: 'member', state: 'escalated', member: 'turing' },
      { id: 'b', kind: 'routine', state: 'pending', member: 'turing' },
      { id: 'c', kind: 'member', state: 'done', member: 'turing' },
      { id: 'd', kind: 'nudge', state: 'pending', member: 'turing' },
    ];
    const waits = memberWaitCounts(queue);
    const identities = [{ slug: 'turing', title: 'Turing', hasPhoto: false }];
    const row = teamChildOf('acme', ekipOf({ members: [summary], identities, waits }), false);
    expect(row?.count).toBe(2);
    expect(row?.asking).toBe(true);
    // No counts read yet: the row is what the summary alone says.
    expect(teamChildOf('acme', ekipOf({ members: [summary], identities }), false)?.count).toBe(0);
  });

  it('the classic rail reads main record and feeds buildEkip', () => {
    const rail = src('components/layout/SidebarTeam.tsx');
    expect(rail).toContain('fetchSuperState(api)');
    expect(rail).toContain('memberWaitCounts(st.enabled ? st.queue : [])');
    expect(rail).toMatch(/buildEkip\(summaries, identitiesOf\(agentsQ\.data \?\? \[\]\), \[\], waits\)/);
  });

  it('the surface sends the counts with its drawer facts', () => {
    const surface = src('components/sleepy/AgentSurface.tsx');
    expect(surface).toContain('memberWaitCounts(mainSuperState?.enabled ? mainSuperState.queue : [])');
    expect(surface).toMatch(/emitInstance<DrawerSurfaceWithWaits>\(bus, DRAWER_SURFACE_EVENT, \{[\s\S]*?memberWaits,\s*\}\)/);
  });
});

describe("a session's own chat draws its refused calls", () => {
  beforeEach(() => { _resetOwnerItems(); publishSessionGrantItems('turing-child', null); });

  it('the fixture is a refusal by the pinned contract (owner item, wait.refusal whole, offer)', () => {
    // If this holds and the next test draws nothing, the fault is in the store or the card, not here.
    const view = { record: 'turing', memberTitle: 'Turing', items: [refused()] };
    expect(refusalItemsOf(view).map((q) => q.id)).toEqual(['q-r1']);
    expect(callOf(refused())).toEqual({ tool: 'Bash', input: SCRIPT, whole: true });
  });

  it('draws one card per published refusal, with the member size', () => {
    publishSessionGrantItems('turing-child', { record: 'turing', memberTitle: 'Turing', items: [refused()] });
    const html = renderToStaticMarkup(createElement(SessionRefusalCards, { sessionId: 'turing-child', who: 'Turing' }));
    // The markup itself in the failure message: an empty string means the published view was not read.
    expect(html).toContain('data-testid="refusal-card"');
    expect(html).toContain(SCRIPT);
    expect(html).toContain('Turing wanted to run this. Nothing ran.');
    expect(has(html, 'grant-size-member')).toBe(true);
  });

  it('draws nothing for another session, a permission item, or after unpublishing', () => {
    publishSessionGrantItems('turing-child', { record: 'turing', memberTitle: 'Turing', items: [refused()] });
    expect(renderToStaticMarkup(createElement(SessionRefusalCards, { sessionId: 'other', who: 'X' }))).toBe('');
    publishSessionGrantItems('turing-child', { record: 'turing', items: [{ id: 'q-p', sessionId: 'turing-child', kind: 'permission', state: 'pending', createdAt: 1, requestId: 'r1' } as SuperQueueItem] });
    expect(renderToStaticMarkup(createElement(SessionRefusalCards, { sessionId: 'turing-child', who: 'Turing' }))).toBe('');
    publishSessionGrantItems('turing-child', null);
    expect(renderToStaticMarkup(createElement(SessionRefusalCards, { sessionId: 'turing-child', who: 'Turing' }))).toBe('');
  });

  it('ChatPane mounts the cards beside the permission cards, keyed by the conversation id', () => {
    const pane = src('components/sleepy/ChatPane.tsx');
    const perm = pane.indexOf('<PermissionCard key={p.requestId}');
    const ref = pane.indexOf('<SessionRefusalCards sessionId={session.claudeId ?? null} who={refusalWho} />');
    expect(perm).toBeGreaterThan(0);
    expect(ref).toBeGreaterThan(perm);
    // Before the question cards: the permission block is one group.
    expect(ref).toBeLessThan(pane.indexOf('<SurveyCard', perm));
  });
});

describe('the surface publishes each session its items and names members', () => {
  const surface = src('components/sleepy/AgentSurface.tsx');

  it('publishes per session from every super record, mirrors excluded, and unpublishes the closed', () => {
    expect(surface).toContain('sessionGrantViews(vaultSupers,');
    expect(surface).toMatch(/if \(q\.state === 'done' \|\| q\.kind === 'member'\) continue;/);
    expect(surface).toMatch(/kind !== 'permission' && kind !== 'refusal'/);
    expect(surface).toContain("record: member ?? 'main'");
    expect(surface).toContain('if (!next.has(sid)) publishSessionGrantItems(sid, null);');
    expect(surface).toContain('for (const [sid, view] of grantViews) publishSessionGrantItems(sid, view);');
  });

  it("gives the bar's look the member's title and never reads the automations list (S3)", () => {
    expect(surface).toContain('memberTitleFor: barMemberTitle,');
    expect(surface).not.toContain('useAutomations');
  });
});
