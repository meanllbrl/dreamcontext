import { describe, it, expect, afterEach } from 'vitest';
import {
  parseAnnouncements,
  unreadAnnouncements,
  readSeenIds,
  writeSeenIds,
  markAllSeen,
  ANNOUNCEMENTS_SEEN_STORAGE_KEY,
  type Announcement,
} from '../../dashboard/src/lib/announcements.js';

/**
 * Unit tests for the Announcements / What's New pure data layer.
 *
 * announcements.ts guards every localStorage touch behind `typeof window ===
 * 'undefined'` (SSR-safe, mirroring Sidebar.tsx's readFlag/writeFlag). The
 * default vitest environment here is plain node — no `window` global exists —
 * so exercising the localStorage-backed functions requires installing a fake
 * `globalThis.window.localStorage` per test and removing it afterwards.
 */

function makeAnnouncement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: 'a1',
    date: '2026-01-01',
    title: 'Title',
    summary: 'Summary',
    board: 'a1.excalidraw.md',
    ...overrides,
  };
}

// Minimal surface announcements.ts actually calls: getItem/setItem.
interface FakeLocalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function installFakeWindow(store: Record<string, string> = {}): FakeLocalStorage {
  const storage: FakeLocalStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = value;
    },
  };
  (globalThis as unknown as { window: { localStorage: FakeLocalStorage } }).window = {
    localStorage: storage,
  };
  return storage;
}

function installThrowingWindow(): void {
  const storage: FakeLocalStorage = {
    getItem: () => {
      throw new Error('localStorage unavailable');
    },
    setItem: () => {
      throw new Error('localStorage unavailable');
    },
  };
  (globalThis as unknown as { window: { localStorage: FakeLocalStorage } }).window = {
    localStorage: storage,
  };
}

function uninstallWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

afterEach(() => {
  uninstallWindow();
});

