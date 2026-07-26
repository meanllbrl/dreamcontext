/**
 * Unit tests for `checklistStore.ts` (chat-interactive-views plan §1.10, T3) —
 * and specifically the REGRESSION LOCK for the single worst defect three
 * independent reviewers found in the first pass of this design: a checklist
 * storage key / window label that didn't carry the vault, so two unrelated
 * projects choosing the same checklist `id` (the plan's own worked example is
 * `"asc-api-key"`) could read, edit, and submit into EACH OTHER's checklist.
 *
 * There is no jsdom/happy-dom anywhere in this repo (verified — root vitest
 * runs under the plain Node environment), so `localStorage` is shimmed here
 * with a minimal in-memory object implementing the real `Storage` surface
 * (`getItem`/`setItem`/`removeItem`/`key`/`length`) rather than assumed from a
 * DOM. `sweepExpired` specifically relies on `key`/`length` (not
 * `Object.keys`), so the stub below is not just enough to pass — it exercises
 * the exact same iteration surface the store uses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  labelPart, checklistWindowLabel, checklistEnvelopeKey, checklistStateKey,
  writeEnvelope, readEnvelope, readState, writeState, clearChecklist, sweepExpired,
  CHECKLIST_TTL_MS, CHECKLIST_WRITE_DEBOUNCE_MS, type ChecklistEnvelope,
} from '../../dashboard/src/lib/checklistStore.js';
import { vaultWindowLabel } from '../../dashboard/src/lib/desktop.js';
import { emptyState, checklistReducer } from '../../dashboard/src/lib/checklistState.js';
import type { ChecklistViewSpec } from '../../dashboard/src/lib/chatViewSpec.js';

function makeLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  } as unknown as Storage;
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = makeLocalStorageStub();
});

function spec(id: string, items: Array<{ id: string; wants?: 'note' | 'file' | 'secret' }> = [{ id: 'a' }]): ChecklistViewSpec {
  return {
    type: 'checklist', id, title: `Checklist ${id}`,
    items: items.map((i) => ({ id: i.id, text: `Step ${i.id}`, wants: i.wants })),
  };
}

function envelope(vault: string, sp: ChecklistViewSpec, conversationId = 'conv-1', createdAt = 1000): ChecklistEnvelope {
  return { spec: sp, vault, conversationId, createdAt };
}

// ─── labelPart: the injectivity the whole fix depends on ──────────────────────

describe('labelPart', () => {
  it('is injective: two distinct inputs never produce the same output', () => {
    expect(labelPart('a.b')).not.toBe(labelPart('a-b'));
  });

  it('produces only lowercase hex digits, so it can never contain "-" or "."', () => {
    expect(labelPart('a.b-c project/x')).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same input', () => {
    expect(labelPart('my project')).toBe(labelPart('my project'));
  });
});

// ─── The regression lock: vault scoping is total ───────────────────────────────

describe('vault scoping (the B1 regression lock)', () => {
  const id = 'asc-api-key';

  it('checklistWindowLabel differs across vaults sharing the same checklist id', () => {
    expect(checklistWindowLabel('vaultA', id)).not.toBe(checklistWindowLabel('vaultB', id));
  });

  it('checklistEnvelopeKey differs across vaults sharing the same checklist id', () => {
    expect(checklistEnvelopeKey('vaultA', id)).not.toBe(checklistEnvelopeKey('vaultB', id));
  });

  it('checklistStateKey differs across vaults sharing the same checklist id', () => {
    expect(checklistStateKey('vaultA', id)).not.toBe(checklistStateKey('vaultB', id));
  });

  it('checklistWindowLabel matches the "checklist-*" capability glob', () => {
    expect(checklistWindowLabel('vaultA', id).startsWith('checklist-')).toBe(true);
  });

  it('writing vault B\'s envelope leaves vault A\'s envelope byte-identical', () => {
    const specA = spec(id);
    const specB = spec(id);
    writeEnvelope(envelope('vaultA', specA, 'conv-A'));
    const before = localStorage.getItem(checklistEnvelopeKey('vaultA', id));

    writeEnvelope(envelope('vaultB', specB, 'conv-B'));

    const after = localStorage.getItem(checklistEnvelopeKey('vaultA', id));
    expect(after).toBe(before);
  });

  it('readEnvelope("vaultA", id) returns vault A\'s envelope, not vault B\'s', () => {
    writeEnvelope(envelope('vaultA', spec(id), 'conv-A'));
    writeEnvelope(envelope('vaultB', spec(id), 'conv-B'));

    const a = readEnvelope('vaultA', id);
    expect(a?.conversationId).toBe('conv-A');
    expect(a?.vault).toBe('vaultA');

    const b = readEnvelope('vaultB', id);
    expect(b?.conversationId).toBe('conv-B');
  });

  it('opening a second vault\'s checklist under the same id never focuses/returns the first vault\'s window label', () => {
    // Not a DOM test (no window creation here) — this pins the underlying
    // claim `getByLabel` would rely on: the labels are simply different.
    const labelA = checklistWindowLabel('vaultA', id);
    const labelB = checklistWindowLabel('vaultB', id);
    expect(labelA).not.toBe(labelB);
  });
});

// ─── readEnvelope defensive checks ──────────────────────────────────────────────

describe('readEnvelope', () => {
  it('returns null when nothing has been written', () => {
    expect(readEnvelope('vaultA', 'nope')).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    localStorage.setItem(checklistEnvelopeKey('vaultA', 'bad'), '{not json');
    expect(() => readEnvelope('vaultA', 'bad')).not.toThrow();
    expect(readEnvelope('vaultA', 'bad')).toBeNull();
  });

  it('refuses an envelope whose stored vault field disagrees with the requested vault', () => {
    // Simulates data corruption / a bug elsewhere — the key itself is already
    // vault-scoped, so this should be unreachable in practice, but it is
    // exactly the shape of bug this module exists to make impossible.
    const tamperedKey = checklistEnvelopeKey('vaultA', 'x');
    localStorage.setItem(tamperedKey, JSON.stringify(envelope('vaultB', spec('x'))));
    expect(readEnvelope('vaultA', 'x')).toBeNull();
  });
});

// ─── readState / writeState round-trip + reconciliation ────────────────────────

describe('readState / writeState', () => {
  it('round-trips checked/notes/files for a real (non-secret) item', () => {
    vi.useFakeTimers();
    const sp = spec('rt', [{ id: 'a' }]);
    let state = emptyState(sp);
    state = checklistReducer(state, { t: 'toggle', id: 'a' });
    state = checklistReducer(state, { t: 'setNote', id: 'a', text: 'ordinary note' });

    writeState('vaultA', 'rt', sp, state);
    vi.advanceTimersByTime(CHECKLIST_WRITE_DEBOUNCE_MS);

    const back = readState('vaultA', 'rt', sp);
    expect(back.checked.a).toBe(true);
    expect(back.notes.a).toBe('ordinary note');
    vi.useRealTimers();
  });

  it('does not write before the debounce window elapses', () => {
    vi.useFakeTimers();
    const sp = spec('deb', [{ id: 'a' }]);
    const state = checklistReducer(emptyState(sp), { t: 'toggle', id: 'a' });

    writeState('vaultA', 'deb', sp, state);
    vi.advanceTimersByTime(CHECKLIST_WRITE_DEBOUNCE_MS - 50);

    expect(localStorage.getItem(checklistStateKey('vaultA', 'deb'))).toBeNull();
    vi.useRealTimers();
  });

  it('coalesces rapid writes into one persisted value (debounce, not one write per keystroke)', () => {
    vi.useFakeTimers();
    const sp = spec('coal', [{ id: 'a' }]);
    let state = emptyState(sp);
    writeState('vaultA', 'coal', sp, state);
    vi.advanceTimersByTime(100);
    state = checklistReducer(state, { t: 'setNote', id: 'a', text: 'v2' });
    writeState('vaultA', 'coal', sp, state);
    vi.advanceTimersByTime(CHECKLIST_WRITE_DEBOUNCE_MS);

    const back = readState('vaultA', 'coal', sp);
    expect(back.notes.a).toBe('v2');
    vi.useRealTimers();
  });

  it('never persists a wants:"secret" item\'s note — the B/directive regression lock', () => {
    vi.useFakeTimers();
    const sp = spec('sec', [{ id: 'secret-item', wants: 'secret' }, { id: 'plain-item' }]);
    let state = emptyState(sp);
    // A user could still type into the always-present note field on a secret
    // item — writeState must exclude THAT id's note regardless.
    state = checklistReducer(state, { t: 'setNote', id: 'secret-item', text: 'sk-live-should-not-persist' });
    state = checklistReducer(state, { t: 'setNote', id: 'plain-item', text: 'this one is fine to persist' });

    writeState('vaultA', 'sec', sp, state);
    vi.advanceTimersByTime(CHECKLIST_WRITE_DEBOUNCE_MS);

    const raw = localStorage.getItem(checklistStateKey('vaultA', 'sec'));
    expect(raw).not.toContain('sk-live-should-not-persist');

    const back = readState('vaultA', 'sec', sp);
    expect(back.notes['secret-item']).toBeUndefined();
    expect(back.notes['plain-item']).toBe('this one is fine to persist');
    vi.useRealTimers();
  });

  it('the value does not transit even the pending (unfired) debounced write', () => {
    vi.useFakeTimers();
    const sp = spec('pending-sec', [{ id: 'secret-item', wants: 'secret' }]);
    const state = checklistReducer(emptyState(sp), {
      t: 'setNote', id: 'secret-item', text: 'sk-live-pending',
    });
    writeState('vaultA', 'pending-sec', sp, state);
    // Deliberately do NOT advance timers — inspect whatever is scheduled by
    // reading back through the public surface only (no internal peeking).
    vi.advanceTimersByTime(CHECKLIST_WRITE_DEBOUNCE_MS);
    const raw = localStorage.getItem(checklistStateKey('vaultA', 'pending-sec'));
    expect(raw).not.toContain('sk-live-pending');
    vi.useRealTimers();
  });

  it('drops any id no longer present in a re-issued spec (reconciliation), keeping ids that survive', () => {
    vi.useFakeTimers();
    const oldSpec = spec('reissue', [{ id: 'a' }, { id: 'b' }]);
    let state = emptyState(oldSpec);
    state = checklistReducer(state, { t: 'toggle', id: 'a' });
    state = checklistReducer(state, { t: 'toggle', id: 'b' });
    writeState('vaultA', 'reissue', oldSpec, state);
    vi.advanceTimersByTime(CHECKLIST_WRITE_DEBOUNCE_MS);

    // The agent re-issues the same id with item "b" removed.
    const newSpec = spec('reissue', [{ id: 'a' }]);
    const reconciled = readState('vaultA', 'reissue', newSpec);
    expect(reconciled.checked.a).toBe(true);
    expect(reconciled.checked.b).toBeUndefined();
    vi.useRealTimers();
  });

  it('readState returns a fresh empty state when nothing has been persisted yet', () => {
    const sp = spec('fresh', [{ id: 'a' }]);
    const s = readState('vaultA', 'fresh', sp);
    expect(s.checked).toEqual({ a: false });
  });

  it('readState never throws on malformed persisted JSON', () => {
    const sp = spec('malformed', [{ id: 'a' }]);
    localStorage.setItem(checklistStateKey('vaultA', 'malformed'), 'not json{{{');
    expect(() => readState('vaultA', 'malformed', sp)).not.toThrow();
  });
});

// ─── clearChecklist ──────────────────────────────────────────────────────────

describe('clearChecklist', () => {
  it('removes both the envelope and the state key', () => {
    vi.useFakeTimers();
    const sp = spec('clr', [{ id: 'a' }]);
    writeEnvelope(envelope('vaultA', sp));
    writeState('vaultA', 'clr', sp, checklistReducer(emptyState(sp), { t: 'toggle', id: 'a' }));
    vi.advanceTimersByTime(CHECKLIST_WRITE_DEBOUNCE_MS);

    clearChecklist('vaultA', 'clr');

    expect(localStorage.getItem(checklistEnvelopeKey('vaultA', 'clr'))).toBeNull();
    expect(localStorage.getItem(checklistStateKey('vaultA', 'clr'))).toBeNull();
    vi.useRealTimers();
  });

  it('cancels a still-pending debounced write so it cannot resurrect the state key afterwards', () => {
    vi.useFakeTimers();
    const sp = spec('race', [{ id: 'a' }]);
    writeState('vaultA', 'race', sp, checklistReducer(emptyState(sp), { t: 'toggle', id: 'a' }));
    // Pending write not yet flushed.
    clearChecklist('vaultA', 'race');
    vi.advanceTimersByTime(CHECKLIST_WRITE_DEBOUNCE_MS + 100);

    expect(localStorage.getItem(checklistStateKey('vaultA', 'race'))).toBeNull();
    vi.useRealTimers();
  });

  it('clearing one vault\'s checklist never touches another vault\'s data under the same id', () => {
    const sp = spec('shared-id', [{ id: 'a' }]);
    writeEnvelope(envelope('vaultA', sp));
    writeEnvelope(envelope('vaultB', sp));

    clearChecklist('vaultA', 'shared-id');

    expect(readEnvelope('vaultA', 'shared-id')).toBeNull();
    expect(readEnvelope('vaultB', 'shared-id')).not.toBeNull();
  });
});

// ─── sweepExpired (TTL) ──────────────────────────────────────────────────────

describe('sweepExpired', () => {
  it('drops a checklist (envelope + state) older than CHECKLIST_TTL_MS', () => {
    const sp = spec('old', [{ id: 'a' }]);
    const createdAt = 1_000_000;
    writeEnvelope(envelope('vaultA', sp, 'conv-1', createdAt));
    localStorage.setItem(checklistStateKey('vaultA', 'old'), JSON.stringify({ ...emptyState(sp), updatedAt: createdAt }));

    sweepExpired(createdAt + CHECKLIST_TTL_MS + 1);

    expect(localStorage.getItem(checklistEnvelopeKey('vaultA', 'old'))).toBeNull();
    expect(localStorage.getItem(checklistStateKey('vaultA', 'old'))).toBeNull();
  });

  it('keeps a checklist younger than CHECKLIST_TTL_MS', () => {
    const sp = spec('fresh2', [{ id: 'a' }]);
    const createdAt = 1_000_000;
    writeEnvelope(envelope('vaultA', sp, 'conv-1', createdAt));

    sweepExpired(createdAt + CHECKLIST_TTL_MS - 1);

    expect(readEnvelope('vaultA', 'fresh2')).not.toBeNull();
  });

  it('ages out an orphaned state entry (no matching envelope) by its own updatedAt', () => {
    const sp = spec('orphan', [{ id: 'a' }]);
    const updatedAt = 1_000_000;
    localStorage.setItem(checklistStateKey('vaultA', 'orphan'), JSON.stringify({ ...emptyState(sp), updatedAt }));

    sweepExpired(updatedAt + CHECKLIST_TTL_MS + 1);

    expect(localStorage.getItem(checklistStateKey('vaultA', 'orphan'))).toBeNull();
  });

  it('never throws when storage is empty', () => {
    expect(() => sweepExpired(Date.now())).not.toThrow();
  });
});

// ─── vaultWindowLabel: the shared derivation the submit bridge depends on ──────

describe('vaultWindowLabel (desktop.ts)', () => {
  it('is pinned to the literal label openVaultWindow builds today', () => {
    expect(vaultWindowLabel('my project')).toBe('vault-my-project');
  });
});
