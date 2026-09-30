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
    expect([...lib.WIDGET_KINDS]).toEqual(['insight', 'knowledge', 'task', 'todo', 'note', 'html', 'web']);
  });

  it('WIDGET_LINK_PREFIX matches', () => {
    expect(dash.WIDGET_LINK_PREFIX).toBe(lib.WIDGET_LINK_PREFIX);
    expect(lib.WIDGET_LINK_PREFIX).toBe('dreamcontext://');
  });

  it('WidgetPayload is the same shape both ways', () => {
    expectTypeOf<dash.WidgetPayload>().toEqualTypeOf<lib.WidgetPayload>();
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

  it('per-kind default sizes match', () => {
    expect(dash.DEFAULT_WIDGET_SIZES).toEqual(lib.DEFAULT_WIDGET_SIZES);
    expect(lib.DEFAULT_WIDGET_SIZES).toEqual({ insight: 'm', knowledge: 's', task: 's', todo: 'm', note: 'm', html: 'l', web: 'l' });
  });
});
