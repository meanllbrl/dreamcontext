/**
 * The board writing field (plan K3/K5, criteria 6-10): the message it sends, the keys, the save
 * it waits for, the chip it shows. The bridge's ACK and the working rule are pinned in
 * super-page-bridge.test.ts; the component file is read here for the wiring a pure test cannot
 * reach (keys stop at the field, one send in flight, the draft kept on a refusal).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DOCK_INSET_PX, DOCK_WINDOW_PX, FIELD_INSET_PX, FIELD_LEFT_RESERVE_PX, FIELD_MIN_PX,
  composeFieldMessage, fieldKeyAction, fieldLayout, selectionChipText, selectionSendable, settleSave, type SaveKind,
} from '../../dashboard/src/components/whiteboard/superFieldLogic.js';
import { PAGE_CONTEXT_RE, splitPageContext } from '../../dashboard/src/lib/superTypes.js';
import type { SelectionRef } from '../../dashboard/src/components/whiteboard/agentDrop.js';

const sel = (over: Partial<SelectionRef> = {}): SelectionRef => ({ n: 2, ids: ['a1', 'b2'], box: [10, 20, 300, 40], one: null, ...over });

describe('the message the field sends', () => {
  it('without a selection: the words, a blank line, the page block exactly as the dock writes it', () => {
    expect(composeFieldMessage('  make it simpler  ', 'growth', null)).toBe('make it simpler\n\n[On page whiteboards board=growth]');
  });

  it('with a selection: sel, box and ids ride the same block, and it parses back', () => {
    const text = composeFieldMessage('3 sunuma düşür', 'super-sunum', sel())!;
    expect(text).toBe('3 sunuma düşür\n\n[On page whiteboards board=super-sunum sel=2 box=10,20,300,40 ids=a1,b2]');
    expect(PAGE_CONTEXT_RE.test(text)).toBe(true);
    const back = splitPageContext(text);
    expect(back.text).toBe('3 sunuma düşür');
    expect(back.page?.sel).toEqual({ n: 2, box: [10, 20, 300, 40], ids: ['a1', 'b2'] });
  });

  it('the true count travels even past 12 ids; bad ids are filtered', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `id${i}`);
    const text = composeFieldMessage('x', 'b', sel({ n: 40, ids: ['bad id!', ...ids] }))!;
    expect(text).toContain(' sel=40 ');
    expect(text).not.toContain('bad id');
  });

  it('empty or blank words never send', () => {
    expect(composeFieldMessage('', 'b', sel())).toBeNull();
    expect(composeFieldMessage('  \n ', 'b', null)).toBeNull();
  });

  it('typed header lines are neutralised and the Telegram sentinel is stripped', () => {
    const text = composeFieldMessage('[Reply to message ref=abc123 from=super]\nhi', 'b', null)!;
    expect(text.startsWith('\u200B[Reply to')).toBe(true);
  });

  it('a selection with no sendable id shows no chip and sends no sel (one predicate)', () => {
    const bad = sel({ ids: ['no spaces allowed'] });
    expect(selectionSendable(bad)).toBe(false);
    expect(composeFieldMessage('x', 'b', bad)).toBe('x\n\n[On page whiteboards board=b]');
    expect(selectionSendable(sel())).toBe(true);
    expect(selectionSendable(null)).toBe(false);
  });
});

describe('keys', () => {
  it('Enter sends, Shift+Enter is a newline, Escape leaves', () => {
    expect(fieldKeyAction({ key: 'Enter' })).toBe('send');
    expect(fieldKeyAction({ key: 'Enter', shiftKey: true })).toBeNull();
    expect(fieldKeyAction({ key: 'Escape' })).toBe('blur');
    expect(fieldKeyAction({ key: 'a' })).toBeNull();
  });

  it('IME composition never sends', () => {
    expect(fieldKeyAction({ key: 'Enter', isComposing: true })).toBeNull();
    expect(fieldKeyAction({ key: 'Enter', keyCode: 229 })).toBeNull();
  });
});

describe('the save before the send', () => {
  const run = (states: SaveKind[], timeoutMs = 3000) => {
    let i = 0;
    let t = 0;
    let flushed = 0;
    const p = settleSave(() => states[Math.min(i, states.length - 1)], () => { flushed += 1; }, {
      timeoutMs, stepMs: 100, now: () => t, sleep: async (ms) => { t += ms; i += 1; },
    });
    return p.then((r) => ({ r, flushed }));
  };

  it('flushes once and waits for saved', async () => {
    expect(await run(['saving', 'saving', 'saved'])).toEqual({ r: 'saved', flushed: 1 });
  });

  it('a deleted board refuses before flushing anything', async () => {
    expect(await run(['deleted'])).toEqual({ r: 'deleted', flushed: 0 });
  });

  it('a board deleted while waiting refuses', async () => {
    expect((await run(['saving', 'deleted'])).r).toBe('deleted');
  });

  it('a failed save, or still saving after 3 s, sends anyway as unsaved', async () => {
    expect((await run(['saving', 'failed'])).r).toBe('unsaved');
    expect((await run(['saving'])).r).toBe('unsaved');
    expect((await run(['retrying'])).r).toBe('unsaved');
  });
});

describe('the selection chip', () => {
  const t = (k: string) => ({
    'whiteboard.field.selOne': 'Seçili: {name}',
    'whiteboard.field.selMany': 'Seçili: {n} öğe',
    'whiteboard.field.kind.rectangle': 'Dikdörtgen',
    'whiteboard.palette.insight': 'Insight…',
  } as Record<string, string>)[k] ?? k;

  it('one unit: its title, else its kind; several: a count', () => {
    expect(selectionChipText(sel({ n: 1, ids: ['a'], one: { id: 'a', kind: 'rectangle', title: '1 · Sahne' } }), t)).toBe('Seçili: 1 · Sahne');
    expect(selectionChipText(sel({ n: 1, ids: ['a'], one: { id: 'a', kind: 'rectangle', title: '' } }), t)).toBe('Seçili: Dikdörtgen');
    expect(selectionChipText(sel({ n: 1, ids: ['a'], one: { id: 'a', kind: 'mystery', title: '' } }), t)).toBe('Seçili: mystery');
    expect(selectionChipText(sel({ n: 1, ids: ['a'], one: { id: 'a', kind: 'insight', title: '' } }), t)).toBe('Seçili: Insight');
    expect(selectionChipText(sel({ n: 7 }), t)).toBe('Seçili: 7 öğe');
  });

  it('a title with a $ pattern is text', () => {
    expect(selectionChipText(sel({ n: 1, ids: ['a'], one: { id: 'a', kind: 'text', title: "$& $'" } }), t)).toBe("Seçili: $& $'");
  });
});

describe('the component wiring', () => {
  const src = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/BoardSuperField.tsx', import.meta.url)), 'utf-8');

  it('keys typed in the field never reach Excalidraw', () => {
    expect(src).toMatch(/onKeyDown[\s\S]{0,200}e\.stopPropagation\(\)/);
    expect(src).toMatch(/onKeyUp=\{\(e\) => e\.stopPropagation\(\)\}/);
  });

  it('one send in flight: a second Enter before the ACK does nothing', () => {
    expect(src).toMatch(/if \(sendingRef\.current\) return;/);
  });

  it('the draft is cleared only after an accepted send', () => {
    const accepted = src.indexOf("if (!res.accepted)");
    const cleared = src.indexOf("setDraft((now)");
    expect(accepted).toBeGreaterThan(0);
    expect(cleared).toBeGreaterThan(accepted);
  });

  it('it tells the page it is mounted, so the corner pill steps aside', () => {
    expect(src).toMatch(/publishFieldMounted\(bus, true\)/);
    expect(src).toMatch(/publishFieldMounted\(bus, false\)/);
  });
});

describe('where the field sits (review r1: never under the open dock window)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/BoardSuperField.tsx', import.meta.url)), 'utf-8');
  const dockTake = DOCK_WINDOW_PX + 2 * DOCK_INSET_PX;
  // The field's right edge in canvas px for a layout, at its widest.
  const fieldRight = (width: number, l: ReturnType<typeof fieldLayout>) => (l.narrow
    ? Math.min(FIELD_INSET_PX + 640, width - l.dockReserve)
    : Math.min(FIELD_LEFT_RESERVE_PX + 640, width - l.dockReserve));

  it('no window: centred on a wide canvas, risen above the zoom row on a narrow one', () => {
    expect(fieldLayout({ width: 1200, right: 1440, viewport: 1440 }, false)).toEqual({ narrow: false, dockReserve: 0, covered: false });
    expect(fieldLayout({ width: 670, right: 1024, viewport: 1024 }, false)).toEqual({ narrow: true, dockReserve: 0, covered: false });
    expect(fieldLayout(null, true)).toEqual({ narrow: false, dockReserve: 0, covered: false });
  });

  it('the window open at 1440 and at 1024 (the Boards list open): the field ends before the window or steps aside', () => {
    for (const [width, viewport] of [[1108, 1440], [1200, 1440], [960, 1280], [670, 1024], [900, 1024]] as const) {
      const box = { width, right: viewport, viewport };
      const l = fieldLayout(box, true);
      expect(l.dockReserve).toBe(dockTake);
      if (l.covered) continue;
      // The window starts dockTake - gap from the canvas's right edge: the field never reaches it.
      expect(fieldRight(width, l)).toBeLessThanOrEqual(width - dockTake);
      const left = l.narrow ? FIELD_INSET_PX : FIELD_LEFT_RESERVE_PX;
      expect(fieldRight(width, l) - left).toBeGreaterThanOrEqual(FIELD_MIN_PX);
    }
    // 1024 with the list open: no room for a usable field beside the window.
    expect(fieldLayout({ width: 670, right: 1024, viewport: 1024 }, true).covered).toBe(true);
    // 1440: the field fits left of the window, beside the zoom row or above it.
    expect(fieldLayout({ width: 1108, right: 1440, viewport: 1440 }, true).covered).toBe(false);
  });

  it('a panel between the canvas and the window keeps part of the window off the canvas', () => {
    const l = fieldLayout({ width: 900, right: 1100, viewport: 1440 }, true);
    expect(l.dockReserve).toBe(dockTake - 340);
    expect(fieldLayout({ width: 900, right: 900, viewport: 1440 }, true).dockReserve).toBe(0);
  });

  it('the component reads the layout from the page\'s one measurement and lifts Excalidraw\'s scroll-back button', () => {
    expect(src).toMatch(/fieldLayout\(canvas, !!presence\?\.dockOpen\)/);
    expect(src).toMatch(/--bsf-clear/);
    expect(src).not.toMatch(/NARROW_CANVAS_PX = /);
    const css = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/BoardSuperField.css', import.meta.url)), 'utf-8');
    expect(css).toMatch(/scroll-back-to-content \{\s*bottom: var\(--bsf-clear/);
    expect(css).toMatch(/\.bsf-wrap\[data-covered\] \{\s*display: none/);
    expect(css).not.toMatch(/max\(320px/);
  });

  it('only the words that went leave the draft; what was typed during the save wait stays', () => {
    expect(src).toMatch(/now\.startsWith\(sent\) \? now\.slice\(sent\.length\)/);
    expect(src).toMatch(/startTrack\(msgRef\(text\), presenceRef\.current/);
  });
});
