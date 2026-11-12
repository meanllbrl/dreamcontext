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
import {
  CLICK_SLOP_PX, FIELD_MODE_KEY, QUICK_SCOPE_MAX, REGION_MIN_PX, addedIds, areaOf, dragOutcome, effectiveMode, failKey, lineOfJob, undoRefusalKey,
  quickEditScope, readFieldMode, regionChipText, startRefusalKey, writeFieldMode, type ScopeElement,
} from '../../dashboard/src/components/whiteboard/quickEditLogic.js';

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
    const cleared = src.indexOf("if (!ask) setDraft((cur)");
    expect(accepted).toBeGreaterThan(0);
    expect(cleared).toBeGreaterThan(accepted);
    // The quick edit clears it only after the server took the job.
    const quickTaken = src.indexOf('job = r.job;');
    expect(src.indexOf("setDraft((cur) => (cur.trim() === words ? '' : cur))")).toBeGreaterThan(quickTaken);
    expect(quickTaken).toBeGreaterThan(src.indexOf('if (!r.ok) {'));
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
    expect(src).toMatch(/if \(!ask\) setDraft\(\(cur\) => \(cur === sent \? '' : cur\)\)/);
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

// ── Hızlı düzenle (task tahta-hizli-duzenle, plan r4) ──────────────────────────────────────────

const tq = (k: string) => ({
  'whiteboard.quick.regionChip': 'Alan · {w}×{h}',
  'whiteboard.quick.failed': 'Düzenleme yapılamadı',
  'whiteboard.quick.notBoard': 'Tahta değişikliği değil',
  'whiteboard.quick.outOfScope': 'Önce seç',
  'whiteboard.quick.doneDefault': 'Güncellendi',
} as Record<string, string>)[k] ?? k;

describe('the mode switch (Decision 1, 2; criteria 1, 17)', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m }; };

  it('Hızlı düzenle is the default; the last pick is remembered per machine', () => {
    const store = mem();
    expect(readFieldMode(store)).toBe('quick');
    expect(readFieldMode(null)).toBe('quick');
    writeFieldMode(store, 'super');
    expect(store.m.get(FIELD_MODE_KEY)).toBe('super');
    expect(readFieldMode(store)).toBe('super');
    writeFieldMode(store, 'quick');
    expect(readFieldMode(store)).toBe('quick');
    // A store that throws (private mode) never breaks the field.
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readFieldMode(broken)).toBe('quick');
    expect(() => writeFieldMode(broken, 'super')).not.toThrow();
  });

  it('a mode that cannot run falls to the other one; with neither, the pick stands (send disabled with the reason)', () => {
    expect(effectiveMode('super', false, true)).toBe('quick');
    expect(effectiveMode('quick', true, false)).toBe('super');
    expect(effectiveMode('quick', true, true)).toBe('quick');
    expect(effectiveMode('super', true, true)).toBe('super');
    expect(effectiveMode('quick', false, false)).toBe('quick');
  });

  it('the field mounts whatever Super\'s state, and says why a segment is off', () => {
    const page = readFileSync(fileURLToPath(new URL('../../dashboard/src/pages/WhiteboardsPage.tsx', import.meta.url)), 'utf-8');
    expect(page).not.toMatch(/presence\?\.on && \(\s*<BoardSuperField/);
    const src = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/BoardSuperField.tsx', import.meta.url)), 'utf-8');
    expect(src).toMatch(/disabled=\{!superOn\}/);
    expect(src).toMatch(/t\('whiteboard\.quick\.superOff'\)/);
    expect(src).toMatch(/disabled=\{!quickOk\}/);
  });
});

