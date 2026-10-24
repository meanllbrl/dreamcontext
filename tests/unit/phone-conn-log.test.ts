/**
 * The phone's own connection log (dashboard/src/lib/phoneConnLog.ts): bounded, kept across a
 * reload in sessionStorage, silent off the phone, and never carrying free text.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const store = new Map<string, string>();

beforeEach(async () => {
  store.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone) '.padEnd(400, 'x') });
  const { setPhoneSurfaceForTests } = await import('../../dashboard/src/lib/phoneSurface');
  setPhoneSurfaceForTests('mac');
  const { resetPhoneLogForTests } = await import('../../dashboard/src/lib/phoneConnLog');
  resetPhoneLogForTests();
});

afterEach(async () => {
  const { setPhoneSurfaceForTests } = await import('../../dashboard/src/lib/phoneSurface');
  setPhoneSurfaceForTests(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('phone connection log', () => {
  it('records events with 8-char ids, after a boot mark', async () => {
    const { recordPhoneEvent, phoneLogSnapshot } = await import('../../dashboard/src/lib/phoneConnLog');
    recordPhoneEvent('close', '6f1c2e9a-a001-4a5b', { code: 1005 });
    recordPhoneEvent('ask', '6f1c2e9a-a001-4a5b', { requestId: 'toolu_0123456789' });
    const snap = phoneLogSnapshot();
    expect(snap.v).toBe(1);
    expect(snap.events.map((e) => e.k)).toEqual(['boot', 'close', 'ask']);
    expect(snap.events[1]).toMatchObject({ cid8: '6f1c2e9a', code: 1005 });
    expect(snap.events[2].req8).toBe('toolu_01');
  });

  it(`caps at ${500} events`, async () => {
    const { recordPhoneEvent, phoneLogSnapshot, PHONE_LOG_CAP } = await import('../../dashboard/src/lib/phoneConnLog');
    for (let i = 0; i < PHONE_LOG_CAP + 40; i += 1) recordPhoneEvent('attempt', 'c');
    const events = phoneLogSnapshot().events;
    expect(events).toHaveLength(PHONE_LOG_CAP);
    expect(events.every((e) => e.k === 'attempt')).toBe(true);
  });

  it('keeps only the last 10 minutes', async () => {
    const { recordPhoneEvent, phoneLogSnapshot } = await import('../../dashboard/src/lib/phoneConnLog');
    recordPhoneEvent('open', 'old');
    vi.advanceTimersByTime(11 * 60_000);
    recordPhoneEvent('open', 'new');
    expect(phoneLogSnapshot().events.map((e) => e.cid8)).toEqual(['new']);
  });

  it('a reload keeps the evidence (sessionStorage) and marks itself with boot', async () => {
    const { recordPhoneEvent, resetPhoneLogForTests, phoneLogSnapshot } = await import('../../dashboard/src/lib/phoneConnLog');
    recordPhoneEvent('close', 'before', { code: 1006 });
    resetPhoneLogForTests();   // a new page
    recordPhoneEvent('open', 'after');
    expect(phoneLogSnapshot().events.map((e) => `${e.k}:${e.cid8}`)).toEqual(['boot:', 'close:before', 'boot:', 'open:after']);
  });

  it('does nothing off the phone surface', async () => {
    const { setPhoneSurfaceForTests } = await import('../../dashboard/src/lib/phoneSurface');
    setPhoneSurfaceForTests(null);
    vi.stubGlobal('document', { querySelector: () => null });
    const { recordPhoneEvent } = await import('../../dashboard/src/lib/phoneConnLog');
    recordPhoneEvent('close', 'laptop', { code: 1006 });
    expect(store.size).toBe(0);
  });

  it('carries no free text: only the schema\'s keys, a capped user agent', async () => {
    const { recordPhoneEvent, phoneLogSnapshot, PHONE_LOG_UA_MAX } = await import('../../dashboard/src/lib/phoneConnLog');
    recordPhoneEvent('respawn', 'c', { reason: 'account' });
    recordPhoneEvent('reattached', 'c', { busy: false });
    const snap = phoneLogSnapshot();
    expect(Object.keys(snap).sort()).toEqual(['app', 'events', 'ua', 'v']);
    expect(snap.ua.length).toBe(PHONE_LOG_UA_MAX);
    const allowed = new Set(['t', 'k', 'cid8', 'code', 'busy', 'req8', 'reason']);
    for (const e of snap.events) for (const key of Object.keys(e)) expect(allowed.has(key)).toBe(true);
  });
});
