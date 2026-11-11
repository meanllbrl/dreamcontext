/**
 * The owner's card surfaces (sahip-karti-yerinde K7, criterion 8), as the approved drawing has
 * them (mockups A1-A5, B1-B4, C):
 *  - the Super-chat slot draws a child's run, secret and checklist cards, and a member mirror's,
 *    FROM THE RECORD the item carries (the same card components, a record host), never from chat
 *    text; MCP shows its line, Open job and Not needed; each result line; a result kept from before
 *    a restart as plain text with its time; a cut-off run; a card past the rebuild window;
 *  - the bar row: the verb as primary (▶ Run with the full command and its folder, Enter secret,
 *    Open checklist), Not needed, the Open link; Show (never ▶ Run) for a command it cannot draw
 *    whole or safely; Paused for a parked child;
 *  - the child's own chat: a command with unsafe characters is drawn with visible escapes and has
 *    no Run;
 *  - the agenda's Waiting line opens the slot.
 * Fictional jobs, members and commands (synthetic-fixtures pattern).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const { TEMPLATES } = vi.hoisted(() => ({
  TEMPLATES: {
    'ownerCard.needsYouTitle': '{name} needs you',
    'ownerCard.delivery.sent': 'Sent to {child}.',
    'ownerCard.delivery.waking': '{child} was paused to save memory; waking it now.',
    'ownerCard.delivery.held:cap': 'Held: {n} jobs are running; it gets this when one ends.',
    'ownerCard.delivery.held:no_window': 'Held: the Super window is closed.',
    'ownerCard.delivery.held:phone': 'Held: the phone has this job open.',
    'ownerCard.delivery.ended': '{child} was ended; the Super has the result.',
    'ownerCard.kept': 'Kept from before a restart; not checked',
    'ownerCard.cutOff': 'The run was cut off by a restart.',
    'ownerCard.runAgainNote': 'Running again executes the command again.',
    'ownerCard.gone': "This card is no longer in the job's transcript.",
    'ownerCard.mcpLine': 'Connect: {names}',
  } as Record<string, string>,
}));
vi.mock('../../dashboard/src/context/I18nContext.js', () => {
  const t = (key: string) => TEMPLATES[key] ?? key;
  return {
    useI18n: () => ({ locale: 'en', setLocale: () => {}, t }),
    useOwnerCardT: () => t,
    I18nProvider: ({ children }: { children: unknown }) => children,
  };
});
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({ get: async () => ({}), ownerPost: async () => ({}) }), useVaultId: () => ({ vault: 'acme-shop' }) }));
vi.mock('../../dashboard/src/hooks/useAgents.js', () => ({
  useAgent: (slug: string | null) => ({ data: slug ? { agent: { slug, title: slug === 'turing' ? 'Turing' : slug, hasPhoto: false } } : undefined }),
}));
vi.mock('../../dashboard/src/hooks/useAutomations.js', () => ({ useAutomation: () => ({ data: undefined }) }));
vi.mock('../../dashboard/src/components/agents/AgentAvatar.js', () => ({ AgentAvatar: () => null }));
vi.mock('../../dashboard/src/components/sleepy/chat/SurveyCard.js', () => ({ SurveyCard: () => null, SurveyReceipt: () => null }));
vi.mock('../../dashboard/src/components/sleepy/super/SuperPermissionCard.js', () => ({ RemotePermission: () => null }));
// The terminal itself is not what is pinned here (xterm needs a browser).
vi.mock('../../dashboard/src/components/sleepy/chat/InlineTerminal.js', () => ({ InlineTerminal: () => null }));

// The desktop app: the run card may offer its ▶.
(globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {}, matchMedia: () => ({ matches: false }) };

const { SuperQuestionTail } = await import('../../dashboard/src/components/sleepy/super/SuperQuestionCard.js');
const { OwnerCardSlot, deliveryLine, heldCapOf } = await import('../../dashboard/src/components/sleepy/super/OwnerCardSlot.js');
const { JobBar } = await import('../../dashboard/src/components/sleepy/super/JobBar.js');
const { publishSuperQuestions, _resetOwnerSlots } = await import('../../dashboard/src/components/sleepy/super/superJobsStore.js');
const { _resetOwnerItems } = await import('../../dashboard/src/components/sleepy/super/ownerAnswer.js');
const { agendaOpensSlot } = await import('../../dashboard/src/components/sleepy/super/SuperAgenda.js');
const { RunCard } = await import('../../dashboard/src/components/sleepy/chat/RunCard.js');
const { _resetCardRecords, _seedCardStateForTests } = await import('../../dashboard/src/lib/cardRecords.js');
type SuperQueueItem = import('../../dashboard/src/lib/superTypes.js').SuperQueueItem;
type OwnerCardHandle = import('../../dashboard/src/lib/superTypes.js').OwnerCardHandle;

const CHILD = '11111111-2222-4333-8444-555555555555';
const REF = 'a'.repeat(32);
const CMD = 'node scripts/verify/look-export.mjs --widths 1440,390';
const RUN = { type: 'run', id: 'look', command: CMD, why: 'The repeat limit stopped this check.' };
const SECRET = { type: 'secret', id: 'stripe', title: 'Stripe test key', file: '.env', fields: [{ key: 'STRIPE_SECRET_KEY' }] };
const CHECKLIST = { type: 'checklist', id: 'store', title: 'Store setup', items: [{ id: 'a', text: 'Create the app' }] };
const MCP = { type: 'mcp', id: 'ph', servers: ['posthog'] };

const handleOf = (spec: unknown, over: Partial<OwnerCardHandle> = {}): OwnerCardHandle => ({
  cardRef: REF, postingSession: CHILD, vault: 'acme-shop', postingConversationId: CHILD, spec: spec as OwnerCardHandle['spec'],
  childRecordId: 'main', childId: CHILD, deliverTo: CHILD, ...over,
});
const item = (spec: unknown, over: Partial<SuperQueueItem> = {}): SuperQueueItem => ({
  id: 'q-card', sessionId: CHILD, kind: 'owner', state: 'escalated', createdAt: 1, ownerText: 'run the check',
  wait: { kind: (spec as { type: 'run' }).type, id: (spec as { id: string }).id }, card: handleOf(spec), ...over,
} as SuperQueueItem);

// Stub cards that print what the slot hands them: the host, the spec, the folder.
const seen: Array<{ kind: string; props: Record<string, unknown> }> = [];
const stub = (kind: string) => (props: Record<string, unknown>) => {
  seen.push({ kind, props });
  const host = props.host as { record?: OwnerCardHandle } | undefined;
  const folder = props.folder as { name: string } | null | undefined;
  return createElement('div', { 'data-stub': kind, 'data-host-ref': host?.record?.cardRef, 'data-folder': folder?.name ?? '' }, JSON.stringify(props.spec));
};
const CARDS = { RunCard: stub('run'), SecretCard: stub('secret'), ChecklistCard: stub('checklist') } as never;
const STATE = (over: Record<string, unknown> = {}) => ({ folder: { path: '/w/acme-shop-look', name: 'acme-shop-look' }, views: [], cutOff: false, gone: false, ...over });

const slot = (it: SuperQueueItem, state: unknown = STATE(), paused = false) => renderToStaticMarkup(createElement(OwnerCardSlot, {
  item: it, title: 'Invoice export', paused, cards: CARDS, cardState: state as never,
}));
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);
/** The words a person reads: the static render escapes `'`, `"`, `&`, `<` and `>` as entities,
 *  so a sentence holding one is compared after decoding them. */