describe('the empty region (Decision 12; criterion 2)', () => {
  const base = { origin: { x: 100, y: 100 }, zoom: 1, tool: 'selection', selectedCount: 0, hitElement: false };

  it('a drag of at least 24×24 screen px with nothing selected becomes the region, normalised and rounded', () => {
    expect(dragOutcome({ ...base, end: { x: 310.4, y: 290.6 } })).toEqual({ kind: 'region', region: [100, 100, 210, 191] });
    // Dragged up and left: same box.
    expect(dragOutcome({ ...base, origin: { x: 310, y: 290 }, end: { x: 100, y: 100 } })).toEqual({ kind: 'region', region: [100, 100, 210, 190] });
  });

  it('the size floor is in SCREEN px: zoom counts', () => {
    expect(dragOutcome({ ...base, end: { x: 100 + REGION_MIN_PX - 1, y: 200 } }).kind).toBe('none');
    expect(dragOutcome({ ...base, end: { x: 100 + REGION_MIN_PX, y: 100 + REGION_MIN_PX } }).kind).toBe('region');
    // At 50% zoom a 40-scene-px drag is 20 screen px: too small.
    expect(dragOutcome({ ...base, zoom: 0.5, end: { x: 140, y: 140 } }).kind).toBe('none');
    expect(dragOutcome({ ...base, zoom: 2, end: { x: 113, y: 113 } }).kind).toBe('region');
  });

  it('a drag that selects shapes, starts on a shape, or uses another tool stays what it is today', () => {
    expect(dragOutcome({ ...base, selectedCount: 2, end: { x: 400, y: 400 } }).kind).toBe('none');
    expect(dragOutcome({ ...base, hitElement: true, end: { x: 400, y: 400 } }).kind).toBe('none');
    expect(dragOutcome({ ...base, tool: 'rectangle', end: { x: 400, y: 400 } }).kind).toBe('none');
  });

  it('a plain click on the canvas clears it', () => {
    expect(dragOutcome({ ...base, end: { x: 100 + CLICK_SLOP_PX - 1, y: 101 } })).toEqual({ kind: 'click' });
  });

  it('the chip reads Alan · W×H; the request area is {x,y,w,h} held to 8..20000', () => {
    expect(regionChipText([10, 20, 210, 190], tq)).toBe('Alan · 210×190');
    expect(areaOf([10, 20, 210, 190])).toEqual({ x: 10, y: 20, w: 210, h: 190 });
    expect(areaOf([0, 0, 3, 50000])).toEqual({ x: 0, y: 0, w: 8, h: 20000 });
    expect(areaOf(null)).toBeNull();
  });

  it('both modes carry it: the Super message ends with area= after sel=, and parses back', () => {
    const text = composeFieldMessage('C ile D\'yi karşılaştır', 'super-sunum', sel(), [40, -80, 320, 240])!;
    expect(text).toBe('C ile D\'yi karşılaştır\n\n[On page whiteboards board=super-sunum sel=2 box=10,20,300,40 ids=a1,b2 area=40,-80,320,240]');
    expect(splitPageContext(text).page?.area).toEqual([40, -80, 320, 240]);
    expect(composeFieldMessage('buraya elma', 'q3', null, [1, 2, 30, 40])).toBe('buraya elma\n\n[On page whiteboards board=q3 area=1,2,30,40]');
    const src = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/BoardSuperField.tsx', import.meta.url)), 'utf-8');
    expect(src).toMatch(/quick\.start\(\{ text: words, scope, area: areaOf\(area\) \}\)/);
  });

  it('Escape, a shape selection and another board clear it; the canvas never saves it', () => {
    const canvas = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/WhiteboardCanvas.tsx', import.meta.url)), 'utf-8');
    expect(canvas).toMatch(/if \(ids\.length && regionRef\.current\) onRegionRef\.current\?\.\(null\);/);
    const outline = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/RegionOutline.tsx', import.meta.url)), 'utf-8');
    expect(outline).toMatch(/if \(e\.key !== 'Escape'\) return;/);
    const page = readFileSync(fileURLToPath(new URL('../../dashboard/src/pages/WhiteboardsPage.tsx', import.meta.url)), 'utf-8');
    expect(page).toMatch(/useEffect\(\(\) => \{ setRegion\(null\); setQuickBox\(null\); \}, \[slug\]\);/);
  });
});

describe('the quick edit scope (C3)', () => {
  const el = (id: string, over: Partial<ScopeElement> = {}): ScopeElement => ({ id, type: 'rectangle', version: 3, versionNonce: 77, ...over });

  it('the selection grows by bound text, a text\'s container and every member of its outermost group, with identities', () => {
    const els = [
      el('box', { version: 5, versionNonce: 11 }),
      el('label', { type: 'text', containerId: 'box' }),
      el('a', { groupIds: ['inner', 'outer'] }),
      el('b', { groupIds: ['outer'] }),
      el('c', { groupIds: ['other'] }),
      el('gone', { isDeleted: true, groupIds: ['outer'] }),
      el('free'),
    ];
    expect(quickEditScope(els, ['box', 'a'])).toEqual({
      ids: ['box', 'a', 'b', 'label'],
      identities: { box: '5:11', a: '3:77', b: '3:77', label: '3:77' },
    });
    // Selecting the label brings its container.
    expect(quickEditScope(els, ['label'])?.ids).toEqual(['label', 'box']);
    expect(quickEditScope(els, [])).toBeNull();
    expect(quickEditScope(els, ['gone'])).toBeNull();
  });

  it('it is not the Super wire\'s 12-id cap: 150 elements ride, more are refused in band before any send', () => {
    const many = Array.from({ length: 200 }, (_, i) => el(`e${i}`));
    expect(quickEditScope(many, many.slice(0, 150).map((e) => e.id))?.ids).toHaveLength(150);
    expect(QUICK_SCOPE_MAX).toBe(150);
    const src = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/BoardSuperField.tsx', import.meta.url)), 'utf-8');
    expect(src).toMatch(/if \(scope && scope\.ids\.length > QUICK_SCOPE_MAX\)/);
  });
});

