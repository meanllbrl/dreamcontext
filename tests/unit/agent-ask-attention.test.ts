/**
 * Unit tests for `attention.ts` — the "Claude is asking" alarm that a fresh question
 * fires from both session engines (chat's `pushAsk`, the terminal's `onSettle`).
 *
 * Three properties are worth locking, because all three are invisible until they're wrong:
 *
 *   1. ONE interruption. The throttle is shared by chime + banner + Dock bounce, so two
 *      agents asking in the same breath produce one alarm, not two of each. This moved UP
 *      from chime.ts (which used to throttle only itself) when the banner and bounce were
 *      added — a per-transport throttle would have let the banner double while the chime
 *      stayed single.
 *   2. The banner is for someone who is ELSEWHERE. A system notification sliding over the
 *      very chat that raised it is noise, so a focused, visible window gets the chime only.
 *   3. The body says what is actually being asked, clipped to something scannable.
 *
 * There is no jsdom/happy-dom in this repo (root vitest runs plain Node — see
 * checklist-store.test.ts), so `window`/`document`/`Notification` are shimmed here with the
 * minimal surface the module actually touches. `window` is deliberately a BARE object: no
 * `__TAURI_INTERNALS__`, so `isDesktop()` is false and the alarm takes its browser path —
 * which is the arm a Node test can observe. `AudioContext` is left undefined on purpose;
 * the chime swallows its own absence, and that it does so is part of the contract (a
 * headless/blocked audio context must never stop the banner).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { raiseAskAttention } from '../../dashboard/src/lib/attention.js';

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
  (globalThis as unknown as { window: unknown }).window = {}; // present, but not Tauri
  setWatching(false);
  installNotificationStub();
});

afterEach(() => {
  vi.useRealTimers();
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