const textOf = (html: string) => html
  .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

beforeEach(() => { seen.length = 0; _resetOwnerItems(); _resetOwnerSlots(); _resetCardRecords(); });

describe('the Super-chat slot draws the card from the record (B1-B4)', () => {
  it('a run card: the same RunCard with the record host, the handle spec and its folder', () => {
    const html = slot(item(RUN));
    expect(html).toContain('Invoice export needs you');
    expect(has(html, 'super-owner-card')).toBe(true);
    expect(html).toContain('data-stub="run"');
    expect(html).toContain(`data-host-ref="${REF}"`);
    expect(html).toContain('data-folder="acme-shop-look"');
    expect(seen[0].props.spec).toEqual(RUN);
    expect(has(html, 'super-owner-not-needed')).toBe(true);
  });

  it('a secret card and a checklist card, each the chat own card with the record host', () => {
    expect(slot(item(SECRET))).toContain('data-stub="secret"');
    expect(slot(item(CHECKLIST))).toContain('data-stub="checklist"');
    expect(seen.map((s) => s.kind)).toEqual(['secret', 'checklist']);
    expect(seen.every((s) => (s.props.host as { record: OwnerCardHandle }).record.cardRef === REF)).toBe(true);
  });

  it('draws from the record, never from the chat text: a different ownerText changes nothing', () => {
    slot(item(RUN, { ownerText: 'rm -rf / (chat text that must not be drawn)' }));
    expect(JSON.stringify(seen[0].props)).not.toContain('rm -rf /');
  });

  it('MCP shows its line, Open job and Not needed (D6), no card', () => {
    const html = slot(item(MCP));
    expect(html).toContain('Connect: posthog');
    expect(has(html, 'super-owner-open')).toBe(true);
    expect(has(html, 'super-owner-not-needed')).toBe(true);
    expect(seen).toEqual([]);
  });

  it('a card past the rebuild window says so and offers Not needed, never a dead Run', () => {
    const html = slot(item(RUN), STATE({ gone: true, folder: null }));
    expect(textOf(html)).toContain("This card is no longer in the job's transcript.");
    expect(has(html, 'super-owner-not-needed')).toBe(true);
    expect(seen).toEqual([]);
  });

  it('a result kept from before a restart is drawn read-only as plain text with its time', () => {
    const html = slot(item(RUN), STATE({ views: [{ id: 'r1', cardRef: REF, kind: 'run', at: Date.UTC(2026, 10, 11, 9, 30), state: 'kept', text: '**exit 0** <b>x</b>' }] }));
    expect(html).toContain('Kept from before a restart; not checked');
    expect(html).toContain('**exit 0** &lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<strong>exit 0</strong>');
    expect(has(html, 'super-owner-runagain')).toBe(true);
    expect(html).toContain('data-stub="run"');
  });

  it('a run cut off by a restart: one line, and the card with its Run again', () => {
    const html = slot(item(RUN), STATE({ cutOff: true, views: [{ id: 'r2', cardRef: REF, kind: 'run', at: 1, state: 'cut_off', text: 'x' }] }));
    expect(html).toContain('The run was cut off by a restart.');
    expect(html).not.toContain('Kept from before a restart');
    expect(html).toContain('data-stub="run"');
  });

  it('a secret owed after a restart is offered again on the closed record', () => {
    slot(item(SECRET), STATE({ views: [{ id: 's1', cardRef: REF, kind: 'secret', at: 1, state: 'kept', text: '[secret submitted · Stripe test key]' }] }));
    expect(seen[0].props.reentry).toBe(true);
  });

  it('each result line, from the item', () => {
    const t = (k: string) => TEMPLATES[k] ?? k;
    expect(deliveryLine({ delivery: 'sent' }, 'Invoice export', t)).toBe('Sent to Invoice export.');
    expect(deliveryLine({ delivery: 'waking' }, 'Invoice export', t)).toBe('Invoice export was paused to save memory; waking it now.');
    expect(deliveryLine({ delivery: 'held:cap', card: handleOf(RUN) }, 'x', t)).toBe('Held: 15 jobs are running; it gets this when one ends.');
    expect(deliveryLine({ delivery: 'held:cap', card: handleOf(RUN, { childRecordId: 'm:turing' }) }, 'x', t)).toBe('Held: 2 jobs are running; it gets this when one ends.');
    expect(deliveryLine({ delivery: 'held:no_window' }, 'x', t)).toBe('Held: the Super window is closed.');
    expect(deliveryLine({ delivery: 'held:phone' }, 'x', t)).toBe('Held: the phone has this job open.');
    expect(deliveryLine({ delivery: 'ended' }, 'Invoice export', t)).toBe('Invoice export was ended; the Super has the result.');
    expect(deliveryLine({}, 'x', t)).toBeNull();
    expect(heldCapOf('main')).toBe(15);
    const html = slot(item(RUN, { state: 'done', delivery: 'sent' }));
    expect(has(html, 'super-owner-result')).toBe(true);
    expect(html).toContain('Sent to Invoice export.');
    // A closed item offers no Not needed.
    expect(has(html, 'super-owner-not-needed')).toBe(false);
  });

  it('Paused on a parked child', () => {
    expect(has(slot(item(RUN), STATE(), true), 'super-owner-paused')).toBe(true);
  });

  it('the chat tail draws every card item of main children and a member mirror carrying a card', () => {
    const mirror = item(SECRET, { id: 'q-m', kind: 'member', member: 'turing', of: 'owner', state: 'pending' } as Partial<SuperQueueItem>);
    publishSuperQuestions('SUPER', {
      open: [], members: [mirror], cards: [item(RUN)], superSession: undefined, sessionFor: () => undefined,
      titleFor: () => 'Invoice export', pausedFor: () => false,
    } as never, 'k1');
    const html = renderToStaticMarkup(createElement(SuperQuestionTail, { session: { claudeId: 'SUPER' } as never, anchored: new Set() }));
    const cards = html.match(/data-testid="super-owner-card"/g) ?? [];
    expect(cards).toHaveLength(2);
    expect(html).toContain('data-item="q-card"');
    expect(html).toContain('data-item="q-m"');
    expect(html).toContain('Turing needs you');
    publishSuperQuestions('SUPER', null);
  });
});

