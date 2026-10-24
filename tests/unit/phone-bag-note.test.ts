// The phone's Bag note (the heat task): once per run, keyed by the run's startedAt; older keys
// pruned; memory only when startedAt is null or storage throws (iOS private mode).
import { beforeEach, describe, expect, it } from 'vitest';
import { BAG_NOTE_PREFIX, bagNoteDismissed, dismissBagNote, resetBagNoteMemoryForTests, type NoteStorage } from '../../dashboard/src/components/handsfree/phone/PhoneBagNote.js';

class MemStorage implements NoteStorage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

const throwing: NoteStorage = {
  get length(): number { throw new Error('private mode'); },
  key: () => { throw new Error('private mode'); },
  getItem: () => { throw new Error('private mode'); },
  setItem: () => { throw new Error('private mode'); },
  removeItem: () => { throw new Error('private mode'); },
};

const RUN1 = '2026-10-24T20:00:00.000Z';
const RUN2 = '2026-10-24T22:00:00.000Z';

describe('the phone Bag note', () => {
  beforeEach(() => resetBagNoteMemoryForTests());

  it('shows until dismissed; dismissal survives a reload (storage) and comes back on a new run', () => {
    const st = new MemStorage();
    expect(bagNoteDismissed(RUN1, st)).toBe(false);
    dismissBagNote(RUN1, st);
    resetBagNoteMemoryForTests(); // a reload: module memory is gone, storage stays
    expect(bagNoteDismissed(RUN1, st)).toBe(true);
    expect(bagNoteDismissed(RUN2, st)).toBe(false);
  });

  it('writing a key drops the older runs\' keys and keeps unrelated ones', () => {
    const st = new MemStorage();
    st.setItem('other', 'x');
    dismissBagNote(RUN1, st);
    dismissBagNote(RUN2, st);
    expect([...st.m.keys()].sort()).toEqual([BAG_NOTE_PREFIX + RUN2, 'other']);
  });

  it('startedAt null: dismissed in memory only', () => {
    const st = new MemStorage();
    dismissBagNote(null, st);
    expect(bagNoteDismissed(null, st)).toBe(true);
    expect(st.length).toBe(0);
    resetBagNoteMemoryForTests();
    expect(bagNoteDismissed(null, st)).toBe(false);
  });

  it('a storage that throws falls back to memory, never a throw', () => {
    expect(() => dismissBagNote(RUN1, throwing)).not.toThrow();
    expect(bagNoteDismissed(RUN1, throwing)).toBe(true);
    resetBagNoteMemoryForTests();
    expect(bagNoteDismissed(RUN1, throwing)).toBe(false);
  });
});
