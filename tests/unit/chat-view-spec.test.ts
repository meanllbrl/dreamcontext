/**
 * Unit tests for `parseViewBlock` / `sanitizeImageSrc` — the validator for the `dream-view`
 * fence (chart / page / checklist). Uses a STUB `toAction` so these tests carry zero
 * dependency on `chatActions.ts`'s real behaviour; the injection wiring itself is exercised
 * by asserting a card's `actions` round-trip through whatever the stub returns.
 *
 * Two things carry the real risk here and are pinned hardest:
 *   • NOTHING THROWS — invalid JSON, `null`, an array, an unknown `type`, any cap breach.
 *   • EVERY DROP IS VISIBLE — a cap breach always leaves a notice naming what happened.
 */
import { describe, it, expect } from 'vitest';
import {
  parseViewBlock, sanitizeImageSrc,
  MAX_CHART_SERIES, MAX_CHART_POINTS, MAX_CHART_TOTAL_POINTS,
  MAX_PAGE_WIDGETS, MAX_RAIL_ITEMS, MAX_CARD_BADGES, MAX_CARD_SPECS, MAX_CARD_ACTIONS,
  MAX_TABLE_COLS, MAX_TABLE_ROWS, MAX_TABLE_CELL_CHARS, MAX_CHECKLIST_ITEMS, MAX_VIEW_BYTES,
} from '../../dashboard/src/lib/chatViewSpec.js';
import type {
  ChartViewSpec, PageViewSpec, ChecklistViewSpec, CardWidget, TableWidget,
} from '../../dashboard/src/lib/chatViewSpec.js';
import type { ChatAction } from '../../dashboard/src/components/sleepy/chat/chatActions.js';

/** Mirrors the shape (and the https-only rule) of the real `toAction` closely enough to
 *  exercise the injection contract, without importing `chatActions.ts` at all. */
const stubToAction = (raw: unknown): ChatAction | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === 'string' ? o.label : '';
  const action = typeof o.action === 'string' ? o.action : '';
  if (!label || !action) return null;
  if (action === 'url') {
    const url = typeof o.url === 'string' ? o.url : '';
    return url.startsWith('https:') ? { label, action: 'url', url } : null;
  }
  return { label, action } as ChatAction;
};

describe('parseViewBlock — nothing throws', () => {
  const cases: [string, string][] = [
    ['invalid JSON', '{not json'],
    ['null', 'null'],
    ['an array', '[1,2,3]'],
    ['empty object', '{}'],
    ['unknown type', '{"type":"timeline"}'],
    ['a number', '42'],
    ['a boolean', 'true'],
    ['a string', '"hello"'],
  ];

  for (const [label, json] of cases) {
    it(`degrades ${label} to view:null + a notice, never throws`, () => {
      expect(() => parseViewBlock(json, stubToAction)).not.toThrow();
      const r = parseViewBlock(json, stubToAction);
      expect(r.view).toBeNull();
      expect(r.notices.length).toBeGreaterThan(0);
    });
  }

  it('names the unrecognized type in the notice', () => {
    const r = parseViewBlock('{"type":"timeline"}', stubToAction);
    expect(r.notices[0]).toContain('timeline');
  });

  it('drops a block over MAX_VIEW_BYTES with a notice naming the size', () => {
    const bigSeries = 'x'.repeat(MAX_VIEW_BYTES + 100);
    const json = JSON.stringify({ type: 'chart', render: 'line', title: bigSeries, series: [] });
    const r = parseViewBlock(json, stubToAction);
    expect(r.view).toBeNull();
    expect(r.notices[0]).toMatch(/64KB|bytes/);
  });
});

