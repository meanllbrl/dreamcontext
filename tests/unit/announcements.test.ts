import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseAnnouncementStory } from '../../dashboard/src/lib/announcementStory.js';
import {
  parseAnnouncements,
  unreadAnnouncements,
  formatVersion,
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
  const id = overrides.id ?? 'a1';
  return {
    id,
    date: '2026-01-01',
    title: 'Title',
    summary: 'Summary',
    story: 'a1.json',
    // The feed holds ONE announcement per version, so the factory gives every
    // distinct id its own version. Without that, a fixture of three entries
    // would collapse to one and quietly mask whatever the test was asserting.
    version: `0.0.0-${id}`,
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

  it('preserves optional tags when present and well-formed', () => {
    const raw = [makeAnnouncement({ version: '0.18.0', tags: ['goal-skill', 'orchestration'] })];
    expect(parseAnnouncements(raw)).toEqual(raw);
  });

  it('drops malformed tags but keeps the entry', () => {
    const raw = [{ ...makeAnnouncement(), tags: ['ok', 7] }];
    const result = parseAnnouncements(raw);
    expect(result).toHaveLength(1);
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
      { ...makeAnnouncement({ id: 'no-story' }), story: undefined },
      // `version` is required, not optional: an entry that doesn't say which
      // release it announces has no place on a version-history feed.
      { ...makeAnnouncement({ id: 'no-version' }), version: undefined },
      { ...makeAnnouncement({ id: 'blank-version' }), version: '' },
      { ...makeAnnouncement({ id: 'numeric-version' }), version: 42 },
      { ...makeAnnouncement(), id: '' },
      { ...makeAnnouncement(), id: undefined },
      'not an object',
      42,
      null,
    ];
    expect(parseAnnouncements(raw)).toEqual([valid]);
  });

  it('de-dupes by id, keeping the first occurrence', () => {
    const first = makeAnnouncement({ id: 'dup', version: '0.1.0', title: 'First' });
    const second = makeAnnouncement({ id: 'dup', version: '0.2.0', title: 'Second' });
    const result = parseAnnouncements([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('First');
  });

  // One announcement per version is the feed's core contract: a release that
  // shipped three things is three BLOCKS in one story, never three entries.
  it('keeps exactly one announcement per version', () => {
    const raw = [
      makeAnnouncement({ id: 'task-manager', version: '0.18.0', date: '2026-07-17' }),
      makeAnnouncement({ id: 'goal-skill', version: '0.18.0', date: '2026-07-18' }),
      makeAnnouncement({ id: 'highlights', version: '0.18.0', date: '2026-07-16' }),
      makeAnnouncement({ id: 'chat', version: '0.22.0', date: '2026-07-26' }),
    ];
    expect(parseAnnouncements(raw).map((a) => a.version)).toEqual(['0.22.0', '0.18.0']);
  });

  it('resolves a version collision in favour of the newest entry, whatever the file order', () => {
    const stale = makeAnnouncement({ id: 'stale', version: '0.18.0', date: '2026-07-01' });
    const current = makeAnnouncement({ id: 'current', version: '0.18.0', date: '2026-07-17' });
    // Sorting before deduping is what makes this hold for BOTH orderings —
    // which duplicate survives is a property of the content, not of the file.
    expect(parseAnnouncements([stale, current]).map((a) => a.id)).toEqual(['current']);
    expect(parseAnnouncements([current, stale]).map((a) => a.id)).toEqual(['current']);
  });

  it('treats 0.22.0 and v0.22.0 as the same release', () => {
    const bare = makeAnnouncement({ id: 'bare', version: '0.22.0', date: '2026-07-26' });
    const prefixed = makeAnnouncement({ id: 'prefixed', version: 'v0.22.0', date: '2026-07-20' });
    expect(parseAnnouncements([bare, prefixed]).map((a) => a.id)).toEqual(['bare']);
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

/**
 * Integrity of the SHIPPED feed, not just of the parser. Authoring an
 * announcement is a hand-edit of JSON in two places plus a folder of
 * screenshots, and every failure mode there is silent in the app: a duplicate
 * version quietly drops a release, a bad `story` filename falls back to the
 * manifest summary, a bad shot path renders as nothing at all.
 */
describe('the shipped announcements manifest', () => {
  const root = join(__dirname, '../../dashboard/public/announcements');
  const raw: unknown = JSON.parse(readFileSync(join(__dirname, '../../dashboard/public/announcements.json'), 'utf8'));
  const feed = parseAnnouncements(raw);

  it('has every authored entry survive parsing', () => {
    expect(feed).toHaveLength((raw as unknown[]).length);
  });

  it('announces one release per version', () => {
    const versions = feed.map((a) => formatVersion(a.version));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('names its story file after its id', () => {
    for (const a of feed) expect(a.story).toBe(`${a.id}.json`);
  });

  /** Every screenshot and clip a story points at, as asset paths. */
  function assetsOf(story: string): { shots: string[]; clips: string[]; posters: string[] } {
    const parsed = parseAnnouncementStory(JSON.parse(readFileSync(join(root, story), 'utf8')));
    const shots: string[] = [];
    const clips: string[] = [];
    const posters: string[] = [];
    if (parsed?.hero.shot) shots.push(parsed.hero.shot.src);
    if (parsed?.hero.clip) { clips.push(parsed.hero.clip.src); posters.push(parsed.hero.clip.poster); }
    for (const b of parsed?.blocks ?? []) {
      if ('shot' in b) shots.push(b.shot.src);
      if ('clip' in b) { clips.push(b.clip.src); posters.push(b.clip.poster); }
    }
    return { shots, clips, posters };
  }

  it.each(
    // `parseAnnouncements` guarantees a non-empty feed here; each entry is
    // checked as its own case so a failure names the release that broke.
    feed.map((a) => [a.id, a.story] as const),
  )('%s: story document parses and every asset it references exists', (id, story) => {
    const storyPath = join(root, story);
    expect(existsSync(storyPath), `${story} is missing`).toBe(true);
    expect(
      parseAnnouncementStory(JSON.parse(readFileSync(storyPath, 'utf8'))),
      `${story} failed story validation`,
    ).not.toBeNull();

    const { shots, clips, posters } = assetsOf(story);
    expect(shots.length + clips.length, `${id} shows nothing at all`).toBeGreaterThan(0);

    // Everything for a release lives in folders named after it: stills under
    // shots/<id>/, clips and their posters under clips/<id>/.
    for (const src of shots) {
      expect(existsSync(join(root, src)), `${id}: missing ${src}`).toBe(true);
      expect(src.startsWith(`shots/${id}/`), `${id}: ${src} is outside shots/${id}/`).toBe(true);
    }
    for (const src of [...clips, ...posters]) {
      expect(existsSync(join(root, src)), `${id}: missing ${src}`).toBe(true);
      expect(src.startsWith(`clips/${id}/`), `${id}: ${src} is outside clips/${id}/`).toBe(true);
    }
  });

  // Every byte here ships inside the npm package and the desktop app. A clip is
  // the one asset that can quietly cost megabytes, so the budget is a test
  // rather than a note somebody remembers.
  const CLIP_BUDGET_BYTES = 3 * 1024 * 1024;
  it('keeps every clip inside the shipping budget', () => {
    const oversized = feed
      .flatMap((a) => assetsOf(a.story).clips)
      .map((src) => ({ src, bytes: statSync(join(root, src)).size }))
      .filter((c) => c.bytes > CLIP_BUDGET_BYTES);
    expect(oversized).toEqual([]);
  });

  it('ships no screenshot or clip that no story references', () => {
    const referenced = new Set<string>();
    for (const a of feed) {
      const { shots, clips, posters } = assetsOf(a.story);
      for (const src of [...shots, ...clips, ...posters]) referenced.add(src);
    }

    const onDisk = ['shots', 'clips']
      .filter((dir) => existsSync(join(root, dir)))
      .flatMap((dir) =>
        readdirSync(join(root, dir), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .flatMap((sub) => readdirSync(join(root, dir, sub.name)).map((f) => `${dir}/${sub.name}/${f}`)),
      );

    expect(onDisk.filter((f) => !referenced.has(f))).toEqual([]);
  });
});

describe('formatVersion', () => {
  it.each([
    ['0.22.0', 'v0.22.0'],
    ['v0.22.0', 'v0.22.0'],
    ['V0.22.0', 'v0.22.0'],
  ])('renders %s as %s', (input, expected) => {
    expect(formatVersion(input)).toBe(expected);
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
