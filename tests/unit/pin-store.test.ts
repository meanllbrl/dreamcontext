/**
 * Unit tests for `pinStore.ts` — and specifically the REGRESSION LOCK this module inherited
 * from `checklistStore.ts`: `localStorage` is shared across every open project (one server,
 * one port, one origin — see that file's header), so a key that does not carry the vault
 * lets two unrelated projects read each other's state.
 *
 * The falsy-scope case is tested as hard as the cross-vault one, because it is the same bug
 * wearing a different hat: `labelPart('')` is `''`, so an unscoped write would collapse every
 * project onto ONE key. Absence is the only safe reading of an unscoped call.
 *
 * There is no jsdom in this repo (root vitest runs under plain Node), so `localStorage` is a
 * minimal in-memory stub implementing the real `Storage` surface — including `key`/`length`,
 * which `sweepExpiredPins` actually iterates.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  pinStoreKey, readPins, writePins, clearPins, sweepExpiredPins, flushPendingPins,
  PIN_TTL_MS, PIN_WRITE_DEBOUNCE_MS, type PinEnvelope,
} from '../../dashboard/src/lib/pinStore.js';
import type { ShelfEntry } from '../../dashboard/src/lib/shelfModel.js';

const repoFile = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf-8');

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

const entry = (id: string): ShelfEntry =>
  ({ kind: 'pin', id, weight: 'tag', facts: [{ label: id }], updatedAt: 1 });

/** `writePins` debounces, so every test that asserts on storage flushes first. */
function flush(): void {
  vi.useFakeTimers();
  vi.advanceTimersByTime(PIN_WRITE_DEBOUNCE_MS + 10);
  vi.useRealTimers();
}

/** Write + flush in one step, with fake timers held for the whole window. */
function persist(vault: string, conv: string, entries: ShelfEntry[], now = 1000): void {
  vi.useFakeTimers();
  writePins(vault, conv, entries, now);
  vi.advanceTimersByTime(PIN_WRITE_DEBOUNCE_MS + 10);
  vi.useRealTimers();
}

describe('pinStoreKey — scoping', () => {
  it('is different for the same conversation id in two vaults', () => {
    expect(pinStoreKey('vaultA', 'conv-1')).not.toBe(pinStoreKey('vaultB', 'conv-1'));
  });

  it('is different for two conversations in one vault', () => {
    expect(pinStoreKey('vaultA', 'conv-1')).not.toBe(pinStoreKey('vaultA', 'conv-2'));
  });

  it('cannot be forged by moving the boundary between the two parts', () => {
    // The classic composite-key collision: "a" + "b.c" vs "a.b" + "c". Hex encoding makes
    // every part `[0-9a-f]`, so neither part can ever contain the "." they are joined on.
    expect(pinStoreKey('a', 'b.c')).not.toBe(pinStoreKey('a.b', 'c'));
  });
});

describe('cross-vault isolation', () => {
  it('never lets one vault read another vault’s pins for the same conversation id', () => {
    persist('vaultA', 'conv-1', [entry('secret')]);
    expect(readPins('vaultA', 'conv-1').map((e) => e.id)).toEqual(['secret']);
    expect(readPins('vaultB', 'conv-1')).toEqual([]);
  });

  it('treats a TAMPERED envelope as absent rather than trusting the key', () => {
    // Same shape, wrong vault inside — the key already scopes, but the envelope is checked
    // too, because a mismatch is exactly the bug this module exists to make unrepresentable.
    const forged: PinEnvelope = {
      v: 1, vault: 'vaultB', conversationId: 'conv-1', entries: [entry('x')], updatedAt: 1,
    };
    localStorage.setItem(pinStoreKey('vaultA', 'conv-1'), JSON.stringify(forged));
    expect(readPins('vaultA', 'conv-1')).toEqual([]);
  });

  it('treats a wrong conversationId inside the envelope as absent', () => {
    const forged: PinEnvelope = {
      v: 1, vault: 'vaultA', conversationId: 'other', entries: [entry('x')], updatedAt: 1,
    };
    localStorage.setItem(pinStoreKey('vaultA', 'conv-1'), JSON.stringify(forged));
    expect(readPins('vaultA', 'conv-1')).toEqual([]);
  });

  it('treats malformed JSON and a missing entries array as absent', () => {
    localStorage.setItem(pinStoreKey('vaultA', 'bad'), '{not json');
    expect(readPins('vaultA', 'bad')).toEqual([]);
    localStorage.setItem(pinStoreKey('vaultA', 'noarr'),
      JSON.stringify({ v: 1, vault: 'vaultA', conversationId: 'noarr', updatedAt: 1 }));
    expect(readPins('vaultA', 'noarr')).toEqual([]);
  });
});