describe('parseViewBlock — type: chart', () => {
  const line = (points: { t: string; v: number }[] = [{ t: '2026-01-01', v: 1 }]) => JSON.stringify({
    type: 'chart', render: 'line', title: 'Signups', unit: 'users',
    series: [{ name: 'daily', points }],
  });

  it('validates a well-formed line chart', () => {
    const r = parseViewBlock(line(), stubToAction);
    expect(r.notices).toEqual([]);
    const view = r.view as ChartViewSpec;
    expect(view.type).toBe('chart');
    expect(view.render).toBe('line');
    expect(view.title).toBe('Signups');
    expect(view.unit).toBe('users');
    expect(view.series).toEqual([{ name: 'daily', points: [{ t: '2026-01-01', v: 1 }] }]);
  });

  it('accepts all five render kinds', () => {
    for (const render of ['line', 'pie', 'number', 'table', 'funnel']) {
      const json = JSON.stringify({ type: 'chart', render, series: [{ name: 'a', points: [{ t: 't', v: 1 }] }] });
      const r = parseViewBlock(json, stubToAction);
      expect((r.view as ChartViewSpec)?.render).toBe(render);
    }
  });

  it('rejects a sixth render kind with a notice naming it, view:null', () => {
    const json = JSON.stringify({ type: 'chart', render: 'bar', series: [{ name: 'a', points: [{ t: 't', v: 1 }] }] });
    const r = parseViewBlock(json, stubToAction);
    expect(r.view).toBeNull();
    expect(r.notices[0]).toContain('bar');
  });

  it('unit:null round-trips explicitly; a missing unit is omitted', () => {
    const withNull = parseViewBlock(JSON.stringify({
      type: 'chart', render: 'line', unit: null, series: [{ name: 'a', points: [{ t: 't', v: 1 }] }],
    }), stubToAction);
    expect((withNull.view as ChartViewSpec).unit).toBeNull();

    const withoutUnit = parseViewBlock(JSON.stringify({
      type: 'chart', render: 'line', series: [{ name: 'a', points: [{ t: 't', v: 1 }] }],
    }), stubToAction);
    expect((withoutUnit.view as ChartViewSpec).unit).toBeUndefined();
  });

  it('drops a chart with no valid series', () => {
    const r = parseViewBlock(JSON.stringify({ type: 'chart', render: 'line', series: [] }), stubToAction);
    expect(r.view).toBeNull();
    expect(r.notices.length).toBeGreaterThan(0);
  });

  it(`MAX_CHART_SERIES: excess series dropped with a notice, first ${MAX_CHART_SERIES} kept`, () => {
    const series = Array.from({ length: MAX_CHART_SERIES + 3 }, (_, i) => ({
      name: `s${i}`, points: [{ t: 't', v: i }],
    }));
    const r = parseViewBlock(JSON.stringify({ type: 'chart', render: 'line', series }), stubToAction);
    const view = r.view as ChartViewSpec;
    expect(view.series.length).toBe(MAX_CHART_SERIES);
    expect(view.series[0].name).toBe('s0');
    expect(r.notices.some((n) => n.includes('series') && n.includes('3'))).toBe(true);
  });

  it(`MAX_CHART_POINTS: excess points per series dropped with a notice, first ${MAX_CHART_POINTS} kept`, () => {
    const points = Array.from({ length: MAX_CHART_POINTS + 10 }, (_, i) => ({ t: `t${i}`, v: i }));
    const r = parseViewBlock(line(points), stubToAction);
    const view = r.view as ChartViewSpec;
    expect(view.series[0].points.length).toBe(MAX_CHART_POINTS);
    expect(r.notices.some((n) => n.includes('points') && n.includes('10'))).toBe(true);
  });

  it('MAX_CHART_TOTAL_POINTS: whole block skipped (after per-series caps) with a notice', () => {
    // 6 series × 365 points (the per-series cap) = 2190 > 2000 total.
    const series = Array.from({ length: 6 }, (_, i) => ({
      name: `s${i}`,
      points: Array.from({ length: MAX_CHART_POINTS }, (_, j) => ({ t: `t${j}`, v: j })),
    }));
    const r = parseViewBlock(JSON.stringify({ type: 'chart', render: 'line', series }), stubToAction);
    expect(r.view).toBeNull();
    expect(r.notices.some((n) => n.includes(String(MAX_CHART_TOTAL_POINTS)))).toBe(true);
  });

  it('never throws on a garbage series shape', () => {
    const json = JSON.stringify({ type: 'chart', render: 'line', series: [1, 'x', null, { name: 5 }, {}] });
    expect(() => parseViewBlock(json, stubToAction)).not.toThrow();
    expect(parseViewBlock(json, stubToAction).view).toBeNull();
  });
});

