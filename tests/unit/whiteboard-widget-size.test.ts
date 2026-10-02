import { describe, expect, it } from 'vitest';
import { WIDGET_SIZES } from '../../dashboard/src/lib/whiteboardWidgets.js';
import {
  GRID_PITCH, clipTodoItems, placeNewWidget, resizeInPlace, snapAfterGesture, snapToGrid,
  CANVAS_CHROME, SIZE_PICKER_BOX, placeSizePicker, todoCapacity, widgetSizeOf,
} from '../../dashboard/src/components/whiteboard/widgetSize.js';
import { WIDGET_STROKE, hasWidgetStroke, selectionIsOnlyWidgets } from '../../dashboard/src/components/whiteboard/widgetModel.js';

/**
 * A17 snap math: which preset a widget is, where a move lands, what a resize snaps to, and
 * the no-op answer that keeps the pointer-up `updateScene` from looping.
 */
describe('widget grid', () => {
  it('the pitch is one cell plus one gap', () => {
    expect(GRID_PITCH).toBe(196);
  });

  it('snaps a coordinate to the nearest grid line, negatives included', () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(97)).toBe(0);
    expect(snapToGrid(99)).toBe(196);
    expect(snapToGrid(400)).toBe(392);
    expect(snapToGrid(-99)).toBe(-196);
    expect(Object.is(snapToGrid(-10), 0)).toBe(true); // never -0
  });

  it('places a new widget centred on the point, on the grid, at its preset', () => {
    expect(placeNewWidget({ x: 500, y: 300 }, 'm')).toEqual({ x: 392, y: 196, width: 376, height: 180 });
    expect(placeNewWidget({ x: 0, y: 0 }, 's')).toEqual({ x: 0, y: 0, width: 180, height: 180 });
  });
});

describe('widget size', () => {
  it('a recorded dc.size wins', () => {
    expect(widgetSizeOf('xl', 180, 180)).toBe('xl');
  });

  it('a missing or bogus dc.size derives the nearest preset from the box (Phase-1 boards)', () => {
    expect(widgetSizeOf(undefined, 320, 200)).toBe('m');
    expect(widgetSizeOf('huge', 190, 170)).toBe('s');
    expect(widgetSizeOf(undefined, 400, 400)).toBe('l');
    expect(widgetSizeOf(undefined, 800, 420)).toBe('xl');
    for (const [k, [w, h]] of Object.entries(WIDGET_SIZES)) expect(widgetSizeOf(undefined, w, h)).toBe(k);
  });

  it('resizing in place keeps the top-left (on the grid) and takes the preset box', () => {
    expect(resizeInPlace({ x: 196, y: 392, width: 180, height: 180 }, 'xl'))
      .toEqual({ x: 196, y: 392, width: 768, height: 376, size: 'xl' });
    expect(resizeInPlace({ x: 210, y: 380, width: 320, height: 200 }, 's'))
      .toEqual({ x: 196, y: 392, width: 180, height: 180, size: 's' });
  });
});

describe('snapAfterGesture', () => {
  const at = { x: 196, y: 196, width: 376, height: 180 };

  it('a move keeps the size and lands the top-left on the grid', () => {
    expect(snapAfterGesture(at, { ...at, x: 420, y: 250 }, 'm')).toEqual({ x: 392, y: 196, width: 376, height: 180, size: 'm' });
  });

  it('a resize keeps the dragged box (on the 4px step) and records the NEAREST preset', () => {
    // A phone-width web widget: free-form, not pulled back to a preset.
    expect(snapAfterGesture(at, { ...at, width: 391, height: 843 }, 'm')).toEqual({ x: 196, y: 196, width: 392, height: 844, size: 'l' });
    expect(snapAfterGesture(at, { ...at, width: 700, height: 360 }, 'm')).toEqual({ x: 196, y: 196, width: 700, height: 360, size: 'xl' });
  });

  it('a resize never goes below the minimum box', () => {
    expect(snapAfterGesture(at, { ...at, width: 20, height: 10 }, 'm')).toEqual({ x: 196, y: 196, width: 120, height: 96, size: 's' });
  });

  it('a resize from the left handle keeps the right edge', () => {
    // The right edge sits at 572; the left edge dragged out to -188 gives a 760-wide box.
    expect(snapAfterGesture(at, { x: -188, y: 196, width: 760, height: 180 }, 'm'))
      .toEqual({ x: -188, y: 196, width: 760, height: 180, size: 'xl' });
    // Clamped at the minimum, the right edge still holds: x = 572 - 120.
    expect(snapAfterGesture(at, { x: 562, y: 196, width: 10, height: 180 }, 'm'))
      .toEqual({ x: 452, y: 196, width: 120, height: 180, size: 's' });
  });

  it('records dc.size on a Phase-1 widget it moves', () => {
    const free = { x: 100, y: 100, width: 320, height: 200 };
    expect(snapAfterGesture(free, { ...free, x: 190 }, undefined)).toEqual({ x: 196, y: 196, width: 320, height: 200, size: 'm' });
  });

  it('is a no-op (null) when nothing moved or it already sits where it would snap', () => {
    expect(snapAfterGesture(at, at, 'm')).toBeNull();
    // Moved exactly one pitch: already on the grid, already sized.
    expect(snapAfterGesture(at, { ...at, x: 392 }, 'm')).toBeNull();
    // Applying a snap result and snapping again changes nothing: no update loop.
    const once = snapAfterGesture(at, { ...at, x: 430, width: 390, height: 360 }, 'm')!;
    const { size, ...box } = once;
    expect(snapAfterGesture(at, box, size)).toBeNull();
  });

  it('snapMove:false leaves a move alone (it also carried free drawing) but still snaps a resize', () => {
    expect(snapAfterGesture(at, { ...at, x: 430 }, 'm', { snapMove: false })).toBeNull();
    expect(snapAfterGesture(at, { ...at, width: 390, height: 360 }, 'm', { snapMove: false }))
      .toEqual({ x: 196, y: 196, width: 392, height: 360, size: 'l' });
  });
});

