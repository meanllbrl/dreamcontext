/**
 * Unit tests for `attention.ts` — the "Claude is asking" alarm that a fresh question
 * fires from both session engines (chat's `pushAsk`, the terminal's `onSettle`).
 *
 * Four properties are worth locking, because all four are invisible until they're wrong:
 *
 *   1. ONE interruption PER PROJECT. Within a project, agents asking in the same breath
 *      produce one alarm rather than three of each. ACROSS projects they do not collapse:
 *      one window now holds several live projects, and two of them asking a second apart are
 *      two separate things the user has to answer — under the old single window-wide gate
 *      the second one was silently dropped. The chime is the one transport that keeps a
 *      window-wide floor, because it plays through a single shared AudioContext.
 *   2. The banner is for someone who is ELSEWHERE — and "elsewhere" now includes another
 *      CHIP in this same window. A focused window showing project A must still raise the
 *      user when project B asks; only an alarm from the project on screen stays quiet.
 *   3. With no chip probe registered (the launcher, the browser build), the alarm behaves
 *      exactly as it did when a window held one project.
 *   4. The body says what is actually being asked, clipped to something scannable.
 *
 * There is no jsdom/happy-dom in this repo (root vitest runs plain Node — see
 * checklist-store.test.ts), so `window`/`document`/`Notification` are shimmed here with the
 * minimal surface the module actually touches. `window` is deliberately a BARE object: no
 * `__TAURI_INTERNALS__`, so `isDesktop()` is false and the alarm takes its browser path —
 * which is the arm a Node test can observe. `chime.ts` is mocked to a counter so the voices
 * are countable in Node (it needs a real AudioContext to do anything else); swallowing a
 * missing/blocked audio context is chime.ts's own contract, not this module's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { raiseAskAttention, setChipActiveProbe } from '../../dashboard/src/lib/attention.js';
import { playAskChime } from '../../dashboard/src/lib/chime.js';

vi.mock('../../dashboard/src/lib/chime.js', () => ({ playAskChime: vi.fn() }));

interface SentNotification { title: string; body?: string; tag?: string }

let sent: SentNotification[] = [];

/** Minimal `Notification` stand-in recording every banner the module posts. */
function installNotificationStub(permission: NotificationPermission = 'granted'): void {
  class NotificationStub {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => NotificationStub.permission);
    constructor(title: string, options?: { body?: string; tag?: string }) {
      sent.push({ title, body: options?.body, tag: options?.tag });
    }
  }
  (globalThis as unknown as { Notification: unknown }).Notification = NotificationStub;
}

/** Is the user looking straight at this window? Drives the banner/bounce gate. */
function setWatching(watching: boolean): void {
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: watching ? 'visible' : 'hidden',
    hasFocus: () => watching,
  };
}

// The module-level throttle survives between tests, so each test starts on a clock far
// enough ahead that the previous test's alarm can never suppress this one's first call.
let clock = Date.UTC(2026, 0, 1);

beforeEach(() => {
  sent = [];
  clock += 60_000;
  vi.useFakeTimers();
  vi.setSystemTime(clock);
  vi.mocked(playAskChime).mockClear();
  (globalThis as unknown as { window: unknown }).window = {}; // present, but not Tauri
  setWatching(false);
  installNotificationStub();
});

afterEach(() => {
  vi.useRealTimers();
  // The probe is module state on `attention.ts` — a test that registers one must not leave
  // it answering for the next test's alarms.
  setChipActiveProbe(null);
});