describe('parseViewBlock — type: page — cards', () => {
  const page = (body: unknown[]) => JSON.stringify({ type: 'page', title: 'T', body });

  it('validates a rail of cards; every card field round-trips', () => {
    const r = parseViewBlock(page([{
      kind: 'rail',
      items: [{
        kind: 'card',
        title: 'Golf GTI',
        subtitle: '2021 · 48k km',
        image: { src: 'https://example.com/gti.jpg', alt: 'Golf GTI' },
        price: { amount: '€24,900', note: 'firm' },
        badges: ['manual', '1 owner'],
        specs: [{ label: 'Year', value: '2021' }],
        body: 'A clean example.',
        actions: [{ label: 'See listing', action: 'url', url: 'https://example.com/listing' }],
      }],
    }]), stubToAction);

    expect(r.notices).toEqual([]);
    const view = r.view as PageViewSpec;
    expect(view.type).toBe('page');
    const rail = view.body[0] as { kind: 'rail'; items: CardWidget[] };
    expect(rail.kind).toBe('rail');
    const card = rail.items[0];
    expect(card).toEqual({
      kind: 'card',
      title: 'Golf GTI',
      subtitle: '2021 · 48k km',
      image: { src: 'https://example.com/gti.jpg', alt: 'Golf GTI' },
      price: { amount: '€24,900', note: 'firm' },
      badges: ['manual', '1 owner'],
      specs: [{ label: 'Year', value: '2021' }],
      body: 'A clean example.',
      actions: [{ label: 'See listing', action: 'url', url: 'https://example.com/listing' }],
    });
  });

  it('drops a card with no title, with a notice, and keeps its siblings', () => {
    const r = parseViewBlock(page([
      { kind: 'card', title: 'Kept' },
      { kind: 'card', subtitle: 'no title here' },
    ]), stubToAction);
    const view = r.view as PageViewSpec;
    expect(view.body.length).toBe(1);
    expect((view.body[0] as CardWidget).title).toBe('Kept');
    expect(r.notices.some((n) => n.includes('title'))).toBe(true);
  });

  it('rejects a non-https / credentialed image URL on a card, dropping just the image', () => {
    const r = parseViewBlock(page([{
      kind: 'card', title: 'X', image: { src: 'http://example.com/x.png', alt: 'x' },
    }]), stubToAction);
    const card = (r.view as PageViewSpec).body[0] as CardWidget;
    expect(card.image).toBeUndefined();
    expect(r.notices.length).toBeGreaterThan(0);
  });

  it(`MAX_CARD_BADGES / MAX_CARD_SPECS / MAX_CARD_ACTIONS: excess dropped with a notice`, () => {
    const r = parseViewBlock(page([{
      kind: 'card',
      title: 'X',
      badges: Array.from({ length: MAX_CARD_BADGES + 2 }, (_, i) => `b${i}`),
      specs: Array.from({ length: MAX_CARD_SPECS + 2 }, (_, i) => ({ label: `l${i}`, value: `v${i}` })),
      actions: Array.from({ length: MAX_CARD_ACTIONS + 2 }, (_, i) => ({ label: `a${i}`, action: 'ask', text: 't' })),
    }]), stubToAction);
    const card = (r.view as PageViewSpec).body[0] as CardWidget;
    expect(card.badges?.length).toBe(MAX_CARD_BADGES);
    expect(card.specs?.length).toBe(MAX_CARD_SPECS);
    expect(card.actions?.length).toBe(MAX_CARD_ACTIONS);
    expect(r.notices.some((n) => n.includes('badges'))).toBe(true);
    expect(r.notices.some((n) => n.includes('specs'))).toBe(true);
    expect(r.notices.some((n) => n.includes('actions'))).toBe(true);
  });

  it('routes card actions through the injected toAction — an action the stub rejects is dropped', () => {
    const r = parseViewBlock(page([{
      kind: 'card', title: 'X', actions: [{ label: 'bad', action: 'url', url: 'http://not-https.example' }],
    }]), stubToAction);
    const card = (r.view as PageViewSpec).body[0] as CardWidget;
    expect(card.actions).toBeUndefined();
  });
});

