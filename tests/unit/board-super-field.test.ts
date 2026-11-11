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
  composeFieldMessage, dockReserveOf, fieldKeyAction, fieldLayout, selectionChipText, selectionSendable, settleSave, type SaveKind,
} from '../../dashboard/src/components/whiteboard/superFieldLogic.js';
import { PAGE_CONTEXT_RE, splitPageContext } from '../../dashboard/src/lib/superTypes.js';
import type { SelectionRef } from '../../dashboard/src/components/whiteboard/agentDrop.js';
import { nextNeed, rowOverflow } from '../../dashboard/src/pages/whiteboards/useTopRowFit.js';

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

describe('where the field sits (review r1/r2: one rule decides the painted box)', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf-8');
  const src = read('dashboard/src/components/whiteboard/BoardSuperField.tsx');
  const css = read('dashboard/src/components/whiteboard/BoardSuperField.css');
  // Excalidraw's zoom + undo group: bottom-left, 36 px tall at the 20 px inset, ≈ 252 px wide.
  const zoom = { left: 0, right: FIELD_LEFT_RESERVE_PX - 20, top: FIELD_INSET_PX + 36 };

  it('every canvas width 300-1700, window open or closed, panel or not: inside the canvas, clear of the window and the zoom row, 280-640 px or stepped aside', () => {
    let checked = 0;
    for (let width = 300; width <= 1700; width++) {
      for (const gapRight of [0, 340]) {
        const box = { width, right: 1800 - gapRight, viewport: 1800 };
        for (const dock of [false, true]) {
          const l = fieldLayout(box, dock);
          if (l.covered) {
            // Only when there is truly no room for a usable field.
            const reserve = dockReserveOf(box, dock);
            expect(width - FIELD_INSET_PX - reserve, `w=${width} dock=${dock}`).toBeLessThan(FIELD_MIN_PX + (reserve ? 0 : FIELD_INSET_PX));
            continue;
          }
          checked++;
          const right = l.left + l.width;
          expect(l.width, `w=${width}`).toBeGreaterThanOrEqual(FIELD_MIN_PX);
          expect(l.width).toBeLessThanOrEqual(640);
          expect(l.left).toBeGreaterThanOrEqual(0);
          expect(right).toBeLessThanOrEqual(width);
          // Never under the window: the window (and its gap) starts `reserve` px from the right.
          expect(right, `w=${width} dock=${dock} gap=${gapRight}`).toBeLessThanOrEqual(width - dockReserveOf(box, dock));
          // Never on the zoom/undo group: beside it, or risen above it.
          expect(l.left >= zoom.right || l.bottom >= zoom.top, `w=${width}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(4000);
  });

  it('the cases the reviews named', () => {
    // 1366 with the Boards list open (canvas ≈ 1012-1031): beside the window, never under it.
    for (const width of [1012, 1020, 1031]) {
      const l = fieldLayout({ width, right: 1366, viewport: 1366 }, true);
      expect(l.covered).toBe(false);
      expect(l.left + l.width).toBeLessThanOrEqual(width - (DOCK_WINDOW_PX + 2 * DOCK_INSET_PX));
    }
    // 1024 with the list open: no room for a usable field beside the window, it steps aside.
    expect(fieldLayout({ width: 670, right: 1024, viewport: 1024 }, true).covered).toBe(true);
    // Not measured yet: not drawn.
    expect(fieldLayout(null, false).covered).toBe(true);
    // No window: centred on a wide canvas, risen on a narrow one.
    expect(fieldLayout({ width: 1200, right: 1440, viewport: 1440 }, false)).toEqual({ left: 280, bottom: 20, width: 640, narrow: false, covered: false });
    expect(fieldLayout({ width: 670, right: 1024, viewport: 1024 }, false)).toEqual({ left: 20, bottom: 68, width: 630, narrow: true, covered: false });
  });

  it('a panel between the canvas and the window keeps part of the window off the canvas', () => {
    expect(dockReserveOf({ width: 900, right: 1100, viewport: 1440 }, true)).toBe(DOCK_WINDOW_PX + 2 * DOCK_INSET_PX - 340);
    expect(dockReserveOf({ width: 900, right: 900, viewport: 1440 }, true)).toBe(0);
    expect(dockReserveOf({ width: 900, right: 1440, viewport: 1440 }, false)).toBe(0);
  });

  it('the dock window width is the one SuperDock.css draws (drift)', () => {
    expect(read('dashboard/src/components/sleepy/super/SuperDock.css')).toMatch(new RegExp(`--super-dock-width: ${DOCK_WINDOW_PX}px;`));
  });

  it('the painted box is the rule\'s box: applied inline, and the CSS has no geometry of its own', () => {
    expect(src).toMatch(/style=\{\{ left: layout\.left, bottom: layout\.bottom, width: layout\.width \}\}/);
    const wrap = css.slice(css.indexOf('.bsf-wrap {'), css.indexOf('}', css.indexOf('.bsf-wrap {')));
    expect(wrap).not.toMatch(/\b(width|min-width|left|right|bottom|transform)\s*:/);
    expect(css).not.toMatch(/\.bsf-wrap\[data-(narrow|dock-open)\]/);
    expect(css).toMatch(/\.bsf-wrap\[data-covered\] \{\s*display: none/);
  });

  it('every page overlay paints in one layer under Excalidraw\'s UI (text editing 3, layer UI 4, sidebars 5)', () => {
    const page = read('dashboard/src/pages/WhiteboardsPage.css');
    expect(page).toMatch(/--wbp-overlay-z: 2;/);
    for (const sel of ['.wbp-float-left', '.wbp-float-right']) {
      const i = page.indexOf(`${sel} {`);
      expect(page.slice(i, page.indexOf('}', i))).toMatch(/z-index: var\(--wbp-overlay-z\);/);
    }
    expect(css).toMatch(/\.bsf-wrap \{[^}]*z-index: var\(--wbp-overlay-z, 2\);/);
    expect(css).toMatch(/\.wb-work-outline \{[^}]*z-index: var\(--wbp-overlay-z, 2\);/);
  });

  it('Excalidraw\'s top-row first cell keeps to its menu button at every width, so it never lies over the Boards toggle (review r3)', () => {
    const page = read('dashboard/src/pages/WhiteboardsPage.css');
    expect(page).toMatch(/\.wbp-canvas \.excalidraw \.App-menu_top > \*:first-child \{\s*justify-self: flex-start;/);
  });

  it('in Excalidraw\'s phone layout the page overlays move under its toolbar and left of its tools column', () => {
    const page = read('dashboard/src/pages/WhiteboardsPage.css');
    expect(page).toMatch(/\.wbp-canvas:has\(\.excalidraw--mobile\) \.wbp-float-left \{\s*top: calc\(var\(--space-4\) \+ var\(--space-12\)\);/);
    expect(page).toMatch(/\.wbp-canvas:has\(\.excalidraw--mobile\) \.wbp-float-right \{[^}]*right: calc\(var\(--space-4\) \+ var\(--space-12\)\);/);
  });

  it('Excalidraw\'s scroll-back button is lifted above the field', () => {
    expect(src).toMatch(/--bsf-clear/);
    expect(css).toMatch(/\.wbp-canvas \.excalidraw \.scroll-back-to-content \{\s*bottom: var\(--bsf-clear/);
  });

  it('a send settles read-only, so the draft is exactly what went; the track knows a steered turn', () => {
    expect(src).toMatch(/readOnly=\{sending\}/);
    expect(src).toMatch(/setDraft\(\(now\) => \(now === sent \? '' : now\)\)/);
    expect(src).toMatch(/startTrack\(msgRef\(text\), presenceRef\.current/);
  });
});

describe('the page controls in Excalidraw\'s top row (review r2: one place decides)', () => {
  it('a spill past the canvas edge (with its 4 px room) reads as overflow; a fit does not', () => {
    expect(rowOverflow([600, 700, 990], 1000)).toBe(-6);
    expect(rowOverflow([600, 700, 997], 1000)).toBe(1);
    expect(rowOverflow([], 1000)).toBeLessThan(0);
  });

  it('the need only rises on a spill, and never below what was measured', () => {
    expect(nextNeed(0, 670, 30.2)).toBe(701);
    expect(nextNeed(900, 670, 30)).toBe(900);
    expect(nextNeed(701, 900, -5)).toBe(701);
  });

  it('the hook watches the row and each control in it, re-measures on any change, and tries again on a language switch', () => {
    const hook = readFileSync(fileURLToPath(new URL('../../dashboard/src/pages/whiteboards/useTopRowFit.ts', import.meta.url)), 'utf-8');
    expect(hook).toMatch(/ro\.observe\(row\);/);
    expect(hook).toMatch(/for \(const c of Array\.from\(row\.children\)\) ro\.observe\(c\);/);
    expect(hook).toMatch(/new MutationObserver/);
    expect(hook).toMatch(/useEffect\(\(\) => \{ setNeed\(0\); \}, \[locale\]\);/);
    const page = readFileSync(fileURLToPath(new URL('../../dashboard/src/pages/WhiteboardsPage.tsx', import.meta.url)), 'utf-8');
    expect(page).toMatch(/useTopRowFit\(toggleEl, canvasBox, locale\)/);
    expect(page).toMatch(/topRight=\{controlsAside \? null : controls\}/);
  });
});
