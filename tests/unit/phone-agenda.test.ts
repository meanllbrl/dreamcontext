/**
 * The Super Agent's agenda on the hands-free phone (task hands-free-telefonda-super-agent-
 * sohbeti-ajandayi…, AC3, AC5-AC7):
 *  - the sheet is the desktop's notepad: from one record, the digest the Mac sends gives the same
 *    rows in the same order as the stage's agenda, named by the Mac's job card title;
 *  - the strip counts what the sheet holds; an empty agenda says so;
 *  - the phone's chat folds event turns from the digest, and a later digest with a new batch or a
 *    new child name re-folds it (never frozen on the first);
 *  - a ↩ writes into the PHONE's composer; a child's name on an event line opens nothing and
 *    throws nothing; the answer receipt draws on the mirror.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { PhoneAgenda, digestToNotepadInput, phoneEventContext } = await import('../../dashboard/src/components/sleepy/super/PhoneAgenda.js');
const { groupSuperEventTurns, superEventText, superNotepad } = await import('../../dashboard/src/components/sleepy/super/superHandover.js');
const { openJobRow } = await import('../../dashboard/src/components/sleepy/super/superJobsStore.js');
const { readSuperDigest } = await import('../../dashboard/src/lib/superTypes.js');
const { superDigest, superDigestFrame } = await import('../../src/lib/super/phone-mirror.js');
const { emptySuperState } = await import('../../src/lib/super/types.js');
type SuperState = import('../../src/lib/super/types.js').SuperState;

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

function record(over: Partial<SuperState> = {}): SuperState {
  return {
    ...emptySuperState(), session: 'S', enabled: true,
    children: {
      c1: { sessionId: 'c1', brief: '', adopted: false, startedAt: 1 },
      c2: { sessionId: 'c2', brief: 'Fix the login copy', adopted: false, startedAt: 2 },
    },
    containers: [{ id: 'chat-c1', kind: 'chat', ref: 'c1', shape: 'tall', place: 'float', title: 'Pricing card · develop' }],
    queue: [
      { id: 'q-p', sessionId: 'c2', kind: 'permission', state: 'pending', createdAt: 5, ownerText: 'never' },
      { id: 'q-a', sessionId: 'S', kind: 'ask', state: 'escalated', createdAt: 3, ownerText: 'Which design?' },
      { id: 'q-e', sessionId: 'c1', kind: 'question', state: 'escalated', createdAt: 2, ownerText: 'Annual or monthly?' },
      { id: 'q-w', sessionId: 'c2', kind: 'question', state: 'pending', createdAt: 6 },
      { id: 'q-o', sessionId: 'c1', kind: 'owner', state: 'escalated', createdAt: 7, ownerText: 'Run the deploy command' },
      { id: 'q-d', sessionId: 'c1', kind: 'done', state: 'pending', createdAt: 8 },
    ],
    pad: [
      { id: 'n1', section: 'now', text: 'Fixing the paywall', at: 1 },
      { id: 'n2', section: 'done', text: 'Shipped login', at: 2 },
      { id: 'n3', section: 'waiting', text: 'Your pick between the two designs', at: 3 },
      { id: 'n4', section: 'done', text: 'Release installed', at: 9 },
      { id: 'n5', section: 'now', text: 'Moving the agenda', at: 4 },
    ],
    ownerBatches: ['b-1'],
    ...over,
  } as SuperState;
}
/** What the phone holds: the frame as it crossed the wire. */
const wire = (s: SuperState) => readSuperDigest(JSON.parse(superDigestFrame(superDigest(s))))!;
const strip = (s: SuperState | null) => renderToStaticMarkup(createElement(PhoneAgenda as never, { digest: s ? wire(s) : null, onWriteAbout: () => {} } as never));

describe('the phone agenda is the desktop notepad', () => {
  it('digestToNotepadInput: text is ownerText, names are the Mac card titles, the Super is "Claude"', () => {
    const { state, look } = digestToNotepadInput(wire(record()), 'Claude');
    expect(state.queue.find((q) => q.id === 'q-a')).toMatchObject({ kind: 'ask', state: 'escalated', ownerText: 'Which design?', sessionId: 'S' });
    expect(state.queue.find((q) => q.id === 'q-p')!.ownerText).toBeUndefined();
    expect(look.titleFor('c1')).toBe('Pricing card · develop');
    expect(look.nameFor!('c2')).toBe('Fix the login copy');
    expect(look.nameFor!('zz')).toBe('');
    expect(look.titleFor('zz')).toBe('zz');
    expect(look.superTitle).toBe('Claude');
  });

  it('from one record: the same three sections, the same rows, in the same order as the stage', () => {
    const rec = record();
    const { state, look } = digestToNotepadInput(wire(rec), 'Claude');
    const phone = superNotepad(state, look);
    // The stage's look names a job by its card title too (SuperSurface titleFor).
    const desk = superNotepad(rec as never, { live: () => null, titleFor: (c) => rec.containers.find((k) => k.ref === c)?.title ?? rec.children[c]?.brief ?? c, superTitle: 'Claude' });
    expect(phone).toEqual(desk);
    expect(phone.waiting.map((r) => r.key)).toEqual(['q:q-p', 'q:q-e', 'q:q-a', 'q:q-o', 'q:q-w', 'n:n3']);
    expect(phone.waiting.find((r) => r.item === 'q-e')!.text).toBe('Pricing card');
    expect(phone.now.map((r) => r.note)).toEqual(['n1', 'n5']);
    expect(phone.done.map((r) => r.note)).toEqual(['n4', 'n2']);
  });

  it('the strip counts what the sheet holds; an empty agenda says so; no digest, no strip', () => {
    const html = strip(record());
    expect(html).toContain('data-testid="phone-agenda-strip"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-waiting="true"');
    // t() returns the key in this test: the counts are the strings' {n}.
    expect(html).toMatch(/data-testid="phone-agenda-now">super\.phoneAgenda\.now</);
    expect(html).not.toContain('phone-agenda-sheet');
    const empty = strip(record({ queue: [], pad: [] }));
    expect(empty).toContain('data-testid="phone-agenda-empty"');
    expect(empty).not.toContain('data-waiting');
    expect(strip(null)).toBe('');
  });
});