describe('parseViewBlock — type: page — nesting depth', () => {
  const page = (body: unknown[]) => JSON.stringify({ type: 'page', body });

  it('drops rail → rail with a nesting notice', () => {
    const r = parseViewBlock(page([{
      kind: 'rail', items: [{ kind: 'rail', items: [{ kind: 'card', title: 'X' }] }],
    }]), stubToAction);
    const outerRail = (r.view as PageViewSpec).body[0] as { items: unknown[] };
    expect(outerRail.items.length).toBe(0);
    expect(r.notices.some((n) => /rail/i.test(n))).toBe(true);
  });

  it('drops rail → stack with a nesting notice', () => {
    const r = parseViewBlock(page([{
      kind: 'rail', items: [{ kind: 'stack', items: [{ kind: 'card', title: 'X' }] }],
    }]), stubToAction);
    const outerRail = (r.view as PageViewSpec).body[0] as { items: unknown[] };
    expect(outerRail.items.length).toBe(0);
    expect(r.notices.length).toBeGreaterThan(0);
  });

  it('keeps stack → rail → card', () => {
    const r = parseViewBlock(page([{
      kind: 'stack', items: [{ kind: 'rail', items: [{ kind: 'card', title: 'Kept' }] }],
    }]), stubToAction);
    const outerStack = (r.view as PageViewSpec).body[0] as { kind: string; items: { kind: string; items: CardWidget[] }[] };
    expect(outerStack.kind).toBe('stack');
    const innerRail = outerStack.items[0];
    expect(innerRail.kind).toBe('rail');
    expect(innerRail.items[0].title).toBe('Kept');
  });

  it(`MAX_RAIL_ITEMS: excess rail items dropped with a notice, first ${MAX_RAIL_ITEMS} kept`, () => {
    const items = Array.from({ length: MAX_RAIL_ITEMS + 5 }, (_, i) => ({ kind: 'card', title: `c${i}` }));
    const r = parseViewBlock(page([{ kind: 'rail', items }]), stubToAction);
    const rail = (r.view as PageViewSpec).body[0] as { items: CardWidget[] };
    expect(rail.items.length).toBe(MAX_RAIL_ITEMS);
    expect(rail.items[0].title).toBe('c0');
    expect(r.notices.some((n) => n.includes('rail') && n.includes('5'))).toBe(true);
  });

  it(`MAX_PAGE_WIDGETS: excess widgets (counting nested) dropped with a notice, first ${MAX_PAGE_WIDGETS} kept`, () => {
    const body = Array.from({ length: MAX_PAGE_WIDGETS + 4 }, () => ({ kind: 'divider' }));
    const r = parseViewBlock(page(body), stubToAction);
    const view = r.view as PageViewSpec;
    expect(view.body.length).toBe(MAX_PAGE_WIDGETS);
    expect(r.notices.some((n) => n.includes('4'))).toBe(true);
  });
});

describe('parseViewBlock — type: page — table widget', () => {
  const page = (body: unknown[]) => JSON.stringify({ type: 'page', body });

  it('pads a short row with "" to match headers, silently', () => {
    const r = parseViewBlock(page([{
      kind: 'table', headers: ['Model', 'Year', 'Price'], rows: [['Golf']],
    }]), stubToAction);
    const table = (r.view as PageViewSpec).body[0] as TableWidget;
    expect(table.rows).toEqual([['Golf', '', '']]);
    expect(r.notices).toEqual([]);
  });

  it('truncates a longer row to match headers, with a notice', () => {
    const r = parseViewBlock(page([{
      kind: 'table', headers: ['Model', 'Year'], rows: [['Golf', '2021', 'extra', 'also-extra']],
    }]), stubToAction);
    const table = (r.view as PageViewSpec).body[0] as TableWidget;
    expect(table.rows).toEqual([['Golf', '2021']]);
    expect(r.notices.some((n) => /row/i.test(n))).toBe(true);
  });

  it('drops a table with zero headers', () => {
    const r = parseViewBlock(page([{ kind: 'table', headers: [], rows: [['a']] }]), stubToAction);
    expect((r.view as PageViewSpec).body.length).toBe(0);
    expect(r.notices.some((n) => /header/i.test(n))).toBe(true);
  });

  it('drops a table with zero rows', () => {
    const r = parseViewBlock(page([{ kind: 'table', headers: ['A'], rows: [] }]), stubToAction);
    expect((r.view as PageViewSpec).body.length).toBe(0);
    expect(r.notices.some((n) => /row/i.test(n))).toBe(true);
  });

  it(`MAX_TABLE_COLS: excess headers/cells dropped with a notice`, () => {
    const headers = Array.from({ length: MAX_TABLE_COLS + 3 }, (_, i) => `h${i}`);
    const rows = [Array.from({ length: MAX_TABLE_COLS + 3 }, (_, i) => `c${i}`)];
    const r = parseViewBlock(page([{ kind: 'table', headers, rows }]), stubToAction);
    const table = (r.view as PageViewSpec).body[0] as TableWidget;
    expect(table.headers.length).toBe(MAX_TABLE_COLS);
    expect(table.rows[0].length).toBe(MAX_TABLE_COLS);
    expect(r.notices.some((n) => n.includes('columns'))).toBe(true);
  });

  it(`MAX_TABLE_ROWS: excess rows dropped with a notice, first ${MAX_TABLE_ROWS} kept`, () => {
    const rows = Array.from({ length: MAX_TABLE_ROWS + 7 }, (_, i) => [`r${i}`]);
    const r = parseViewBlock(page([{ kind: 'table', headers: ['A'], rows }]), stubToAction);
    const table = (r.view as PageViewSpec).body[0] as TableWidget;
    expect(table.rows.length).toBe(MAX_TABLE_ROWS);
    expect(table.rows[0]).toEqual(['r0']);
    expect(r.notices.some((n) => n.includes('rows') && n.includes('7'))).toBe(true);
  });

  it(`MAX_TABLE_CELL_CHARS: an over-long cell is shortened with a notice`, () => {
    const longCell = 'x'.repeat(MAX_TABLE_CELL_CHARS + 20);
    const r = parseViewBlock(page([{ kind: 'table', headers: ['A'], rows: [[longCell]] }]), stubToAction);
    const table = (r.view as PageViewSpec).body[0] as TableWidget;
    expect(table.rows[0][0].length).toBe(MAX_TABLE_CELL_CHARS);
    expect(r.notices.some((n) => n.includes('character'))).toBe(true);
  });
});