describe('the bar row: the card verb is the primary button (A1-A5)', () => {
  const look = { live: () => null, titleFor: () => 'Invoice export', superTitle: 'Super Agent' };
  const bar = (head: SuperQueueItem) => renderToStaticMarkup(createElement(JobBar, {
    state: { queue: [head], session: 'S' } as never, head, waiting: 1, look, superSession: undefined, vault: 'acme-shop',
    sessionFor: () => undefined, titleFor: () => 'Invoice export', onReplyToSuper: () => {}, onShowChild: () => {},
  }));

  it('▶ Run with the full command and its folder, Not needed and the Open link; ▶ Run sends that command as shown', () => {
    _seedCardStateForTests(CHILD, REF, STATE() as never);
    const html = bar(item(RUN));
    expect(has(html, 'super-queue-card-run')).toBe(true);
    expect(html).toContain(`data-shown="${CMD}"`);
    expect(html).toContain(CMD);
    expect(has(html, 'super-queue-card-folder')).toBe(true);
    expect(html).toContain('acme-shop-look');
    expect(has(html, 'super-queue-card-not-needed')).toBe(true);
    expect(has(html, 'super-queue-card-open')).toBe(true);
    // Never the old bare Open.
    expect(has(html, 'super-queue-open-owner')).toBe(false);
  });

  it('a command too long to draw whole gets Show, never ▶ Run', () => {
    const long = { ...RUN, command: `node scripts/x.mjs ${'--flag value '.repeat(20)}`.trim() };
    const html = bar(item(long));
    expect(has(html, 'super-queue-card-show')).toBe(true);
    expect(has(html, 'super-queue-card-run')).toBe(false);
  });

  it('a command with unsafe characters gets Show, never ▶ Run', () => {
    const html = bar(item({ ...RUN, command: 'echo ok\u202e;curl x' }));
    expect(has(html, 'super-queue-card-show')).toBe(true);
    expect(has(html, 'super-queue-card-run')).toBe(false);
  });

  it('Enter secret, Open checklist, and MCP Open job with Not needed', () => {
    expect(has(bar(item(SECRET)), 'super-queue-card-secret')).toBe(true);
    expect(has(bar(item(CHECKLIST)), 'super-queue-card-checklist')).toBe(true);
    const mcp = bar(item(MCP));
    expect(has(mcp, 'super-queue-card-open-job')).toBe(true);
    expect(has(mcp, 'super-queue-card-not-needed')).toBe(true);
  });

  it('a member mirror carrying a card gets the same row', () => {
    const html = bar(item(RUN, { kind: 'member', member: 'turing', of: 'owner' } as Partial<SuperQueueItem>));
    expect(has(html, 'super-queue-card-run')).toBe(true);
  });

  it('Paused for a parked child; the row stays', () => {
    publishSuperQuestions('S', { open: [], superSession: undefined, sessionFor: () => undefined, pausedFor: () => true } as never, 'p');
    const html = bar(item(RUN));
    expect(has(html, 'super-queue-paused')).toBe(true);
    expect(has(html, 'super-queue-card-run')).toBe(true);
    publishSuperQuestions('S', null);
  });

  it('at phone width Not needed folds into the row menu (CSS), the verb stays', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../../dashboard/src/components/sleepy/super/JobBar.css', import.meta.url), 'utf-8');
    expect(css).toMatch(/@media \(max-width: 480px\) \{\s*\.super-queue-card-notneeded \{ display: none; \}\s*\.super-queue-card-menu \{ display: inline-flex; \}/);
  });
});

