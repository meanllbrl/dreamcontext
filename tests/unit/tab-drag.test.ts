/**
 * Unit tests for the pointer-driven session-tab drag
 * (`dashboard/src/components/sleepy/tabDrag.ts`, task: the desktop app stays light on an
 * 8GB MacBook Air).
 *
 * The regression these lock down: the native HTML5 tab drag froze WebKit for seconds, never
 * highlighted a zone, and could leave the drop layer mounted after the release. The gesture
 * is now pointer events + rects measured once + a store that changes only when the TARGET
 * changes; every way a drag can end without a drop must clear without acting.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  armTabDrag, createTabDragStore, hitTestTabDrop, sameTabTarget, zoneAt,
  TAB_DRAG_THRESHOLD_PX,
  type DragGeometry, type TabDropTarget, type TabGhost,
} from '../../dashboard/src/components/sleepy/tabDrag.js';

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

// One tab group over pane p1 (tabs a, b), and two side-by-side panes below it.
const GEOM: DragGeometry = {
  groups: [{ paneId: 'p1', rect: rect(0, 0, 300, 40), tabs: [
    { sid: 'a', rect: rect(4, 6, 100, 34) },
    { sid: 'b', rect: rect(104, 6, 200, 34) },
    // Scrolled out of the group's visible box: never a target.
    { sid: 'c', rect: rect(310, 6, 400, 34) },
  ] }],
  panes: [
    { paneId: 'p1', rect: rect(0, 40, 300, 340) },
    { paneId: 'p2', rect: rect(300, 40, 600, 340) },
  ],
};

describe('sameTabTarget', () => {
  it('compares by meaning, not identity', () => {
    expect(sameTabTarget({ kind: 'zone', paneId: 'p1', zone: 'left' }, { kind: 'zone', paneId: 'p1', zone: 'left' })).toBe(true);
    expect(sameTabTarget({ kind: 'zone', paneId: 'p1', zone: 'left' }, { kind: 'zone', paneId: 'p1', zone: 'right' })).toBe(false);
    expect(sameTabTarget({ kind: 'reorder', paneId: 'p1', beforeSid: 'a' }, { kind: 'reorder', paneId: 'p1', beforeSid: 'b' })).toBe(false);
    expect(sameTabTarget({ kind: 'group', paneId: 'p1' }, { kind: 'group', paneId: 'p2' })).toBe(false);
    expect(sameTabTarget(null, null)).toBe(true);
    expect(sameTabTarget({ kind: 'group', paneId: 'p1' }, null)).toBe(false);
  });
});

describe('the store', () => {
  it('notifies on start, on a CHANGED target, and on end — never for the same target again', () => {
    const store = createTabDragStore();
    const seen = vi.fn();
    store.subscribe(seen);
    store.start('a');
    store.setTarget({ kind: 'zone', paneId: 'p1', zone: 'left' });
    store.setTarget({ kind: 'zone', paneId: 'p1', zone: 'left' });
    store.setTarget({ kind: 'zone', paneId: 'p1', zone: 'left' });
    store.setTarget({ kind: 'zone', paneId: 'p1', zone: 'center' });
    expect(seen).toHaveBeenCalledTimes(3);
    expect(store.end()).toEqual({ sid: 'a', target: { kind: 'zone', paneId: 'p1', zone: 'center' } });
    expect(seen).toHaveBeenCalledTimes(4);
    expect(store.end()).toBeNull();
    expect(seen).toHaveBeenCalledTimes(4);
  });

  it('ignores a target with no drag in flight', () => {
    const store = createTabDragStore();
    store.setTarget({ kind: 'group', paneId: 'p1' });
    expect(store.get()).toBeNull();
  });
});

describe('hit-testing', () => {
  it('splits a pane into three equal zones', () => {
    const r = rect(0, 0, 300, 100);
    expect(zoneAt(r, 10)).toBe('left');
    expect(zoneAt(r, 99)).toBe('left');
    expect(zoneAt(r, 150)).toBe('center');
    expect(zoneAt(r, 201)).toBe('right');
    expect(zoneAt(r, 299)).toBe('right');
  });

  it('a tab is a reorder target, its group padding a combine, a pane a zone', () => {
    expect(hitTestTabDrop(GEOM, 150, 20, 'a')).toEqual({ kind: 'reorder', paneId: 'p1', beforeSid: 'b' });
    expect(hitTestTabDrop(GEOM, 250, 20, 'a')).toEqual({ kind: 'group', paneId: 'p1' });
    expect(hitTestTabDrop(GEOM, 20, 200, 'a')).toEqual({ kind: 'zone', paneId: 'p1', zone: 'left' });
    expect(hitTestTabDrop(GEOM, 450, 200, 'a')).toEqual({ kind: 'zone', paneId: 'p2', zone: 'center' });
    expect(hitTestTabDrop(GEOM, 590, 200, 'a')).toEqual({ kind: 'zone', paneId: 'p2', zone: 'right' });
  });

  it('the dragged tab itself and empty space are no target', () => {
    expect(hitTestTabDrop(GEOM, 50, 20, 'a')).toBeNull();
    expect(hitTestTabDrop(GEOM, 50, 500, 'a')).toBeNull();
  });

  it('a tab scrolled out of its group is not hit', () => {
    // (350, 20) is inside tab c's rect but outside every group.
    expect(hitTestTabDrop(GEOM, 350, 20, 'a')).toBeNull();
  });
});

// ── The gesture, on fake event targets ─────────────────────────────────────────────

function ev(type: string, props: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type, { cancelable: true }), props);
}

function rig(opts: { geom?: DragGeometry } = {}) {
  const store = createTabDragStore();
  const el = Object.assign(new EventTarget(), {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: () => true,
  });
  const win = Object.assign(new EventTarget(), {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  });
  const ghost = { move: vi.fn(), remove: vi.fn() } satisfies TabGhost;
  const onDrop = vi.fn<(sid: string, t: TabDropTarget) => void>();
  const measure = vi.fn(() => opts.geom ?? GEOM);
  armTabDrag({ pointerId: 1, clientX: 50, clientY: 20 }, el, 'a', {
    store, onDrop, measure, ghost: () => ghost, win, raf: (cb) => cb(),
  });
  const move = (x: number, y: number) => el.dispatchEvent(ev('pointermove', { pointerId: 1, clientX: x, clientY: y }));
  const up = (x: number, y: number) => el.dispatchEvent(ev('pointerup', { pointerId: 1, clientX: x, clientY: y }));
  return { store, el, win, ghost, onDrop, measure, move, up };
}

describe('armTabDrag', () => {
  it('captures the pointer at the press', () => {
    const r = rig();
    expect(r.el.setPointerCapture).toHaveBeenCalledWith(1);
  });

  it('a press released inside the threshold is a plain click: no drag, no drop, click kept', () => {
    const r = rig();
    r.move(50 + TAB_DRAG_THRESHOLD_PX - 1, 20);
    expect(r.store.get()).toBeNull();
    r.up(52, 20);
    expect(r.onDrop).not.toHaveBeenCalled();
    expect(r.measure).not.toHaveBeenCalled();
    const click = ev('click');
    r.win.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it('a 4 px move starts the drag, measures once, and the release drops on the last target', () => {
    const r = rig();
    r.move(50, 20 + TAB_DRAG_THRESHOLD_PX);
    expect(r.store.get()?.sid).toBe('a');
    for (let x = 300; x < 400; x += 5) r.move(x, 200);
    expect(r.measure).toHaveBeenCalledTimes(1);
    expect(r.store.get()?.target).toEqual({ kind: 'zone', paneId: 'p2', zone: 'left' });
    r.up(395, 200);
    expect(r.onDrop).toHaveBeenCalledWith('a', { kind: 'zone', paneId: 'p2', zone: 'left' });
    expect(r.store.get()).toBeNull();
    expect(r.ghost.remove).toHaveBeenCalled();
  });

  it('the release target is the RELEASE point, even if no frame ran for it', () => {
    const r = rig();
    r.move(50, 30);
    r.up(590, 200);
    expect(r.onDrop).toHaveBeenCalledWith('a', { kind: 'zone', paneId: 'p2', zone: 'right' });
  });

  it('moves the ghost by transform deltas from the press', () => {
    const r = rig();
    r.move(50, 30);
    r.move(80, 60);
    expect(r.ghost.move).toHaveBeenLastCalledWith(30, 40);
  });

  it('notifies the store only when the target changes, not per pointer move', () => {
    const r = rig();
    r.move(50, 30);
    const seen = vi.fn();
    r.store.subscribe(seen);
    for (let x = 310; x < 390; x += 2) r.move(x, 200); // all inside p2's left third
    expect(seen).toHaveBeenCalledTimes(1);
    r.move(450, 200); // into the centre
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('swallows the one click that follows a drop', async () => {
    const r = rig();
    r.move(50, 30);
    r.up(450, 200);
    const click = ev('click');
    r.win.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await new Promise((res) => setTimeout(res, 5));
    const later = ev('click');
    r.win.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });

  it('a drop over nothing clears without acting', () => {
    const r = rig();
    r.move(50, 30);
    r.up(50, 900);
    expect(r.onDrop).not.toHaveBeenCalled();
    expect(r.store.get()).toBeNull();
  });

  for (const [name, end] of [
    ['pointercancel', (r: ReturnType<typeof rig>) => r.el.dispatchEvent(ev('pointercancel'))],
    ['lostpointercapture', (r: ReturnType<typeof rig>) => r.el.dispatchEvent(ev('lostpointercapture'))],
    ['Escape', (r: ReturnType<typeof rig>) => r.win.dispatchEvent(ev('keydown', { key: 'Escape' }))],
    ['window blur', (r: ReturnType<typeof rig>) => r.win.dispatchEvent(ev('blur'))],
    ['the store ended from outside (the dragged tab\'s pane closed)', (r: ReturnType<typeof rig>) => r.store.end()],
  ] as const) {
    it(`${name} clears the drag without acting, and a later release does nothing`, () => {
      const r = rig();
      r.move(50, 30);
      r.move(450, 200);
      expect(r.store.get()?.target).toEqual({ kind: 'zone', paneId: 'p2', zone: 'center' });
      end(r);
      expect(r.store.get()).toBeNull();
      expect(r.ghost.remove).toHaveBeenCalled();
      r.up(450, 200);
      expect(r.onDrop).not.toHaveBeenCalled();
      const click = ev('click');
      r.win.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
    });
  }

  it('Escape during a drag is swallowed (it must not also collapse the surface)', () => {
    const r = rig();
    r.move(50, 30);
    const esc = ev('keydown', { key: 'Escape' });
    r.win.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
  });

  it('re-measures when the tab strip scrolls mid-drag', () => {
    const r = rig();
    r.move(50, 30);
    r.win.dispatchEvent(ev('scroll'));
    expect(r.measure).toHaveBeenCalledTimes(2);
  });

  it('a pane opening or closing mid-drag re-measures before the next hit-test', () => {
    const r = rig();
    r.move(50, 30);
    expect(r.measure).toHaveBeenCalledTimes(1);
    r.store.layoutChanged();
    expect(r.measure).toHaveBeenCalledTimes(2);
    r.up(450, 200);
    r.store.layoutChanged(); // after the drag: nobody listening
    expect(r.measure).toHaveBeenCalledTimes(2);
  });

  it('many scroll events in one frame measure once', () => {
    const store = createTabDragStore();
    const el = Object.assign(new EventTarget(), { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    const win = Object.assign(new EventTarget(), { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });
    const frames: Array<() => void> = [];
    const measure = vi.fn(() => GEOM);
    armTabDrag({ pointerId: 1, clientX: 50, clientY: 20 }, el, 'a', {
      store, onDrop: vi.fn(), measure, ghost: () => ({ move: vi.fn(), remove: vi.fn() }), win, raf: (cb) => frames.push(cb),
    });
    el.dispatchEvent(ev('pointermove', { pointerId: 1, clientX: 50, clientY: 30 }));
    frames.splice(0).forEach((f) => f());
    expect(measure).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) win.dispatchEvent(ev('scroll'));
    expect(measure).toHaveBeenCalledTimes(1);
    frames.splice(0).forEach((f) => f());
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('a tab that unmounted while held is torn down by the release on the window', () => {
    // Its own listeners never hear the release once it left the DOM.
    const r = rig();
    const held = new Event('selectstart', { cancelable: true });
    r.win.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    r.win.dispatchEvent(ev('pointerup', { pointerId: 2, clientX: 50, clientY: 20 })); // another pointer
    const still = new Event('selectstart', { cancelable: true });
    r.win.dispatchEvent(still);
    expect(still.defaultPrevented).toBe(true);
    r.win.dispatchEvent(ev('pointerup', { pointerId: 1, clientX: 50, clientY: 20 }));
    const after = new Event('selectstart', { cancelable: true });
    r.win.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(r.onDrop).not.toHaveBeenCalled();
  });

  it('a pointercancel on the window for this pointer clears the drag without acting', () => {
    const r = rig();
    r.move(50, 30);
    r.move(450, 200);
    r.win.dispatchEvent(ev('pointercancel', { pointerId: 2 }));
    expect(r.store.get()).not.toBeNull();
    r.win.dispatchEvent(ev('pointercancel', { pointerId: 1 }));
    expect(r.store.get()).toBeNull();
    expect(r.onDrop).not.toHaveBeenCalled();
  });

  it('a tab detached from the DOM mid-drag stops the drag on the next frame', () => {
    const r = rig();
    r.move(50, 30);
    expect(r.store.get()).not.toBeNull();
    Object.defineProperty(r.el, 'isConnected', { value: false });
    r.move(450, 200);
    expect(r.store.get()).toBeNull();
    expect(r.ghost.remove).toHaveBeenCalled();
    expect(r.onDrop).not.toHaveBeenCalled();
  });

  it('the release and the window copy of it drop once', () => {
    const r = rig();
    r.move(50, 30);
    r.move(450, 200);
    const up = ev('pointerup', { pointerId: 1, clientX: 450, clientY: 200 });
    r.win.dispatchEvent(up); // the capture copy runs first in a browser
    r.el.dispatchEvent(ev('pointerup', { pointerId: 1, clientX: 450, clientY: 200 }));
    expect(r.onDrop).toHaveBeenCalledTimes(1);
  });

  it('ignores another pointer', () => {
    const r = rig();
    r.el.dispatchEvent(ev('pointermove', { pointerId: 2, clientX: 400, clientY: 200 }));
    expect(r.store.get()).toBeNull();
  });
});

// The surface's "Esc collapses the overlay" listener is a window capture listener registered
// when the overlay expands — BEFORE any drag starts — so the drag's own stopPropagation cannot
// reach it (same-node capture listeners run in registration order). It must therefore yield to
// a drag in flight itself. Measured by scripts/verify/idle-load.mjs (section g): without this,
// one Escape cancelled the drag and folded the whole chat surface (10 visible tabs -> 0).
describe('Escape during a tab drag', () => {
  it('the surface collapse handler yields while a tab drag is in flight', () => {
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf8');
    const start = src.indexOf("// ── Esc collapses the overlay");
    expect(start).toBeGreaterThan(-1);
    const handler = src.slice(start, src.indexOf("window.addEventListener('keydown', onKey, true);", start));
    const yieldAt = handler.indexOf('if (tabDrag.get()) return;');
    expect(yieldAt).toBeGreaterThan(-1);
    expect(yieldAt).toBeLessThan(handler.indexOf('setExpanded(false)'));
  });
});

describe('no text selection while a tab is held', () => {
  it('prevents selectstart from the press until the gesture ends, and lets it through after', async () => {
    const { armTabDrag: arm, createTabDragStore: mk } = await import('../../dashboard/src/components/sleepy/tabDrag.js');
    const win = Object.assign(new EventTarget(), { setTimeout: (cb: () => void) => setTimeout(cb, 0) });
    const el = Object.assign(new EventTarget(), { setPointerCapture: () => {}, hasPointerCapture: () => false, releasePointerCapture: () => {} });
    const stop = arm({ pointerId: 1, clientX: 0, clientY: 0 } as never, el as never, 's1', {
      store: mk(), win: win as never, measure: () => ({ groups: [], panes: [] }), ghost: () => ({ move: () => {}, remove: () => {} }), onDrop: () => {},
    } as never);
    const during = new Event('selectstart', { cancelable: true });
    win.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
    stop();
    const after = new Event('selectstart', { cancelable: true });
    win.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