describe('parseViewBlock — type: page — other leaf widgets', () => {
  const page = (body: unknown[]) => JSON.stringify({ type: 'page', body });

  it('validates text, stat, image, and divider widgets', () => {
    const r = parseViewBlock(page([
      { kind: 'text', text: 'Some *markdown*.' },
      { kind: 'stat', items: [{ value: '42', label: 'Answers', note: 'so far' }] },
      { kind: 'image', src: 'https://example.com/a.png', alt: 'A' },
      { kind: 'divider', label: 'Section' },
    ]), stubToAction);
    expect(r.notices).toEqual([]);
    const view = r.view as PageViewSpec;
    expect(view.body).toEqual([
      { kind: 'text', text: 'Some *markdown*.' },
      { kind: 'stat', items: [{ value: '42', label: 'Answers', note: 'so far' }] },
      { kind: 'image', src: 'https://example.com/a.png', alt: 'A' },
      { kind: 'divider', label: 'Section' },
    ]);
  });

  it('drops an unknown widget kind with a notice', () => {
    const r = parseViewBlock(page([{ kind: 'tabs', items: [] }, { kind: 'card', title: 'kept' }]), stubToAction);
    const view = r.view as PageViewSpec;
    expect(view.body.length).toBe(1);
    expect(r.notices.some((n) => /unknown kind/i.test(n))).toBe(true);
  });

  it('drops a page with no body', () => {
    const r = parseViewBlock(JSON.stringify({ type: 'page' }), stubToAction);
    expect(r.view).toBeNull();
    expect(r.notices.length).toBeGreaterThan(0);
  });
});