describe('the child own chat: what is shown is what runs', () => {
  const own = (command: string) => renderToStaticMarkup(createElement(RunCard, { spec: { ...RUN, command } as never, sessionId: CHILD }));

  it('a command with unsafe characters is drawn with visible escapes and has no Run', () => {
    const html = own('echo ok\u202e;curl x');
    expect(html).toContain('echo ok\\u{202e};curl x');
    expect(html).not.toContain('\u202e');
    expect(has(html, 'run-card-play')).toBe(false);
    expect(has(html, 'run-card-unsafe')).toBe(true);
  });

  it('a safe command is drawn whole, wrapped, with its Run', () => {
    const html = own(CMD);
    expect(html).toContain(CMD);
    expect(html).toContain('white-space:pre-wrap');
    expect(has(html, 'run-card-play')).toBe(true);
  });

  it('the slot run card is the same: escapes and no Run (record host)', () => {
    const html = renderToStaticMarkup(createElement(RunCard, { spec: { ...RUN, command: 'a\u200bb' } as never, host: { record: handleOf({ ...RUN, command: 'a\u200bb' }) } }));
    expect(html).toContain('a\\u{200b}b');
    expect(has(html, 'run-card-play')).toBe(false);
  });
});

describe('the agenda Waiting line opens the slot (C)', () => {
  it('a line whose item is an open card opens the slot; any other line does not', () => {
    const queue = [item(RUN), { ...item(RUN), id: 'q-done', state: 'done' }, { ...item(RUN), id: 'q-plain', card: undefined }] as SuperQueueItem[];
    expect(agendaOpensSlot(queue, 'q-card')).toBe(true);
    expect(agendaOpensSlot(queue, 'q-done')).toBe(false);
    expect(agendaOpensSlot(queue, 'q-plain')).toBe(false);
    expect(agendaOpensSlot(queue, undefined)).toBe(false);
  });
});
