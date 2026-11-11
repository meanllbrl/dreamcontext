/**
 * The floating Agenda (and every card, sheet and the centre) never covers the Super bar
 * (sahip-karti-yerinde K7, end review r1c). A card row on the bar WRAPS to draw its whole command,
 * so the bar is taller than one line; the stage plans under the bar's ACTUAL bottom, which the bar
 * measures and publishes (JobBar → superJobsStore → SuperSurface → planStage `queueHeight`),
 * never under a one-line constant. Measured live at 390 px: a 99 px card row under a sheet that
 * started at the old 40 px band.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { STAGE, planStage, type StageItem } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { _resetOwnerSlots, publishQueueHeight, useQueueHeight } from '../../dashboard/src/components/sleepy/super/superJobsStore.js';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const AGENDA = { id: 'ag', kind: 'agenda', ref: 'ag', place: 'float', shape: 'square' } as StageItem;
const PHONE = { width: 390, height: 757 };
const src = (p: string) => readFileSync(new URL(`../../dashboard/src/components/sleepy/super/${p}`, import.meta.url), 'utf-8');

beforeEach(() => _resetOwnerSlots());

describe('the stage plans below the bar\'s measured bottom', () => {
  for (const rowHeight of [40, 64, 99, 160]) {
    it(`an Agenda sheet at 390 px starts below a ${rowHeight} px bar`, () => {
      const p = planStage([AGENDA], { mode: 'half', card: 'ag' }, PHONE, { queueUp: true, queueHeight: rowHeight });
      const sheet = p.cards.ag.rect;
      const barBottom = p.queue.y + rowHeight;
      expect(sheet.y).toBeGreaterThanOrEqual(barBottom);
      expect(p.centre.y).toBeGreaterThanOrEqual(barBottom);
    });
  }

  it('a phone float stage keeps its chat below the measured bar too', () => {
    const p = planStage([], { mode: 'float' }, PHONE, { queueUp: true, queueHeight: 99 });
    expect(p.centre.y).toBeGreaterThanOrEqual(STAGE.PHONE_BAND_INSET + 99);
  });

  it('a wide stage keeps its centre and cards below a tall bar', () => {
    const p = planStage([AGENDA], { mode: 'half', card: 'ag' }, { width: 1440, height: 900 }, { queueUp: true, queueHeight: 120 });
    expect(p.cards.ag.rect.y).toBeGreaterThanOrEqual(p.queue.y + 120);
    expect(p.centre.y).toBeGreaterThanOrEqual(p.queue.y + 120);
  });

  it('a one-line bar, or no measure yet, plans exactly as before (the band)', () => {
    const before = planStage([AGENDA], { mode: 'half', card: 'ag' }, PHONE, { queueUp: true });
    const short = planStage([AGENDA], { mode: 'half', card: 'ag' }, PHONE, { queueUp: true, queueHeight: 20 });
    expect(JSON.stringify(short)).toBe(JSON.stringify(before));
  });

  it('the height is read from the bar, never a constant: JobBar measures and publishes it, SuperSurface plans with it', () => {
    const bar = src('JobBar.tsx');
    expect(bar).toMatch(/new ResizeObserver\(measure\)/);
    expect(bar).toMatch(/publishQueueHeight\(barSession, el\.getBoundingClientRect\(\)\.height \+ Math\.max\(0, pad\)\)/);
    const surface = src('SuperSurface.tsx');
    expect(surface).toMatch(/const queueHeight = useQueueHeight\(state\.session\);/);
    // Both plans the window draws with take it: the stage, and the "can this size fit" check.
    expect(surface.match(/queueUp, queueHeight, narrowPx, centreMin, recent/g)?.length).toBe(2);
  });

  it('the store hands the stage the newest measure, and 0 once the bar draws nothing', () => {
    const Probe = () => createElement('i', null, String(useQueueHeight('S')));
    publishQueueHeight('S', 98.4);
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<i>99</i>');
    publishQueueHeight('S', 0);
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<i>0</i>');
  });
});