describe('falsy scope — the labelPart("") hole', () => {
  it('reads nothing when the vault or the conversation is empty', () => {
    expect(readPins('', 'conv-1')).toEqual([]);
    expect(readPins('vaultA', '')).toEqual([]);
    expect(readPins('', '')).toEqual([]);
  });

  it('WRITES nothing when the vault or the conversation is empty', () => {
    persist('', 'conv-1', [entry('x')]);
    persist('vaultA', '', [entry('x')]);
    expect(localStorage.length).toBe(0);
  });

  it('clears nothing when unscoped', () => {
    persist('vaultA', 'conv-1', [entry('keep')]);
    clearPins('', 'conv-1');
    expect(readPins('vaultA', 'conv-1')).toHaveLength(1);
  });
});

describe('write / read / clear', () => {
  it('round-trips the entries', () => {
    const entries = [entry('a'), entry('b')];
    persist('vaultA', 'conv-1', entries);
    expect(readPins('vaultA', 'conv-1')).toEqual(entries);
  });

  it('DEBOUNCES the write — nothing is stored until the window elapses', () => {
    vi.useFakeTimers();
    writePins('vaultA', 'conv-1', [entry('a')], 1000);
    vi.advanceTimersByTime(PIN_WRITE_DEBOUNCE_MS - 50);
    expect(localStorage.getItem(pinStoreKey('vaultA', 'conv-1'))).toBeNull();
    vi.advanceTimersByTime(100);
    expect(localStorage.getItem(pinStoreKey('vaultA', 'conv-1'))).not.toBeNull();
    vi.useRealTimers();
  });

  it('coalesces a burst into ONE write carrying the last value', () => {
    vi.useFakeTimers();
    writePins('vaultA', 'conv-1', [entry('first')], 1000);
    writePins('vaultA', 'conv-1', [entry('second')], 1001);
    writePins('vaultA', 'conv-1', [entry('third')], 1002);
    vi.advanceTimersByTime(PIN_WRITE_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(readPins('vaultA', 'conv-1').map((e) => e.id)).toEqual(['third']);
  });

  it('clearPins cancels a pending write instead of letting it land afterwards', () => {
    vi.useFakeTimers();
    writePins('vaultA', 'conv-1', [entry('a')], 1000);
    clearPins('vaultA', 'conv-1');
    vi.advanceTimersByTime(PIN_WRITE_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(readPins('vaultA', 'conv-1')).toEqual([]);
  });

  it('stores an explicitly-shaped envelope, never a spread of the caller’s object', () => {
    persist('vaultA', 'conv-1', [entry('a')], 4242);
    const raw = JSON.parse(localStorage.getItem(pinStoreKey('vaultA', 'conv-1')) as string);
    expect(Object.keys(raw).sort()).toEqual(['conversationId', 'entries', 'updatedAt', 'v', 'vault']);
    expect(raw.updatedAt).toBe(4242);
  });
});

describe('readPins — entry-level validation (storage is INPUT, not private memory)', () => {
  /** Write an envelope whose `entries` are whatever we say, bypassing `writePins`. */
  function plant(entries: unknown[]): void {
    localStorage.setItem(pinStoreKey('vaultA', 'conv-1'), JSON.stringify({
      v: 1, vault: 'vaultA', conversationId: 'conv-1', entries, updatedAt: Date.now(),
    }));
  }

  it('DROPS a malformed entry and still renders the rest — healed, not all-or-nothing', () => {
    plant([entry('good-1'), { kind: 'pin' /* no id, no updatedAt */ }, entry('good-2')]);
    expect(readPins('vaultA', 'conv-1').map((e) => e.id)).toEqual(['good-1', 'good-2']);
  });

  it('drops entries with a bad kind, id, weight or updatedAt', () => {
    plant([
      { kind: 'mystery', id: 'a', updatedAt: 1 },
      { kind: 'pin', id: '', weight: 'tag', facts: [], updatedAt: 1 },
      { kind: 'pin', id: 'a', weight: 'enormous', facts: [], updatedAt: 1 },
      { kind: 'pin', id: 'a', weight: 'tag', facts: [], updatedAt: 'soon' },
      null, 42, 'nope', [],
    ]);
    expect(readPins('vaultA', 'conv-1')).toEqual([]);
  });

  it('heals a pin whose facts array is corrupt rather than dropping the pin', () => {
    plant([{ kind: 'pin', id: 'p', weight: 'tag', updatedAt: 1, facts: [{ label: 'ok' }, null, { url: 'x' }] }]);
    const [pin] = readPins('vaultA', 'conv-1');
    expect(pin.kind === 'pin' && pin.facts).toEqual([{ label: 'ok' }]);
  });

  it('treats a non-array facts field as no facts, not as a crash', () => {
    plant([{ kind: 'pin', id: 'p', weight: 'tag', updatedAt: 1, facts: 'nope' }]);
    expect(readPins('vaultA', 'conv-1')[0]).toEqual({ kind: 'pin', id: 'p', weight: 'tag', facts: [], updatedAt: 1 });
  });

  it('rebuilds field-by-field so an injected extra property cannot ride back in', () => {
    plant([{ kind: 'pin', id: 'p', weight: 'tag', facts: [], updatedAt: 1, evil: '<script>' }]);
    expect(readPins('vaultA', 'conv-1')[0]).not.toHaveProperty('evil');
  });

  it('keeps a well-formed progress entry', () => {
    plant([{ kind: 'progress', id: 'progress:t', task: 't', updatedAt: 7 }]);
    expect(readPins('vaultA', 'conv-1')).toEqual([{ kind: 'progress', id: 'progress:t', task: 't', updatedAt: 7 }]);
  });
});

describe('flushPendingPins — the debounce must not eat the last write before a close', () => {
  it('lands a pending write immediately instead of losing it', () => {
    vi.useFakeTimers();
    writePins('vaultA', 'conv-1', [entry('late')], 1000);
    expect(localStorage.getItem(pinStoreKey('vaultA', 'conv-1')), 'wrote before the debounce elapsed').toBeNull();
    flushPendingPins();
    vi.useRealTimers();
    expect(readPins('vaultA', 'conv-1').map((e) => e.id)).toEqual(['late']);
  });

  it('cancels the pending timer, so the flushed write is not repeated', () => {
    vi.useFakeTimers();
    writePins('vaultA', 'conv-1', [entry('once')], 1000);
    flushPendingPins();
    clearPins('vaultA', 'conv-1');            // as a close would, right after the flush
    vi.advanceTimersByTime(PIN_WRITE_DEBOUNCE_MS + 50);
    vi.useRealTimers();
    expect(readPins('vaultA', 'conv-1')).toEqual([]);
  });

  it('is a no-op with nothing pending', () => {
    expect(() => flushPendingPins()).not.toThrow();
  });
});

/**
 * The defect this file's store was found to have was NOT a logic bug — every function below
 * was correct and tested. It was that two of them were never CALLED, so the store grew
 * without bound against a quota shared with every other project on this origin. A unit test
 * cannot reach `main.tsx`'s boot side effect (importing it would mount React), so the wiring
 * is pinned by reading the source: crude, but it fails the moment someone deletes the call,
 * which is exactly the regression that already happened once.
 */
describe('the sweeps are actually WIRED (the defect was an uncalled function)', () => {
  const boot = repoFile('dashboard/src/main.tsx');

  it('main.tsx calls the pin sweep at boot', () => {
    expect(boot).toContain('sweepExpiredPins');
  });

  it('main.tsx calls the checklist sweep at the same site', () => {
    expect(boot).toContain('sweepExpired');
  });

  it('the close path clears a chat tab’s pins', () => {
    const surface = repoFile('dashboard/src/components/sleepy/AgentSurface.tsx');
    expect(surface).toContain('clearPins');
  });
});

describe('sweepExpiredPins', () => {
  it('drops a conversation past the TTL and keeps a fresh one', () => {
    persist('vaultA', 'old', [entry('a')], 1000);
    persist('vaultA', 'new', [entry('b')], 1000 + PIN_TTL_MS);
    sweepExpiredPins(1000 + PIN_TTL_MS + 1);
    expect(readPins('vaultA', 'old')).toEqual([]);
    expect(readPins('vaultA', 'new')).toHaveLength(1);
  });

  it('drops an unparseable entry of its own, which could never be read back anyway', () => {
    localStorage.setItem(pinStoreKey('vaultA', 'junk'), '{not json');
    sweepExpiredPins(Date.now());
    expect(localStorage.getItem(pinStoreKey('vaultA', 'junk'))).toBeNull();
  });

  it('NEVER touches another module’s keys — it owns its prefix and nothing else', () => {
    localStorage.setItem('dc.checklist.env.v1.aa.bb', '{"createdAt":0}');
    localStorage.setItem('agent:settings:chatPermissionMode', 'bypass');
    persist('vaultA', 'old', [entry('a')], 1000);
    sweepExpiredPins(1000 + PIN_TTL_MS + 1);
    expect(localStorage.getItem('dc.checklist.env.v1.aa.bb')).not.toBeNull();
    expect(localStorage.getItem('agent:settings:chatPermissionMode')).toBe('bypass');
    expect(readPins('vaultA', 'old')).toEqual([]);
  });
});