describe('todo rows per size', () => {
  it('holds more rows as the widget grows; XL flows into two columns', () => {
    expect(todoCapacity('s')).toBe(4);
    expect(todoCapacity('m')).toBe(4);
    expect(todoCapacity('l')).toBe(11);
    expect(todoCapacity('xl')).toBe(22);
  });

  it('a free-form box counts rows from its real height', () => {
    expect(todoCapacity('m', 600)).toBe(19);
    expect(todoCapacity('m', 96)).toBe(1);
  });

  it('clips with a "+N more" row only when the list overflows', () => {
    expect(clipTodoItems([1, 2, 3], 4)).toEqual({ shown: [1, 2, 3], hidden: 0 });
    expect(clipTodoItems([1, 2, 3, 4], 4)).toEqual({ shown: [1, 2, 3, 4], hidden: 0 });
    expect(clipTodoItems([1, 2, 3, 4, 5, 6], 4)).toEqual({ shown: [1, 2, 3], hidden: 3 });
  });
});

describe('widget stroke (A18)', () => {
  const widget = { type: 'embeddable', strokeColor: '#1e1e1e', customData: { dc: { v: 1, kind: 'note' } } };

  it('a Phase-1 widget with a black stroke is flagged for normalising', () => {
    expect(hasWidgetStroke(widget)).toBe(true);
  });

  it('a normalised widget, a deleted one, and free drawing are left alone', () => {
    expect(hasWidgetStroke({ ...widget, strokeColor: WIDGET_STROKE })).toBe(false);
    expect(hasWidgetStroke({ ...widget, isDeleted: true })).toBe(false);
    expect(hasWidgetStroke({ type: 'rectangle', strokeColor: '#1e1e1e' })).toBe(false);
    expect(hasWidgetStroke({ type: 'embeddable', strokeColor: '#1e1e1e', customData: {} })).toBe(false);
  });
});

describe('widget-only selection (A18)', () => {
  const widget = { id: 'w1', type: 'embeddable', customData: { dc: { v: 1, kind: 'note' } } };
  const widget2 = { id: 'w2', type: 'embeddable', customData: { dc: { v: 1, kind: 'todo' } } };
  const rect = { id: 'r1', type: 'rectangle' };
  const bareEmbed = { id: 'e1', type: 'embeddable', customData: {} };
  const scene = [widget, widget2, rect, bareEmbed];

  it('is true for one or more widgets and nothing else', () => {
    expect(selectionIsOnlyWidgets(scene, { w1: true })).toBe(true);
    expect(selectionIsOnlyWidgets(scene, { w1: true, w2: true })).toBe(true);
  });

  it('is false for an empty selection, free drawing, a mix, or a non-widget embeddable', () => {
    expect(selectionIsOnlyWidgets(scene, {})).toBe(false);
    expect(selectionIsOnlyWidgets(scene, { r1: true })).toBe(false);
    expect(selectionIsOnlyWidgets(scene, { w1: true, r1: true })).toBe(false);
    expect(selectionIsOnlyWidgets(scene, { e1: true })).toBe(false);
  });

  it('ignores a deleted element and a false entry in the id map', () => {
    expect(selectionIsOnlyWidgets([widget, { ...rect, isDeleted: true }], { w1: true, r1: true })).toBe(true);
    expect(selectionIsOnlyWidgets(scene, { w1: true, r1: false })).toBe(true);
  });
});

describe('size picker placement (A18)', () => {
  const view = { width: 1300, height: 890 };
  const gap = 10;

  it('sits centred under a widget with room below', () => {
    expect(placeSizePicker({ left: 400, top: 230, right: 590, bottom: 320 }, view, gap)).toEqual({ left: 495, top: 330 });
  });

  it('flips above a widget whose control would land on the bottom chrome', () => {
    const at = placeSizePicker({ left: 400, top: 620, right: 790, bottom: 810 }, view, gap);
    expect(at.top).toBe(620 - gap - SIZE_PICKER_BOX.height);
  });

  it('goes inside the card when there is no room above or below', () => {
    const at = placeSizePicker({ left: 400, top: 40, right: 790, bottom: 880 }, view, gap);
    expect(at.top).toBe(view.height - CANVAS_CHROME.bottom - SIZE_PICKER_BOX.height);
    expect(at.top).toBeGreaterThanOrEqual(CANVAS_CHROME.top);
  });

  it('stays inside the viewport horizontally', () => {
    expect(placeSizePicker({ left: -300, top: 100, right: -100, bottom: 200 }, view, gap).left)
      .toBe(CANVAS_CHROME.side + SIZE_PICKER_BOX.width / 2);
    expect(placeSizePicker({ left: 1250, top: 100, right: 1450, bottom: 200 }, view, gap).left)
      .toBe(view.width - CANVAS_CHROME.side - SIZE_PICKER_BOX.width / 2);
  });
});
