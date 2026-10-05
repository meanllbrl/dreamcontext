/**
 * Drag-to-ask (T7, AC15): the pure decisions behind dropping board elements onto an agent card.
 * Which elements the gesture moved, which card takes the drop (never a moved one, never an S
 * card), which elements become chips (topmost 4, bound text folded into its container), the
 * token the server expands, and the restore at a version above the current one.
 *
 * The capture sequence is pinned here by its pure half (`historyDiff` empty after the restore:
 * the drag's entry holds no move); the Cmd+Z sentinel itself runs against real Excalidraw
 * History in the browser check W6.
 */
import { describe, it, expect } from 'vitest';
import {
  DROP_UNITS_MAX, agentCardUnder, dropUnits, historyDiff, movedIds, refToken, restorePatches, snapshotElement,
  type DropElement, type PreGesture,
} from '../../dashboard/src/components/whiteboard/agentDrop.js';

function el(id: string, over: Partial<DropElement> = {}): DropElement {
  return { id, type: 'rectangle', x: 0, y: 0, width: 100, height: 100, version: 1, ...over };
}

function agentCard(id: string, size: 's' | 'm' | 'l' | 'xl', over: Partial<DropElement> = {}): DropElement {
  const box = { s: [180, 180], m: [376, 180], l: [376, 376], xl: [768, 376] }[size];
  return el(id, {
    type: 'embeddable',
    x: 1000,
    y: 1000,
    width: box[0],
    height: box[1],
    customData: { dc: { v: 1, kind: 'agent', ref: 'weekly-digest', title: 'Weekly digest', size } },
    ...over,
  });
}

function snapshot(elements: readonly DropElement[]): Map<string, PreGesture> {
  return new Map(elements.map((e) => [e.id, snapshotElement(e)]));
}

describe('movedIds', () => {
  it('lists the live elements whose version changed since pointer-down', () => {
    const before = snapshot([el('a'), el('b'), el('c')]);
    const after = [el('a', { x: 50, version: 2 }), el('b'), el('c', { version: 5, isDeleted: true })];
    expect([...movedIds(before, after)!]).toEqual(['a']);
  });

  it('is null when the gesture made a new element (an Alt-drag duplicate is never a drop)', () => {
    const before = snapshot([el('a')]);
    expect(movedIds(before, [el('a'), el('copy', { version: 2 })])).toBeNull();
  });

  it('keeps the pre-gesture geometry even though Excalidraw mutates the element in place', () => {
    const live = el('a', { x: 10, points: [[0, 0], [5, 5]] });
    const pre = snapshotElement(live);
    live.x = 900;
    (live.points as number[][]).push([9, 9]);
    expect(pre.x).toBe(10);
    expect(pre.points).toEqual([[0, 0], [5, 5]]);
  });
});

describe('agentCardUnder', () => {
  const point = { x: 1100, y: 1100 };

  it('finds the agent card under the pointer', () => {
    const card = agentCard('card', 'l');
    expect(agentCardUnder([el('a'), card], new Set(['a']), point)?.id).toBe('card');
  });

  it('excludes the moved elements from the hit test (a dragged card is not its own target)', () => {
    const card = agentCard('card', 'l');
    expect(agentCardUnder([card], new Set(['card']), point)).toBeNull();
  });

  it('never takes an S card as a target', () => {
    expect(agentCardUnder([agentCard('small', 's')], new Set(['a']), point)).toBeNull();
    // An M card underneath an S one still takes it.
    const under = agentCard('m', 'm');
    expect(agentCardUnder([under, agentCard('small', 's')], new Set(['a']), point)?.id).toBe('m');
  });

  it('takes the topmost card, and ignores deleted, rotated, non-agent widgets and a miss', () => {
    const low = agentCard('low', 'l');
    const high = agentCard('high', 'l');
    expect(agentCardUnder([low, high], new Set(), point)?.id).toBe('high');
    expect(agentCardUnder([agentCard('gone', 'l', { isDeleted: true })], new Set(), point)).toBeNull();
    expect(agentCardUnder([agentCard('tilted', 'l', { angle: 0.3 })], new Set(), point)).toBeNull();
    const note = el('note', {
      type: 'embeddable', x: 1000, y: 1000, width: 376, height: 376,
      customData: { dc: { v: 1, kind: 'note', title: 'N', markdown: '' } },
    });
    expect(agentCardUnder([note], new Set(), point)).toBeNull();
    expect(agentCardUnder([agentCard('card', 'l')], new Set(), { x: 10, y: 10 })).toBeNull();
  });
});

describe('dropUnits', () => {
  it('folds a bound text into its container and names it by the label', () => {
    const box = el('box');
    const label = el('label', { type: 'text', containerId: 'box', text: 'Q3   plan\nnow' });
    expect(dropUnits([box, label], new Set(['box', 'label']))).toEqual([{ id: 'box', kind: 'rectangle', title: 'Q3 plan now' }]);
    expect(dropUnits([box, label], new Set(['label']))).toEqual([{ id: 'box', kind: 'rectangle', title: 'Q3 plan now' }]);
  });

  it(`takes the topmost ${DROP_UNITS_MAX} units, topmost first`, () => {
    const elements = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => el(id, { type: 'text', text: id.toUpperCase() }));
    const units = dropUnits(elements, new Set(['a', 'b', 'c', 'd', 'e', 'f']));
    expect(units.map((u) => u.id)).toEqual(['f', 'e', 'd', 'c']);
  });

  it('names a widget by its kind and title, a text by its words, an unlabeled shape by type only', () => {
    const note = el('n', { type: 'embeddable', customData: { dc: { v: 1, kind: 'note', title: 'Launch notes', markdown: 'x' } } });
    const text = el('t', { type: 'text', originalText: 'hello', text: 'hel-\nlo' });
    const arrow = el('ar', { type: 'arrow' });
    expect(dropUnits([note, text, arrow], new Set(['n', 't', 'ar']))).toEqual([
      { id: 'ar', kind: 'arrow', title: '' },
      { id: 't', kind: 'text', title: 'hello' },
      { id: 'n', kind: 'note', title: 'Launch notes' },
    ]);
  });

  it('cuts a long title', () => {
    const [unit] = dropUnits([el('t', { type: 'text', text: 'x'.repeat(200) })], new Set(['t']));
    expect(unit!.title.length).toBe(60);
    expect(unit!.title.endsWith('…')).toBe(true);
  });
});