describe('parseAnnouncements', () => {
  it('parses a valid array of announcements', () => {
    const raw = [makeAnnouncement({ id: 'x', date: '2026-01-01' })];
    expect(parseAnnouncements(raw)).toEqual(raw);
  });

  it('preserves optional version/tags when present and well-formed', () => {
    const raw = [makeAnnouncement({ version: '0.19.0', tags: ['goal-skill', 'orchestration'] })];
    expect(parseAnnouncements(raw)).toEqual(raw);
  });

  it('drops malformed optional fields but keeps the entry', () => {
    const raw = [{ ...makeAnnouncement(), version: 42, tags: ['ok', 7] }];
    const result = parseAnnouncements(raw);
    expect(result).toHaveLength(1);
    expect(result[0].version).toBeUndefined();
    expect(result[0].tags).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['HTML string (SPA fallback / 404-as-text)', '<!doctype html><html></html>'],
    ['number', 42],
  ])('returns [] and never throws for non-array input: %s', (_label, input) => {
    expect(() => parseAnnouncements(input)).not.toThrow();
    expect(parseAnnouncements(input)).toEqual([]);
  });

  it('drops entries missing any required field', () => {
    const valid = makeAnnouncement({ id: 'valid' });
    const raw = [
      valid,
      { ...makeAnnouncement({ id: 'no-date' }), date: undefined },
      { ...makeAnnouncement({ id: 'no-title' }), title: undefined },
      { ...makeAnnouncement({ id: 'no-summary' }), summary: undefined },
      { ...makeAnnouncement({ id: 'no-board' }), board: undefined },
      { ...makeAnnouncement(), id: '' },
      { ...makeAnnouncement(), id: undefined },
      'not an object',
      42,
      null,
    ];
    expect(parseAnnouncements(raw)).toEqual([valid]);
  });

  it('de-dupes by id, keeping the first occurrence', () => {
    const first = makeAnnouncement({ id: 'dup', title: 'First' });
    const second = makeAnnouncement({ id: 'dup', title: 'Second' });
    const result = parseAnnouncements([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('First');
  });

  it('sorts by date descending', () => {
    const oldest = makeAnnouncement({ id: 'old', date: '2026-01-01' });
    const newest = makeAnnouncement({ id: 'new', date: '2026-07-18' });
    const middle = makeAnnouncement({ id: 'mid', date: '2026-03-15' });
    const result = parseAnnouncements([oldest, newest, middle]);
    expect(result.map((a) => a.id)).toEqual(['new', 'mid', 'old']);
  });

  it('keeps source-file order for entries with equal dates (stable sort)', () => {
    const first = makeAnnouncement({ id: 'first', date: '2026-01-01' });
    const second = makeAnnouncement({ id: 'second', date: '2026-01-01' });
    const third = makeAnnouncement({ id: 'third', date: '2026-01-01' });
    const result = parseAnnouncements([first, second, third]);
    expect(result.map((a) => a.id)).toEqual(['first', 'second', 'third']);
  });
});

describe('unreadAnnouncements', () => {
  const all = [
    makeAnnouncement({ id: 'a' }),
    makeAnnouncement({ id: 'b' }),
    makeAnnouncement({ id: 'c' }),
  ];

  it('returns everything when nothing has been seen', () => {
    expect(unreadAnnouncements(all, [])).toEqual(all);
  });

  it('returns nothing when every id has been seen', () => {
    expect(unreadAnnouncements(all, all.map((a) => a.id))).toEqual([]);
  });

  it('returns only the ids not present in seen (partial overlap)', () => {
    expect(unreadAnnouncements(all, ['b'])).toEqual([all[0], all[2]]);
  });

  it('ignores unknown/stale ids in seen that no longer match any announcement', () => {
    expect(unreadAnnouncements(all, ['b', 'retired-id-from-a-deleted-entry'])).toEqual([
      all[0],
      all[2],
    ]);
  });
});

describe('readSeenIds', () => {
  it('returns [] when window is undefined (SSR / no localStorage)', () => {
    expect(readSeenIds()).toEqual([]);
  });

  it('returns [] when the key is absent', () => {
    installFakeWindow();
    expect(readSeenIds()).toEqual([]);
  });

  it('returns [] when the stored value is non-JSON', () => {
    installFakeWindow({ [ANNOUNCEMENTS_SEEN_STORAGE_KEY]: 'not json at all' });
    expect(readSeenIds()).toEqual([]);
  });

  it('returns [] when the stored value is valid JSON but not an array', () => {
    installFakeWindow({ [ANNOUNCEMENTS_SEEN_STORAGE_KEY]: JSON.stringify({ foo: 'bar' }) });
    expect(readSeenIds()).toEqual([]);
  });

  it('filters out non-string entries from a stored array', () => {
    installFakeWindow({ [ANNOUNCEMENTS_SEEN_STORAGE_KEY]: JSON.stringify(['a', 2, null, 'b']) });
    expect(readSeenIds()).toEqual(['a', 'b']);
  });

  it('returns the stored ids when well-formed', () => {
    installFakeWindow({ [ANNOUNCEMENTS_SEEN_STORAGE_KEY]: JSON.stringify(['a', 'b']) });
    expect(readSeenIds()).toEqual(['a', 'b']);
  });

  it('returns [] and never throws when localStorage.getItem throws', () => {
    installThrowingWindow();
    expect(() => readSeenIds()).not.toThrow();
    expect(readSeenIds()).toEqual([]);
  });
});

describe('writeSeenIds', () => {
  it('persists the id list under ANNOUNCEMENTS_SEEN_STORAGE_KEY', () => {
    const storage = installFakeWindow();
    writeSeenIds(['a', 'b']);
    expect(JSON.parse(storage.getItem(ANNOUNCEMENTS_SEEN_STORAGE_KEY)!)).toEqual(['a', 'b']);
  });

  it('never throws when window is undefined', () => {
    expect(() => writeSeenIds(['a'])).not.toThrow();
  });

  it('never throws when localStorage.setItem throws', () => {
    installThrowingWindow();
    expect(() => writeSeenIds(['a'])).not.toThrow();
  });
});

describe('markAllSeen', () => {
  it('writes the union of previously-seen and current ids, and returns it', () => {
    installFakeWindow({ [ANNOUNCEMENTS_SEEN_STORAGE_KEY]: JSON.stringify(['old']) });
    const all = [makeAnnouncement({ id: 'old' }), makeAnnouncement({ id: 'new' })];
    const result = markAllSeen(all);
    expect(new Set(result)).toEqual(new Set(['old', 'new']));
    expect(new Set(readSeenIds())).toEqual(new Set(['old', 'new']));
  });

  it('returns the union without throwing when localStorage throws', () => {
    installThrowingWindow();
    const all = [makeAnnouncement({ id: 'x' }), makeAnnouncement({ id: 'y' })];
    let result: string[] = [];
    expect(() => {
      result = markAllSeen(all);
    }).not.toThrow();
    expect(new Set(result)).toEqual(new Set(['x', 'y']));
  });
});
