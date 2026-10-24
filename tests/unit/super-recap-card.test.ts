/**
 * The recap turn as its own card (owner 2026-10-23, task super-recap-widget-always-open):
 *  - groupSuperEventTurns never keeps a recap flat, even when expanded; its whole turn (prose,
 *    tools, questions) is drawn inside the card, so nothing the old Show reached is lost;
 *  - the card draws OPEN on first paint, folds to its header on Hide, and opens again on Show;
 *    a turn with nothing in it yet draws the header alone, with no toggle;
 *  - its open state is the absence of a pane-local hide, so a reload draws it open again;
 *  - ordinary event turns keep their one-line fold; the card's colours are tokens only.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { groupSuperEventTurns, type SuperEventGroup } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { placeQuestionCards } from '../../dashboard/src/components/sleepy/super/superQuestions.js';
import type { ChatItem } from '../../dashboard/src/components/sleepy/chatSession.js';
import { fileURLToPath } from 'node:url';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({
    locale: 'en',
    setLocale: () => {},
    t: (key: string) => ({
      'super.recap.title': 'While you were away', 'super.event.expand': 'Show', 'super.event.collapse': 'Hide',
      'super.event.commands': 'ran {n} commands',
    } as Record<string, string>)[key] ?? key,
  }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { SuperRecapCard } = await import('../../dashboard/src/components/sleepy/super/SuperRecapCard.js');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const user = (id: string, text: string) => ({ kind: 'user', id, text });
const text = (id: string) => ({ kind: 'text', id, text: `reply ${id}` });
const tool = (id: string, command: string) => ({ kind: 'tool', id, name: 'Bash', input: { command } });
const batch = (b: string) => `[super events] batch=${b} items=1\n- item=q-1 child=c1 event=done`;

const recapGroup = (over: Partial<SuperEventGroup> = {}): SuperEventGroup => ({
  anchor: 'r1', kind: 'recap', batch: null, items: [], commands: 0, full: false, folded: ['t1'], ...over,
});
const card = (hidden: boolean, group = recapGroup(), empty = false) => renderToStaticMarkup(createElement(SuperRecapCard, {
  group, hidden, onToggle: () => {},
}, ...(empty ? [] : [createElement('p', { key: 't1', className: 'the-reply' }, 'Since you were away nothing new has finished.')])));

describe('the recap fold', () => {
  it('a recap folds its whole turn, tools included, for its card to draw', () => {
    const items = [user('r1', '[super recap] item=q-r children=2'), tool('k1', 'dreamcontext super list'), tool('k2', 'git log'), text('t1'), text('t2')];
    const { kept, groups } = groupSuperEventTurns(items, { ownerBatches: [], expanded: new Set() });
    expect(kept.map((i) => i.id)).toEqual(['r1']);
    expect(groups.get('r1')).toMatchObject({ kind: 'recap', full: false, commands: 1, folded: ['k1', 'k2', 't1', 't2'] });
  });

  it('a recap is never kept flat, even when its anchor is in the expanded set', () => {
    const items = [user('r1', '[super recap] item=q-r children=2'), text('t1')];
    const { kept, groups } = groupSuperEventTurns(items, { ownerBatches: [], expanded: new Set(['r1']) });
    expect(kept.map((i) => i.id)).toEqual(['r1']);
    expect(groups.get('r1')?.folded).toEqual(['t1']);
  });

  it('an ordinary event turn is unchanged: one line, folded, no reply list', () => {
    const items = [user('e1', batch('b-1')), text('t1')];
    const { kept, groups } = groupSuperEventTurns(items, { ownerBatches: [], expanded: new Set() });
    expect(kept.map((i) => i.id)).toEqual(['e1']);
    expect(groups.get('e1')).toMatchObject({ kind: 'batch', full: false, folded: ['t1'] });
    expect(groupSuperEventTurns(items, { ownerBatches: [], expanded: new Set(['e1']) }).kept.map((i) => i.id)).toEqual(['e1', 't1']);
  });

  it('an owner message ends the recap turn: his bubble and the reply after it stay outside the card', () => {
    const items = [user('r1', '[super recap] item=q-r children=1'), text('t1'), user('own', 'thanks'), text('t2')];
    const { kept, groups } = groupSuperEventTurns(items, { ownerBatches: [], expanded: new Set() });
    expect(kept.map((i) => i.id)).toEqual(['r1', 'own', 't2']);
    expect(groups.get('r1')?.folded).toEqual(['t1']);
  });
});

describe('a question the recap asks', () => {
  // ChatPane places question cards on what a piece DRAWS: what it keeps, plus each recap's body.
  const drawnOf = (piece: ChatItem[]) => {
    const { kept, groups } = groupSuperEventTurns(piece as Array<ChatItem & { text?: string }>, { ownerBatches: [], expanded: new Set() });
    const inCard = new Set([...groups.values()].filter((g) => g.kind === 'recap').flatMap((g) => g.folded));
    const keptIds = new Set(kept.map((i) => i.id));
    return { inCard, drawn: piece.filter((i) => keptIds.has(i.id) || inCard.has(i.id)) };
  };
  const ask = (id: string, item: string) => ({
    kind: 'tool', id, toolUseId: `tu-${id}`, name: 'Bash', input: { command: 'dreamcontext super ask "Ship the login fix?"' },
    status: 'done', startedAt: 0, result: JSON.stringify({ item, asked: true }),
  }) as ChatItem;
  const t = (id: string) => ({ kind: 'text', id, index: 0, text: 'words', done: true, ts: 0 }) as ChatItem;
  const u = (id: string, text: string) => ({ kind: 'user', id, text, ts: 0 }) as ChatItem;

  it('lands inside the recap card, under its prose', () => {
    const { inCard, drawn } = drawnOf([u('r1', '[super recap] item=q-r children=1'), t('t1'), ask('k1', 'q-ask-1'), t('t2')]);
    const placed = placeQuestionCards(drawn);
    expect([...placed.keys()]).toEqual(['t2']);
    expect(inCard.has('t2')).toBe(true);
    expect(placed.get('t2')?.[0]).toMatchObject({ item: 'q-ask-1', live: true });
  });

  it('asked again after the recap, the later call is the live one (reading order)', () => {
    const { drawn } = drawnOf([u('r1', '[super recap] item=q-r children=1'), ask('k1', 'q-ask-1'), t('t1'), u('own', 'and?'), ask('k2', 'q-ask-1'), t('t2')]);
    const placed = placeQuestionCards(drawn);
    expect(placed.get('t1')?.[0]).toMatchObject({ live: false });
    expect(placed.get('t2')?.[0]).toMatchObject({ live: true });
  });

  it('an ordinary event line\'s question is not drawn in place: the tail draws it, as before', () => {
    const { drawn } = drawnOf([u('e1', batch('b-1')), ask('k1', 'q-ask-1'), t('t1')]);
    expect(placeQuestionCards(drawn).size).toBe(0);
  });
});

describe('SuperRecapCard', () => {
  it('first paint is OPEN: the header, the reply, and a Hide toggle', () => {
    const html = card(false);
    expect(html).toContain('data-testid="super-recap-card"');
    expect(html).not.toContain('data-hidden');
    expect(html).toContain('While you were away');
    expect(html).toContain('super-recap-card-body');
    expect(html).toContain('Since you were away nothing new has finished.');
    expect(html).toMatch(/aria-expanded="true"[^>]*>Hide</);
  });

  it('hidden folds it to its header with a Show toggle', () => {
    const html = card(true);
    expect(html).toContain('data-hidden="true"');
    expect(html).toContain('While you were away');
    expect(html).not.toContain('super-recap-card-body');
    expect(html).not.toContain('the-reply');
    expect(html).toMatch(/aria-expanded="false"[^>]*>Show</);
  });

  it('a turn with nothing in it yet draws the header alone, with nothing to hide', () => {
    const html = card(false, recapGroup({ folded: [] }), true);
    expect(html).toContain('While you were away');
    expect(html).not.toContain('super-recap-card-body');
    expect(html).not.toContain('super-recap-card-toggle');
  });

  it('the toggle names what it controls and the section is named by its title', () => {
    const html = card(false);
    const title = /class="super-recap-card-title" id="([^"]+)"/.exec(html)?.[1];
    const body = /class="super-recap-card-body" id="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain('role="group"');
    expect(html).toContain(`aria-labelledby="${title}"`);
    expect(html).toContain(`aria-describedby="${title}"`);
    expect(html).toContain(`aria-controls="${body}"`);
  });

  it('names the commands it ran other than dreamcontext super', () => {
    expect(card(false, recapGroup({ commands: 2 }))).toContain('ran 2 commands');
    expect(card(false)).not.toContain('commands');
  });
});

describe('ChatPane draws the recap as a card, open after every reload', () => {
  const pane = read('dashboard/src/components/sleepy/ChatPane.tsx');

  it('a recap anchor renders the card before the one-line branch', () => {
    const at = pane.indexOf("group.kind === 'recap'");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(pane.indexOf('<SuperEventLine key={item.id}'));
    expect(pane).toMatch(/const hidden = hiddenRecaps\.has\(item\.id\);/);
    expect(pane).toMatch(/<SuperRecapCard key=\{item\.id\} group=\{group\} hidden=\{hidden\} onToggle=\{toggleRecap\}>/);
  });

  it('the card draws the WHOLE folded turn: segmented into run cards, with its question cards', () => {
    expect(pane).toMatch(/const body = piece\.filter\(\(it\) => ids\.has\(it\.id\)\);/);
    expect(pane).toMatch(/recapBodies\.set\(k, segmentToolRuns\(body,/);
    expect(pane).toMatch(/drawn = piece\.filter\(\(it\) => keptIds\.has\(it\.id\) \|\| inCard\.has\(it\.id\)\)/);
    expect(pane).toMatch(/placeQuestionCards\(drawn\)/);
    // One flat keyed list, as in the transcript: a question card that moves keeps its state.
    expect(pane).toMatch(/body\.flatMap\(\(seg, i\) => \[renderSegment\(seg, accruing && i === tail, noStretches\), \.\.\.questionNodes\(seg\)\]\)/);
  });

  it('a hidden card builds nothing, so its live question and running team fall to the tail', () => {
    expect(pane).toMatch(/const body = hidden \? \[\] : \(recapBodies\.get\(item\.id\) \?\? \[\]\)/);
  });

  it('a segment that draws nothing does not open the card; a streaming turn keeps its run live', () => {
    expect(pane).toMatch(/const shows = \(seg: RunSegment<ChatItem>\) => seg\.kind === 'run' \|\| shapeOf\(seg\.item\)\.draw !== 'nothing';/);
    expect(pane).toMatch(/\.filter\(\(seg\) => shows\(seg\) \|\| cardsOf\(seg\)\.length > 0\)/);
    // The live run is the last segment that SHOWS something, never an invisible one carrying a card.
    expect(pane).toMatch(/while \(tail >= 0 && !shows\(body\[tail\]\)\) tail -= 1;/);
    expect(pane).toMatch(/itemNode\(seg\.item, stretches\.get\(seg\.item\.id\), accruing\)/);
  });

  it('the hide state starts empty and is never persisted, so a reload draws the recap open', () => {
    expect(pane).toMatch(/const \[hiddenRecaps, setHiddenRecaps\] = useState<ReadonlySet<string>>\(\(\) => new Set\(\)\);/);
    expect(pane).not.toMatch(/hiddenRecaps[\s\S]{0,200}(localStorage|sessionStorage)/);
  });

  it('the card speaks both languages', () => {
    const i18n = read('dashboard/src/context/I18nContext.tsx');
    expect(i18n).toContain("'super.recap.title': 'While you were away'");
    expect(i18n).toContain("'super.recap.title': 'Sen yokken'");
  });

  it('the card is drawn from theme tokens only', () => {
    const css = read('dashboard/src/components/sleepy/super/superEventLine.css');
    const block = css.slice(css.indexOf('.super-recap-card {'));
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(block).toMatch(/var\(--color-accent\)/);
    // A clip would cut the reply's hover bar (Copy, Quote), which rides just below its row.
    expect(block).not.toMatch(/overflow:\s*hidden/);
  });
});
