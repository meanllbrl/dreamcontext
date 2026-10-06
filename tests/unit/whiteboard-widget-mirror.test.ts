import { describe, it, expect, expectTypeOf } from 'vitest';
import * as lib from '../../src/lib/whiteboards/widgets.js';
import * as dash from '../../dashboard/src/lib/whiteboardWidgets.js';

/**
 * Mirror-with-drift test: `src/lib/whiteboards/widgets.ts` (CLI/server) and
 * `dashboard/src/lib/whiteboardWidgets.ts` (canvas) are separate build roots that must agree
 * on the widget contract. The exported names are exactly WIDGET_KINDS, WIDGET_LINK_PREFIX,
 * type WidgetPayload and (A17) WIDGET_SIZES, WIDGET_GRID, type WidgetSize, DEFAULT_WIDGET_SIZES.
 */
describe('whiteboard widget contract mirror', () => {
  it('WIDGET_KINDS match, in order', () => {
    expect([...dash.WIDGET_KINDS]).toEqual([...lib.WIDGET_KINDS]);
    expect([...lib.WIDGET_KINDS]).toEqual(['insight', 'knowledge', 'task', 'todo', 'note', 'html', 'web', 'wiki', 'lab-card', 'agent']);
  });

  it('WIDGET_LINK_PREFIX matches', () => {
    expect(dash.WIDGET_LINK_PREFIX).toBe(lib.WIDGET_LINK_PREFIX);
    expect(lib.WIDGET_LINK_PREFIX).toBe('dreamcontext://');
  });

  it('WidgetPayload is the same shape both ways', () => {
    expectTypeOf<dash.WidgetPayload>().toEqualTypeOf<lib.WidgetPayload>();
    // A wiki card's list: sections of pages.
    expectTypeOf<dash.WikiSection>().toEqualTypeOf<lib.WikiSection>();
    expectTypeOf<dash.WikiPage>().toEqualTypeOf<lib.WikiPage>();
    expectTypeOf<lib.WidgetPayload['sections']>().toEqualTypeOf<lib.WikiSection[] | undefined>();
  });

  it('WIDGET_SIZES and WIDGET_GRID match, and are the A17 contract', () => {
    expect(dash.WIDGET_SIZES).toEqual(lib.WIDGET_SIZES);
    expect(dash.WIDGET_GRID).toEqual(lib.WIDGET_GRID);
    expect(lib.WIDGET_SIZES).toEqual({ s: [180, 180], m: [376, 180], l: [376, 376], xl: [768, 376] });
    expect(lib.WIDGET_GRID).toEqual({ cell: 180, gap: 16 });
    // Every preset spans whole cells: n*cell + (n-1)*gap.
    const { cell, gap } = lib.WIDGET_GRID;
    for (const [w, h] of Object.values(lib.WIDGET_SIZES)) {
      expect(Number.isInteger((w + gap) / (cell + gap)) && Number.isInteger((h + gap) / (cell + gap))).toBe(true);
    }
    expectTypeOf<dash.WidgetSize>().toEqualTypeOf<lib.WidgetSize>();
  });

  it('CARD_COLORS match and are the tab-group names', () => {
    expect([...dash.CARD_COLORS]).toEqual([...lib.CARD_COLORS]);
    expect([...lib.CARD_COLORS]).toEqual(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan']);
    for (const c of [...lib.CARD_COLORS, 'orange', '', 3, null]) expect(dash.isCardColor(c)).toBe(lib.isCardColor(c));
    expectTypeOf<dash.CardColor>().toEqualTypeOf<lib.CardColor>();
  });

  it('page refs (slug | project-relative .md/.pdf/.html path) are judged the same both ways', () => {
    expect([...dash.PAGE_FILE_EXTENSIONS]).toEqual([...lib.PAGE_FILE_EXTENSIONS]);
    const cases: unknown[] = [
      'architecture/overview', 'docs/spec.pdf', 'site/index.html', 'site/old.HTM', 'Notes/Ürün Planı.md',
      '_dream_context/knowledge/a.md', '../secret.md', '/etc/passwd.md', '~/x.md', 'a/../b.md', 'a//b.md',
      './a.md', 'C:/x.md', 'a\\b.md', 'docs/x.txt', 'docs/x', '', 42, null, 'a\nb.md',
    ];
    for (const c of cases) {
      expect(dash.pageRefKind(c), String(c)).toBe(lib.pageRefKind(c));
      expect(dash.isValidPageRef(c), String(c)).toBe(lib.isValidPageRef(c));
    }
    expect(lib.pageRefKind('architecture/overview')).toBe('knowledge');
    expect(lib.pageRefKind('docs/spec.pdf')).toBe('pdf');
    expect(lib.pageRefKind('site/old.HTM')).toBe('html');
    expect(lib.pageRefKind('Notes/Ürün Planı.md')).toBe('md');
    for (const bad of ['../secret.md', '/etc/passwd.md', '~/x.md', 'a/../b.md', 'C:/x.md', 'docs/x.txt']) {
      expect(lib.isValidPageRef(bad), bad).toBe(false);
    }
  });

  it('per-kind default sizes match', () => {
    expect(dash.DEFAULT_WIDGET_SIZES).toEqual(lib.DEFAULT_WIDGET_SIZES);
    expect(lib.DEFAULT_WIDGET_SIZES).toEqual({ insight: 'm', knowledge: 's', task: 's', todo: 'm', note: 'm', html: 'l', web: 'l', wiki: 'l', 'lab-card': 'xl', agent: 'l' });
  });
});