/** Let the alarm's fire-and-forget transports settle (they are async, nobody awaits them). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('raiseAskAttention — one alarm per interruption', () => {
  it('posts a banner when the user is in another window', async () => {
    raiseAskAttention({ source: 'dreamcontext', detail: 'Which auth method should we use?' });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('Claude is asking · dreamcontext');
    expect(sent[0].body).toBe('Which auth method should we use?');
  });

  it('collapses a burst of asks into a single banner', async () => {
    raiseAskAttention({ detail: 'first' });
    raiseAskAttention({ detail: 'second' }); // same breath — one interruption
    raiseAskAttention({ detail: 'third' });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe('first');
  });

  it('raises again once the throttle window has passed', async () => {
    raiseAskAttention({ detail: 'first' });
    await vi.advanceTimersByTimeAsync(1600);
    raiseAskAttention({ detail: 'later' });
    await settle();
    expect(sent.map((n) => n.body)).toEqual(['first', 'later']);
  });

  it('keeps a burst inside ONE project to a single banner', async () => {
    raiseAskAttention({ source: 'atlas', detail: 'first' });
    raiseAskAttention({ source: 'atlas', detail: 'second' });
    raiseAskAttention({ source: 'atlas', detail: 'third' });
    await settle();
    expect(sent.map((n) => n.body)).toEqual(['first']);
  });

  it('does NOT collapse two different projects — they are two interruptions', async () => {
    raiseAskAttention({ source: 'atlas', detail: 'atlas asks' });
    await vi.advanceTimersByTimeAsync(1000); // well inside the 1.5s gate
    raiseAskAttention({ source: 'borealis', detail: 'borealis asks' });
    await settle();
    expect(sent.map((n) => n.title)).toEqual([
      'Claude is asking · atlas',
      'Claude is asking · borealis',
    ]);
  });

  it('rings ONE chime for two projects asking together — one AudioContext, one voice', async () => {
    raiseAskAttention({ source: 'atlas', detail: 'atlas asks' });
    await vi.advanceTimersByTimeAsync(200);
    raiseAskAttention({ source: 'borealis', detail: 'borealis asks' });
    await settle();
    expect(sent).toHaveLength(2); // two banners…
    expect(playAskChime).toHaveBeenCalledTimes(1); // …one voice
  });
});

describe('raiseAskAttention — the banner is for someone elsewhere', () => {
  it('stays silent while the window is focused and visible', async () => {
    setWatching(true);
    raiseAskAttention({ detail: 'you are already looking at this' });
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('a hidden-but-focused window still counts as away (backgrounded tab)', async () => {
    (globalThis as unknown as { document: unknown }).document = {
      visibilityState: 'hidden',
      hasFocus: () => true,
    };
    raiseAskAttention({ detail: 'minimized' });
    await settle();
    expect(sent).toHaveLength(1);
  });
});

/**
 * The headline scenario of the project-tabs work: one window, several live projects, and the
 * one that is asking is not the one on screen. Window focus alone cannot answer that, so
 * `WindowChrome` registers a probe saying which chip is visible.
 */
describe('raiseAskAttention — a background CHIP counts as elsewhere', () => {
  it('raises for a project that is not the visible chip, even with the window focused', async () => {
    setWatching(true);
    setChipActiveProbe((vault) => vault === 'atlas');
    raiseAskAttention({ source: 'borealis', detail: 'which branch should I use?' });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('Claude is asking · borealis');
  });

  it('stays quiet for the project the user is looking straight at', async () => {
    setWatching(true);
    setChipActiveProbe((vault) => vault === 'atlas');
    raiseAskAttention({ source: 'atlas', detail: 'you can already see this' });
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('with no probe registered, a focused window suppresses exactly as it always did', async () => {
    setWatching(true);
    raiseAskAttention({ source: 'atlas', detail: 'launcher / browser build — no chips' });
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('does not attribute a sourceless alarm to a background chip', async () => {
    setWatching(true);
    setChipActiveProbe((vault) => vault === 'atlas');
    raiseAskAttention({ detail: 'no project pinned' });
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('still raises when the window itself is unfocused, whatever the probe says', async () => {
    setChipActiveProbe(() => true); // claims "on screen"…
    raiseAskAttention({ source: 'atlas', detail: 'window is in the background' });
    await settle();
    expect(sent).toHaveLength(1); // …but nobody is looking at the window at all
  });
});

describe('raiseAskAttention — banner copy', () => {
  it('falls back to a generic title and body when the caller has neither', async () => {
    raiseAskAttention();
    await settle();
    expect(sent[0].title).toBe('Claude is asking');
    expect(sent[0].body).toBe('A question is waiting for your answer.');
  });

  it('treats a null/blank source or detail as absent (getActiveVault returns null)', async () => {
    raiseAskAttention({ source: null, detail: '   ' });
    await settle();
    expect(sent[0].title).toBe('Claude is asking');
    expect(sent[0].body).toBe('A question is waiting for your answer.');
  });

  it('flattens newlines and clips a long question to one scannable line', async () => {
    raiseAskAttention({ detail: `Should we\n\n  ship it?  ${'x'.repeat(400)}` });
    await settle();
    const body = sent[0].body ?? '';
    expect(body.startsWith('Should we ship it? xxx')).toBe(true);
    expect(body.length).toBeLessThanOrEqual(180);
    expect(body.endsWith('…')).toBe(true);
  });

  it('tags the banner so a second ask replaces the first instead of stacking', async () => {
    raiseAskAttention({ detail: 'anything' });
    await settle();
    expect(sent[0].tag).toBe('dreamcontext-ask');
  });
});

describe('raiseAskAttention — degrades instead of throwing', () => {
  it('posts nothing when notification permission is denied, and does not throw', async () => {
    installNotificationStub('denied');
    expect(() => raiseAskAttention({ detail: 'blocked' })).not.toThrow();
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('survives an environment with no Notification API at all', async () => {
    delete (globalThis as unknown as { Notification?: unknown }).Notification;
    expect(() => raiseAskAttention({ detail: 'no api' })).not.toThrow();
    await settle();
    expect(sent).toHaveLength(0);
  });
});