describe('the quick edit\'s lines (criteria 5, 6, 10, 11)', () => {
  const job = (over: Record<string, unknown>) => ({ state: 'done', startedAt: '2026-11-12T00:00:00Z', ...over }) as never;

  it('done: the reply and Geri al for the edit; skipped owner changes are counted', () => {
    expect(lineOfJob(job({ reply: 'Elma eklendi.', edit: { id: 'q1', added: 3, changed: 0, skipped: [] } }), tq)).toEqual({ kind: 'done', reply: 'Elma eklendi.', editId: 'q1', skipped: 0, dropped: 0 });
    expect(lineOfJob(job({ reply: 'Yeşil yapıldı.', edit: { id: 'q2', added: 0, changed: 2, skipped: ['x'] } }), tq)).toMatchObject({ editId: 'q2', skipped: 1 });
    expect(lineOfJob(job({ reply: '' }), tq)).toEqual({ kind: 'done', reply: 'Güncellendi', editId: null, skipped: 0, dropped: 0 });
    expect(lineOfJob(job({ reply: 'Yeşil.', dropped: 2, edit: { id: 'q3', added: 0, changed: 1, skipped: [] } }), tq)).toMatchObject({ kind: 'done', dropped: 2 });
  });

  it('review r1: an edit that wrote nothing is never a success; the line follows what was written', () => {
    expect(lineOfJob(job({ reply: "Kutuya 'Ödeme' yazıldı.", nothing: true }), tq)).toEqual({ kind: 'nothing', reply: tq('whiteboard.quick.nothing') });
  });

  it('review r1: a failure is worded from its code in the owner\'s language, never the server\'s prose', () => {
    expect(lineOfJob(job({ state: 'failed', code: 'timeout', error: 'no answer in 60 s' }), tq)).toEqual({ kind: 'failed', text: tq('whiteboard.quick.err.timeout') });
    expect(lineOfJob(job({ state: 'failed', code: 'surprise', error: 'Zaman aşımı' }), tq)).toEqual({ kind: 'failed', text: tq('whiteboard.quick.failed') });
    expect(failKey(undefined)).toBe('whiteboard.quick.failed');
    expect(undoRefusalKey('not_latest')).toBe('whiteboard.quick.undoNotLatest');
    expect(undoRefusalKey('not_found')).toBe('whiteboard.quick.undoGone');
    const src = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/BoardSuperField.tsx', import.meta.url)), 'utf-8');
    expect(src).not.toMatch(/r\.message|status\.text|job\.error/);
  });

  it('not a board change and out of scope write nothing and offer Super\'e sor; failed and stopped say so', () => {
    expect(lineOfJob(job({ notBoard: true, reply: 'Bu bir tahta değişikliği değil.' }), tq)).toEqual({ kind: 'notBoard', reply: 'Bu bir tahta değişikliği değil.' });
    expect(lineOfJob(job({ outOfScope: true, reply: 'Önce Seçenek D şeklini seç.' }), tq)).toEqual({ kind: 'outOfScope', reply: 'Önce Seçenek D şeklini seç.' });
    expect(lineOfJob(job({ state: 'failed', code: 'unreadable', error: 'answer not readable' }), tq)).toEqual({ kind: 'failed', text: tq('whiteboard.quick.err.unreadable') });
    expect(lineOfJob(job({ state: 'stopped' }), tq)).toEqual({ kind: 'stopped' });
  });

  it('the added shapes are what the edit wrote that the scene did not hold (they become the selection)', () => {
    expect(addedIds([{ id: 'old' }, { id: 'n1' }, { id: 'n2', isDeleted: true }, { id: 'n3' }], new Set(['old']))).toEqual(['n1', 'n3']);
  });

  it('a refused start names its reason in band', () => {
    expect(startRefusalKey(409, 'busy')).toBe('whiteboard.quick.busy');
    expect(startRefusalKey(429, 'rate')).toBe('whiteboard.quick.rate');
    expect(startRefusalKey(413, 'scope_too_big')).toBe('whiteboard.quick.tooBig');
    expect(startRefusalKey(412, 'no_claude')).toBe('whiteboard.quick.noClaude');
    expect(startRefusalKey(500, '')).toBe('whiteboard.quick.failed');
  });

  it('the result lands at once, without the poll, and its additions are selected', () => {
    const src = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/BoardSuperField.tsx', import.meta.url)), 'utf-8');
    expect(src).toMatch(/api\.applyRemoteElements\(written\);\s*const added = addedIds\(written, before\);\s*if \(added\.length\) api\.selectIds\(added\);/);
    // The save settles before the scope's identities are read.
    expect(src.indexOf('await settleSave(() => saveRef.current, flush);', src.indexOf('const sendQuick'))).toBeLessThan(src.indexOf('canvasApi()?.quickScope()'));
  });

  it('every string the field shows exists in both languages', () => {
    const i18n = readFileSync(fileURLToPath(new URL('../../dashboard/src/context/I18nContext.tsx', import.meta.url)), 'utf-8');
    const src = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/BoardSuperField.tsx', import.meta.url)), 'utf-8')
      + readFileSync(fileURLToPath(new URL('../../dashboard/src/components/whiteboard/quickEditLogic.ts', import.meta.url)), 'utf-8');
    const keys = new Set([...src.matchAll(/'(whiteboard\.quick\.[A-Za-z]+)'/g)].map((m) => m[1]));
    expect(keys.size).toBeGreaterThan(15);
    for (const k of keys) expect(i18n.split(`'${k}':`).length - 1, k).toBe(2);
    expect(i18n).not.toMatch(/'whiteboard\.quick\.[A-Za-z]+': [^\n]*—/);
  });
});