describe('parseViewBlock — type: checklist', () => {
  const checklist = (extra: Record<string, unknown> = {}) => JSON.stringify({
    type: 'checklist', id: 'asc-api-key', title: 'App Store Connect API key',
    items: [{ id: '1', text: 'Open Users and Access' }],
    ...extra,
  });

  it('validates a well-formed checklist', () => {
    const r = parseViewBlock(checklist({
      intro: 'Follow these steps.', submitLabel: 'Send',
      items: [
        { id: '1', text: 'Open the page' },
        { id: '2', text: 'Generate a key', wants: 'secret' },
        { id: '3', text: 'Attach the file', hint: 'the .p8', wants: 'file' },
      ],
    }), stubToAction);
    expect(r.notices).toEqual([]);
    const view = r.view as ChecklistViewSpec;
    expect(view.type).toBe('checklist');
    expect(view.id).toBe('asc-api-key');
    expect(view.intro).toBe('Follow these steps.');
    expect(view.submitLabel).toBe('Send');
    expect(view.items).toEqual([
      { id: '1', text: 'Open the page' },
      { id: '2', text: 'Generate a key', wants: 'secret' },
      { id: '3', text: 'Attach the file', hint: 'the .p8', wants: 'file' },
    ]);
  });

  it('drops a checklist whose id has disallowed characters, with a notice', () => {
    const r = parseViewBlock(JSON.stringify({
      type: 'checklist', id: 'bad id!', title: 'T', items: [],
    }), stubToAction);
    expect(r.view).toBeNull();
    expect(r.notices.some((n) => /id/i.test(n))).toBe(true);
  });

  it('drops a checklist missing an id or a title', () => {
    expect(parseViewBlock(JSON.stringify({ type: 'checklist', title: 'T', items: [] }), stubToAction).view).toBeNull();
    expect(parseViewBlock(JSON.stringify({ type: 'checklist', id: 'x', items: [] }), stubToAction).view).toBeNull();
  });

  it('drops an item missing id or text, keeps the rest', () => {
    const r = parseViewBlock(JSON.stringify({
      type: 'checklist', id: 'x', title: 'T',
      items: [{ id: '1', text: 'kept' }, { id: '2' }, { text: 'no id' }],
    }), stubToAction);
    const view = r.view as ChecklistViewSpec;
    expect(view.items).toEqual([{ id: '1', text: 'kept' }]);
  });

  it('ignores an invalid "wants" value rather than rejecting the item', () => {
    const r = parseViewBlock(JSON.stringify({
      type: 'checklist', id: 'x', title: 'T',
      items: [{ id: '1', text: 'kept', wants: 'teleport' }],
    }), stubToAction);
    const view = r.view as ChecklistViewSpec;
    expect(view.items[0].wants).toBeUndefined();
  });

  it(`MAX_CHECKLIST_ITEMS: excess items dropped with a notice, first ${MAX_CHECKLIST_ITEMS} kept`, () => {
    const items = Array.from({ length: MAX_CHECKLIST_ITEMS + 6 }, (_, i) => ({ id: `${i}`, text: `t${i}` }));
    const r = parseViewBlock(checklist({ items }), stubToAction);
    const view = r.view as ChecklistViewSpec;
    expect(view.items.length).toBe(MAX_CHECKLIST_ITEMS);
    expect(view.items[0].id).toBe('0');
    expect(r.notices.some((n) => n.includes('6'))).toBe(true);
  });
});

describe('sanitizeImageSrc', () => {
  it('accepts a plain https URL unchanged', () => {
    const r = sanitizeImageSrc('https://example.com/a.png');
    expect(r).toEqual({ src: 'https://example.com/a.png', strippedQuery: false });
  });

  it('strips the query string and fragment, reporting strippedQuery:true', () => {
    const r = sanitizeImageSrc('https://example.com/a.png?w=400&h=200#frag');
    expect(r.src).toBe('https://example.com/a.png');
    expect(r.strippedQuery).toBe(true);
  });

  it('normalizes an uppercase scheme (HTTPS:) before matching', () => {
    const r = sanitizeImageSrc('HTTPS://example.com/a.png');
    expect(r.src).toBe('https://example.com/a.png');
  });

  it('strips embedded whitespace/control characters before matching, so a hidden tab in "javascript:" is still rejected', () => {
    const r = sanitizeImageSrc('java\tscript:alert(1)');
    expect(r).toEqual({ src: null, strippedQuery: false });
  });

  it('strips leading whitespace before matching, still accepting a valid https URL', () => {
    const r = sanitizeImageSrc('  \n https://example.com/a.png');
    expect(r.src).toBe('https://example.com/a.png');
  });

  it('rejects embedded credentials in the authority', () => {
    const r = sanitizeImageSrc('https://user:pass@evil.example/a.png');
    expect(r).toEqual({ src: null, strippedQuery: false });
  });

  it.each([
    ['http:', 'http://example.com/a.png'],
    ['data:', 'data:image/png;base64,aaaa'],
    ['file:', 'file:///etc/passwd'],
    ['javascript:', 'javascript:alert(1)'],
    ['protocol-relative //', '//evil.example/a.png'],
  ])('rejects %s', (_label, url) => {
    expect(sanitizeImageSrc(url)).toEqual({ src: null, strippedQuery: false });
  });

  it('passes a project-relative path through unchanged', () => {
    expect(sanitizeImageSrc('assets/photos/a.png')).toEqual({ src: 'assets/photos/a.png', strippedQuery: false });
    expect(sanitizeImageSrc('/assets/photos/a.png')).toEqual({ src: '/assets/photos/a.png', strippedQuery: false });
  });

  it('never throws on a non-string input', () => {
    // @ts-expect-error — deliberately passing the wrong type to prove the runtime guard.
    expect(() => sanitizeImageSrc(42)).not.toThrow();
    // @ts-expect-error
    expect(sanitizeImageSrc(null)).toEqual({ src: null, strippedQuery: false });
  });
});
