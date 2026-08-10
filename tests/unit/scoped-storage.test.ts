/**
 * Unit tests for `scopedStorage.ts` — the per-project localStorage namespace that one
 * window holding N live projects depends on. Two things are load-bearing and locked here:
 * a null vault must behave EXACTLY as the app did before scoping existed (the launcher and
 * the plain browser build read the legacy key verbatim), and the legacy→scoped migration
 * must be a MOVE that happens at most once, because the second project to read a legacy key
 * inheriting the first project's value is precisely the cross-project bug this module exists
 * to prevent.
 *
 * There is no jsdom/happy-dom in this repo (root vitest runs under plain Node), so
 * `localStorage` is shimmed with a minimal in-memory object implementing the real `Storage`
 * surface. The module's migration latch is a module-level Set that survives between tests in
 * this file, so every test uses its OWN vault/key names rather than trying to reset it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SCOPE_PREFIX, scopedKey,
  readScopedRaw, writeScopedRaw, readScoped, writeScoped, removeScoped,
} from '../../dashboard/src/lib/scopedStorage.js';

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

// ─── key shape ────────────────────────────────────────────────────────────────

describe('scopedKey', () => {
  it('a null vault yields the LEGACY key verbatim — never a prefixed one', () => {
    expect(scopedKey(null, 'dreamcontext.dashboard.activePage')).toBe('dreamcontext.dashboard.activePage');
    expect(scopedKey(null, 'x')).not.toContain(SCOPE_PREFIX);
  });

  it('a real vault yields `dreamcontext:<vault>:<key>`', () => {
    expect(scopedKey('alpha', 'activePage')).toBe(`${SCOPE_PREFIX}alpha:activePage`);
  });

  it('two vaults never share a key', () => {
    expect(scopedKey('alpha', 'k')).not.toBe(scopedKey('beta', 'k'));
  });

  it('an empty vault name counts as no vault (`?vault=` with no value is launcher mode)', () => {
    expect(scopedKey('', 'k')).toBe('k');
  });
});

// ─── null vault: byte-identical to pre-scoping behaviour ──────────────────────

describe('a null vault touches only the legacy key', () => {
  it('reads and writes the bare key, and migrates nothing', () => {
    localStorage.setItem('legacy.null.k', 'from-before');
    expect(readScopedRaw(null, 'legacy.null.k')).toBe('from-before');

    writeScopedRaw(null, 'legacy.null.k', 'updated');
    expect(localStorage.getItem('legacy.null.k')).toBe('updated');
    expect(localStorage.getItem(`${SCOPE_PREFIX}:legacy.null.k`)).toBeNull();
  });
});

// ─── migration: a MOVE, once, to the first reader ─────────────────────────────

describe('legacy → scoped migration', () => {
  it('copies the legacy value into the scoped key AND deletes the legacy key', () => {
    localStorage.setItem('mig.move', '1');

    expect(readScopedRaw('alpha', 'mig.move')).toBe('1');
    expect(localStorage.getItem(scopedKey('alpha', 'mig.move'))).toBe('1');
    expect(localStorage.getItem('mig.move')).toBeNull();
  });

  it('the SECOND vault gets the fallback — it must not inherit the first project value', () => {
    localStorage.setItem('mig.first-wins', 'alpha-owned');

    expect(readScopedRaw('alpha', 'mig.first-wins')).toBe('alpha-owned');
    expect(readScopedRaw('beta', 'mig.first-wins')).toBeNull();
    expect(readScoped('beta', 'mig.first-wins', 'fallback')).toBe('fallback');
  });

  it('never overwrites an existing scoped value with a stale legacy one', () => {
    localStorage.setItem(scopedKey('alpha', 'mig.no-clobber'), 'mine');
    localStorage.setItem('mig.no-clobber', 'stale');

    expect(readScopedRaw('alpha', 'mig.no-clobber')).toBe('mine');
  });

  it('runs at most once per vault+key: a legacy value re-appearing later is ignored', () => {
    localStorage.setItem('mig.once', 'original');
    expect(readScopedRaw('alpha', 'mig.once')).toBe('original');

    // Recreate the exact pre-migration state, bypassing the module so only the latch can
    // stop a second migration.
    localStorage.removeItem(scopedKey('alpha', 'mig.once'));
    localStorage.setItem('mig.once', 'resurrected');

    expect(readScopedRaw('alpha', 'mig.once')).toBeNull();
    expect(localStorage.getItem('mig.once')).toBe('resurrected');
  });

  it('keepLegacy copies without deleting, so every vault seeds from the same value', () => {
    localStorage.setItem('mig.keep', '0');

    expect(readScopedRaw('alpha', 'mig.keep', { keepLegacy: true })).toBe('0');
    expect(localStorage.getItem('mig.keep')).toBe('0');
    expect(readScopedRaw('beta', 'mig.keep', { keepLegacy: true })).toBe('0');
  });
});

// ─── raw and JSON layers ──────────────────────────────────────────────────────

describe('raw and JSON layers', () => {
  it('agree: the JSON layer is exactly JSON over the raw pair', () => {
    writeScoped('alpha', 'layers.json', { page: 'tasks', n: 2 });

    expect(readScopedRaw('alpha', 'layers.json')).toBe(JSON.stringify({ page: 'tasks', n: 2 }));
    expect(readScoped('alpha', 'layers.json', null)).toEqual({ page: 'tasks', n: 2 });
  });

  it('migrates a JSON value through the same raw code path', () => {
    localStorage.setItem('layers.migrated', JSON.stringify(['a', 'b']));

    expect(readScoped('alpha', 'layers.migrated', [])).toEqual(['a', 'b']);
    expect(localStorage.getItem('layers.migrated')).toBeNull();
  });

  it('corrupt JSON falls back instead of throwing into a render', () => {
    writeScopedRaw('alpha', 'layers.corrupt', '{not json');

    expect(readScoped('alpha', 'layers.corrupt', 'fallback')).toBe('fallback');
  });

  it('an unset key falls back', () => {
    expect(readScoped('alpha', 'layers.absent', 42)).toBe(42);
    expect(readScopedRaw('alpha', 'layers.absent')).toBeNull();
  });
});

// ─── remove ───────────────────────────────────────────────────────────────────

describe('removeScoped', () => {
  it('deletes the scoped value', () => {
    writeScopedRaw('alpha', 'rm.plain', 'v');
    removeScoped('alpha', 'rm.plain');

    expect(readScopedRaw('alpha', 'rm.plain')).toBeNull();
  });

  it('consumes the legacy key too, so the next read cannot resurrect what was deleted', () => {
    localStorage.setItem('rm.legacy', 'from-before');

    removeScoped('alpha', 'rm.legacy');

    expect(readScopedRaw('alpha', 'rm.legacy')).toBeNull();
    expect(localStorage.getItem('rm.legacy')).toBeNull();
  });
});

// ─── storage that throws (private mode / quota) ───────────────────────────────

describe('unavailable storage', () => {
  beforeEach(() => {
    const throwing = {
      getItem: () => { throw new Error('localStorage unavailable'); },
      setItem: () => { throw new Error('localStorage unavailable'); },
      removeItem: () => { throw new Error('localStorage unavailable'); },
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    (globalThis as unknown as { localStorage: Storage }).localStorage = throwing;
  });

  it('reads fall back and writes are swallowed — never a throw into a render', () => {
    expect(() => writeScopedRaw('alpha', 'boom', 'v')).not.toThrow();
    expect(() => writeScoped('alpha', 'boom', { a: 1 })).not.toThrow();
    expect(() => removeScoped('alpha', 'boom')).not.toThrow();
    expect(readScopedRaw('alpha', 'boom')).toBeNull();
    expect(readScoped('alpha', 'boom', 'fallback')).toBe('fallback');
  });
});
