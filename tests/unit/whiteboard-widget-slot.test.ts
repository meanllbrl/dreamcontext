import { describe, it, expect } from 'vitest';
import { sameWidgetSlot, widgetSlotProps } from '../../dashboard/src/components/whiteboard/widgetSlot.js';

/** The board's widgets re-render on a change of their own, never on a pan / zoom frame. */
describe('whiteboard widget slot: when a widget re-renders', () => {
  it('a frame that hands the same element, unchanged, renders nothing new', () => {
    const el = { id: 'w1', version: 3 };
    expect(sameWidgetSlot(widgetSlotProps(el, false), widgetSlotProps(el, false))).toBe(true);
  });

  it('an element changed IN PLACE (Excalidraw mutateElement on a resize) still re-renders', () => {
    const el = { id: 'w1', version: 3, width: 180 };
    const before = widgetSlotProps(el, false);
    el.width = 376;
    el.version = 4;
    expect(sameWidgetSlot(before, widgetSlotProps(el, false))).toBe(false);
  });

  it('a new element object (a payload commit, a remote merge) re-renders', () => {
    expect(sameWidgetSlot(widgetSlotProps({ id: 'w1', version: 3 }, false), widgetSlotProps({ id: 'w1', version: 3 }, false))).toBe(false);
  });

  it('activating or deactivating the widget re-renders', () => {
    const el = { id: 'w1', version: 3 };
    expect(sameWidgetSlot(widgetSlotProps(el, false), widgetSlotProps(el, true))).toBe(false);
  });
});