describe('event turns on the phone fold from the digest', () => {
  const user = (id: string, text: string) => ({ kind: 'user', id, text });
  const text = (id: string) => ({ kind: 'text', id, text: 'reply' });
  const batch = (b: string) => superEventText('batch', 'c1', { batch: b, items: [{ item: 'q-1', child: 'c1', kind: 'done' }] });
  const items = [user('e1', batch('b-1')), text('t1'), user('e2', batch('b-2')), text('t2')];

  it('a later digest with a new batch re-folds (a new key), a new note does not (same key)', () => {
    const first = phoneEventContext(wire(record({ ownerBatches: [] })));
    expect(groupSuperEventTurns(items, { ownerBatches: first.ctx.ownerBatches, expanded: new Set() }).kept.map((i) => i.id)).toEqual(['e1', 'e2']);
    const second = phoneEventContext(wire(record({ ownerBatches: ['b-2'] })));
    expect(second.key).not.toBe(first.key);
    expect(groupSuperEventTurns(items, { ownerBatches: second.ctx.ownerBatches, expanded: new Set() }).kept.map((i) => i.id)).toEqual(['e1', 'e2', 't2']);
    expect(phoneEventContext(wire(record({ ownerBatches: [], pad: [] }))).key).toBe(first.key);
  });

  it('a new child name moves the key and the title', () => {
    const before = phoneEventContext(wire(record()));
    const after = phoneEventContext(wire(record({ children: { ...record().children, c3: { sessionId: 'c3', brief: 'New job', adopted: false, startedAt: 3 } } })));
    expect(after.key).not.toBe(before.key);
    expect(before.ctx.titleFor('c3')).toBe('c3');
    expect(after.ctx.titleFor('c3')).toBe('New job');
  });

  it('a child\'s name on an event line opens nothing on the phone and throws nothing', () => {
    expect(() => openJobRow('c:c1')).not.toThrow();
  });
});

describe('the wiring', () => {
  const surface = read('dashboard/src/components/sleepy/AgentSurface.tsx');
  const pane = read('dashboard/src/components/sleepy/ChatPane.tsx');

  it('the strip mounts only on the phone\'s Super mirror chat, under the header', () => {
    expect(surface).toMatch(/if \(!macPhone \|\| !expanded \|\| phoneView !== 'chat' \|\| !mobileActive\) return undefined;/);
    expect(surface).toMatch(/\(s as ChatSession\)\.superMirror \? s as ChatSession : undefined/);
    expect(surface).toMatch(/<\/div>\n\s*\{phoneSuperChat && <PhoneAgenda digest=\{phoneDigest\} onWriteAbout=\{writePhoneAboutRow\} \/>\}\n\s*\{body\}/);
  });

  it('a ↩ on the phone writes the About chip into the phone\'s own composer, the desktop\'s into its Super chat', () => {
    expect(surface).toMatch(/const writePhoneAboutRow = useCallback\(\(row: AgendaRow\) => writeAboutInto\(phoneSuperChat, row\)/);
    expect(surface).toMatch(/const writeAboutRow = useCallback\(\(row: AgendaRow\) => writeAboutInto\(superChatRef\.current, row\)/);
    expect(surface).toMatch(/const convId = cs\.scratchId \|\| cs\.claudeId;[\s\S]{0,400}setAbout\(convId, \{ id: nextAttachmentId\(\), kind: 'about'/);
  });

  it('every mirror session publishes its event context keyed by the digest', () => {
    expect(surface).toMatch(/if \(mirror\) \{\n\s*cs\.onSuperDigest\(\(d\) => \{\n\s*if \(!d\) return;\n\s*const \{ ctx, key \} = phoneEventContext\(d\);\n\s*publishSuperEventContext\(cid, ctx, key\);/);
  });

  it('the pane folds and draws the receipt in any Super view, the phone\'s mirror included', () => {
    expect(pane).toMatch(/const superCtx = useSuperEventContext\(superView \? session\.claudeId : null\);/);
    expect(pane).toMatch(/item\.kind === 'user' && superView && parseSuperAnswer\(item\.text\)/);
  });
});
