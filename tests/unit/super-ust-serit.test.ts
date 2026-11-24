/**
 * The top band: a member's question bar and a presentation's tab row never share one row
 * (owner 2026-11-18: the group chip and the "next" tab painted over the question's text).
 */
import { describe, it, expect } from 'vitest';
import type * as client from '../../dashboard/src/lib/superTypes.js';
import { STAGE, planStage } from '../../dashboard/src/components/sleepy/super/superLayout.js';

const card = (id: string): client.SuperContainer => ({ id, kind: 'insight', ref: `ref-${id}`, shape: 'square', place: 'float' });
const items = [card('a'), card('b'), card('c')];
const present: client.SuperView = { mode: 'present', cards: ['a', 'b'] };

describe('a question bar over a presentation', () => {
  for (const width of [800, 1024, 1384]) {
    it(`${width}: the tabs and icons stand under the bar, the stage under them`, () => {
      const bar = 44;
      const p = planStage(items, present, { width, height: 814 }, { layoutChoices: 3, queueBand: 'step', queueUp: true, queueHeight: bar });
      const bandBottom = STAGE.MARGIN / 2 + bar;
      // A narrow stage (dar-ekran-super, 2026-11-23) has ONE row of tabs, in `tabs`; a wide one the presentation's own row.
      const row = p.presentTabs ?? p.tabs!.rect;
      expect(row.y).toBeGreaterThanOrEqual(bandBottom);
      expect(p.controls!.y).toBeGreaterThanOrEqual(bandBottom);
      expect(p.queue.y + p.queue.height).toBeLessThanOrEqual(row.y);
      for (const c of Object.values(p.cards)) if (c.where !== 'others' && !c.hidden) expect(c.rect.y).toBeGreaterThanOrEqual(row.y + row.height);
    });
  }

  it('no bar drawn (no measured height): the row stays in the band as before', () => {
    const p = planStage(items, present, { width: 1384, height: 814 }, { layoutChoices: 3, queueUp: true });
    expect(p.presentTabs!.y).toBe(STAGE.MARGIN / 2);
  });
});
