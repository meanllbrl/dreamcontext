import { describe, it, expect } from 'vitest';
import { mergeElements, stripTombstone } from '../../src/lib/whiteboards/merge.js';
import { makeWidgetElement, type WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';

function el(id: string, version: number, versionNonce: number, index: string, extra: Partial<WhiteboardElement> = {}): WhiteboardElement {
  return { id, type: 'rectangle', version, versionNonce, index, isDeleted: false, x: 0, y: 0, width: 10, height: 10, ...extra };
}

describe('whiteboard mergeElements', () => {
  it('the higher version wins, from either side', () => {
    const disk = [el('a', 3, 50, 'a0', { x: 1 }), el('b', 1, 50, 'a1', { x: 1 })];
    const incoming = [el('a', 2, 10, 'a0', { x: 2 }), el('b', 2, 99, 'a1', { x: 2 })];
    const { elements } = mergeElements(disk, incoming);
    expect(elements.find((e) => e.id === 'a')!.x).toBe(1);
    expect(elements.find((e) => e.id === 'b')!.x).toBe(2);
  });

  it('on equal versions the lower versionNonce wins (Excalidraw reconcile rule)', () => {
    const { elements } = mergeElements([el('a', 2, 80, 'a0', { x: 1 })], [el('a', 2, 20, 'a0', { x: 2 })]);
    expect(elements[0].x).toBe(2);
    const r2 = mergeElements([el('a', 2, 20, 'a0', { x: 1 })], [el('a', 2, 80, 'a0', { x: 2 })]);
    expect(r2.elements[0].x).toBe(1);
  });

  it('a tombstone beats a stale live copy — a CLI delete is not resurrected by an old scene', () => {
    const disk = [el('a', 5, 1, 'a0', { isDeleted: true })];
    const incoming = [el('a', 4, 1, 'a0', { isDeleted: false })];
    const { elements, diskContributed } = mergeElements(disk, incoming);
    expect(elements[0].isDeleted).toBe(true);
    expect(diskContributed).toBe(true);
  });

  it('unions new ids from both sides and sorts by (index, id)', () => {
    const { elements } = mergeElements(
      [el('z', 1, 1, 'a2'), el('m', 1, 1, 'a0')],
      [el('b', 1, 1, 'a1'), el('a', 1, 1, 'a1')],
    );
    expect(elements.map((e) => e.id)).toEqual(['m', 'a', 'b', 'z']);
  });

  it('diskContributed: false when incoming already holds everything; true on an unknown or newer disk id', () => {
    const a = el('a', 2, 5, 'a0');
    expect(mergeElements([a], [{ ...a }]).diskContributed).toBe(false);
    expect(mergeElements([a], [el('a', 3, 5, 'a0')]).diskContributed).toBe(false);
    expect(mergeElements([a, el('cli', 1, 1, 'a1')], [a]).diskContributed).toBe(true);
    expect(mergeElements([el('a', 4, 5, 'a0')], [a]).diskContributed).toBe(true);
  });

  it('diskContributed ignores content: a stripped tombstone vs the unstripped copy at the same identity', () => {
    const w = { ...makeWidgetElement('note', { markdown: 'long body' }, { x: 0, y: 0 }, 'a0'), isDeleted: true };
    const stripped = stripTombstone(w);
    expect(mergeElements([stripped], [w]).diskContributed).toBe(false);
  });
});

describe('whiteboard stripTombstone (D14)', () => {
  it('strips text and heavy widget payload, keeps every schema field', () => {
    const w = {
      ...makeWidgetElement('todo', { title: 't', items: [{ id: 'i', text: 'x', done: false }], tag: 'daily' }, { x: 1, y: 2 }, 'a5'),
      isDeleted: true,
      groupIds: ['g1'],
      boundElements: [{ id: 'arrow', type: 'arrow' }],
    };
    const s = stripTombstone(w);
    const dc = (s.customData as { dc: Record<string, unknown> }).dc;
    expect(dc.items).toBeUndefined();
    expect(dc.kind).toBe('todo');
    expect(dc.tag).toBe('daily');
    expect(s.index).toBe('a5');
    expect(s.groupIds).toEqual(['g1']);
    expect(s.boundElements).toEqual([{ id: 'arrow', type: 'arrow' }]);
    expect(s.version).toBe(w.version);

    const t = stripTombstone(el('t', 2, 1, 'a0', { type: 'text', text: 'gizli', originalText: 'gizli', isDeleted: true }));
    expect(t.text).toBe('');
    expect(t.originalText).toBe('');
    expect(t.type).toBe('text');
  });

  it('leaves a live element untouched', () => {
    const live = el('t', 2, 1, 'a0', { type: 'text', text: 'hi' });
    expect(stripTombstone(live)).toBe(live);
  });
});
