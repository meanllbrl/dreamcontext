import { describe, it, expect } from 'vitest';
import { applyQuickEdit, expandScope, LOSING_NONCE, undoQuickEdit, type QuickJournalRecord } from '../../src/lib/whiteboards/quick-edit.js';
import { identityKey } from '../../src/lib/whiteboards/store.js';
import { mergeElements, stripTombstones } from '../../src/lib/whiteboards/merge.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';

function rect(id: string, extra: Partial<WhiteboardElement> = {}): WhiteboardElement {
  return { id, type: 'rectangle', x: 0, y: 0, width: 100, height: 60, version: 3, versionNonce: 500, index: `a${id}`, isDeleted: false, groupIds: [], boundElements: null, backgroundColor: '#d0bfff', ...extra } as WhiteboardElement;
}
function label(id: string, container: string, text: string): WhiteboardElement {
  return { id, type: 'text', x: 10, y: 20, width: 80, height: 25, version: 2, versionNonce: 400, index: `b${id}`, isDeleted: false, groupIds: [], text, originalText: text, fontSize: 20, containerId: container } as WhiteboardElement;
}

/** Apply an answer and build the journal record the jobs module writes from it. */
function edit(els: WhiteboardElement[], answer: Parameters<typeof applyQuickEdit>[1], pick: string[], built?: WhiteboardElement[][]): QuickJournalRecord {
  const scope = expandScope(els, pick);
  const identities = Object.fromEntries(scope.map((id) => [id, identityKey(els.find((e) => e.id === id)!)]));
  const o = applyQuickEdit({ elements: els }, answer, { scope, identities, area: null, built });
  const stripped = stripTombstones(els);
  els.splice(0, els.length, ...stripped);
  const after = Object.fromEntries([...o.added, ...o.changed].map((id) => [id, identityKey(els.find((e) => e.id === id)!)]));
  return { id: 'rec-0000000000000001', at: '', text: '', reply: '', added: o.added, changed: o.changed, before: o.before, after, costUsd: null, model: 'sonnet', undone: false };
}

describe('quick edit undo (C4)', () => {
  it('is a forward inverse write that beats the merge (never a restore of old bytes)', () => {
    const els = [rect('A')];
    const rec = edit(els, { reply: '', notBoard: false, update: [{ id: 'A', fill: 'green' }] }, ['A']);
    const undo = undoQuickEdit({ elements: els }, rec);
    expect(undo.skipped).toEqual([]);
    const a = els[0];
    expect(a.backgroundColor).toBe('#d0bfff');
    expect(a.version).toBe(5);
    expect(a.versionNonce).toBe(LOSING_NONCE);
    // A stale browser copy of the edited element (version 4) cannot bring the edit back.
    const stale = { ...rect('A'), version: 4, versionNonce: 1, backgroundColor: '#b2f2bb' };
    expect(mergeElements(els, [stale]).elements[0].backgroundColor).toBe('#d0bfff');
  });

  it('a removed shape comes back with its text', () => {
    const els = [rect('A', { boundElements: [{ id: 'T', type: 'text' }] }), label('T', 'A', 'Seçenek D')];
    const rec = edit(els, { reply: '', notBoard: false, remove: ['A'] }, ['A']);
    expect(els.find((e) => e.id === 'T')!.text).toBe('');
    undoQuickEdit({ elements: els }, rec);
    const t = els.find((e) => e.id === 'T')!;
    expect(t.isDeleted).toBe(false);
    expect(t.originalText).toBe('Seçenek D');
    expect(els.find((e) => e.id === 'A')!.isDeleted).toBe(false);
  });

  it('an added shape is tombstoned', () => {
    const els = [rect('A')];
    const rec = edit(els, { reply: '', notBoard: false, add: [{ at: [300, 0], spec: { elements: [{ type: 'ellipse', width: 50, height: 50 }] } }] }, [], [[{ ...rect('E'), type: 'ellipse', width: 50, height: 50 } as WhiteboardElement]]);
    expect(rec.added).toHaveLength(1);
    undoQuickEdit({ elements: els }, rec);
    expect(els.find((e) => e.id === rec.added[0])!.isDeleted).toBe(true);
  });

  it('leaves what the owner touched after the edit, including a save that TIED its version', () => {
    const els = [rect('A'), rect('B', { x: 300 })];
    const rec = edit(els, { reply: '', notBoard: false, move: [10, 0] }, ['A', 'B']);
    // The owner moves B afterwards at the SAME version the agent wrote, another nonce.
    const b = els.find((e) => e.id === 'B')!;
    els[els.indexOf(b)] = { ...b, x: 777, versionNonce: 42 };
    const undo = undoQuickEdit({ elements: els }, rec);
    expect(undo.skipped).toEqual(['B']);
    expect(els.find((e) => e.id === 'B')!.x).toBe(777);
    expect(els.find((e) => e.id === 'A')!.x).toBe(0);
  });
});