describe('refToken', () => {
  it('builds the token the server expands', () => {
    expect(refToken('launch-board', 'Ab_3-x')).toBe('dcref:wb/launch-board/Ab_3-x');
  });

  it('refuses a board or id the server token would not match', () => {
    expect(refToken('Launch', 'a')).toBeNull();
    expect(refToken('-x', 'a')).toBeNull();
    expect(refToken('board', 'a/b')).toBeNull();
    expect(refToken('board', 'a'.repeat(65))).toBeNull();
    expect(refToken('board', '')).toBeNull();
  });
});

describe('restorePatches', () => {
  it('puts every moved element back to its pre-gesture geometry, at a version above the current one', () => {
    const shape = el('s', { x: 10, y: 20, boundElements: [{ id: 'ar', type: 'arrow' }] });
    const arrow = el('ar', { type: 'arrow', x: 0, y: 0, points: [[0, 0], [10, 0]], startBinding: { elementId: 's' } });
    const still = el('still');
    const before = snapshot([shape, arrow, still]);
    const after = [
      el('s', { x: 400, y: 500, version: 7, boundElements: [{ id: 'ar', type: 'arrow' }] }),
      el('ar', { type: 'arrow', x: 300, y: 300, version: 4, points: [[0, 0], [99, 9]], startBinding: null }),
      still,
    ];
    const patches = restorePatches(before, after, movedIds(before, after)!);
    expect(patches.get('s')).toMatchObject({ x: 10, y: 20, version: 8 });
    expect(patches.get('ar')).toMatchObject({ x: 0, y: 0, points: [[0, 0], [10, 0]], startBinding: { elementId: 's' }, version: 5 });
    expect(patches.has('still')).toBe(false);
    expect(patches.get('s')).not.toHaveProperty('id');
  });

  /**
   * The undo decision (amendment 2). The canvas restores inside Excalidraw's pointer-up, before
   * the drag's commit; the commit diffs the store snapshot (still the pre-drag copy) against the
   * restored scene. If that diff is empty for every moved element, the drag's history entry
   * holds no move, only the selection change to the card, and one Cmd+Z stops there.
   */
  it('leaves nothing for Excalidraw history to record between the pre-drag and the restored element', () => {
    const note = {
      id: 'note', type: 'embeddable', x: 40, y: 60, width: 376, height: 180, angle: 0, version: 3, versionNonce: 11,
      updated: 1, seed: 5, isDeleted: false, frameId: null, boundElements: [{ id: 'ar', type: 'arrow' }], index: 'a1',
      groupIds: [], link: 'dreamcontext://note/note', customData: { dc: { v: 1, kind: 'note', title: 'Pricing', markdown: 'x' } },
    };
    const arrow = {
      id: 'ar', type: 'arrow', x: 500, y: 100, width: 80, height: 0, angle: 0, version: 2, versionNonce: 7, updated: 1,
      seed: 9, isDeleted: false, frameId: null, points: [[0, 0], [80, 0]], startBinding: null,
      endBinding: { elementId: 'note', focus: 0, gap: 4 }, index: 'a2', groupIds: [],
    };
    const committed = [structuredClone(note), structuredClone(arrow)];
    const scene: DropElement[] = [note as DropElement, arrow as DropElement];
    const pre = snapshot(scene);
    // The drag, as Excalidraw's mutateElement does it: in place, version bumped every move.
    Object.assign(note, { x: 1100, y: 1100, version: 9, versionNonce: 99, updated: 2 });
    Object.assign(arrow, { width: 640, points: [[0, 0], [640, 1000]], version: 6, versionNonce: 66, updated: 2 });
    expect(historyDiff(committed[0]!, note)).toEqual(['x', 'y']); // control: the drag itself is visible

    const moved = movedIds(pre, scene)!;
    const patches = restorePatches(pre, scene, moved);
    const restored = scene.map((el) => {
      const patch = patches.get(el.id);
      // newElementWith: the patch, a fresh nonce and timestamp.
      return patch ? { ...el, ...patch, versionNonce: 1234, updated: 3 } : el;
    });
    restored.forEach((el, i) => {
      expect(historyDiff(committed[i]!, el as unknown as Record<string, unknown>)).toEqual([]);
      expect(el.version).toBeGreaterThan(committed[i]!.version);
    });
  });

  it('historyDiff ignores exactly what Excalidraw history ignores', () => {
    const base = { id: 'a', x: 1, version: 1, versionNonce: 1, updated: 1, seed: 1 };
    expect(historyDiff(base, { ...base, id: 'b', version: 2, versionNonce: 2, updated: 2, seed: 2 })).toEqual([]);
    expect(historyDiff(base, { ...base, x: 2 })).toEqual(['x']);
    expect(historyDiff(base, { ...base, frameId: 'f' })).toEqual(['frameId']);
  });

  it('leaves a deleted element alone', () => {
    const before = snapshot([el('a')]);
    const after = [el('a', { x: 5, version: 2, isDeleted: true })];
    expect(restorePatches(before, after, new Set(['a'])).size).toBe(0);
  });
});
