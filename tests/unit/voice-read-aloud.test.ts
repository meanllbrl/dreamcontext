/**
 * Read aloud is OPT-IN. Three things are pinned here:
 *
 *  1. The module (`lib/voice/readAloud.ts`): off by default, persisted, heard by every
 *     subscriber in this window and in other windows, safe with no storage at all.
 *  2. The composer's switch (`Composer.tsx`): drawn only where voice is, a real toggle
 *     (`aria-pressed`), and turning it off silences a reply already playing through the Hush
 *     path. A SOURCE SCAN, for the reason `voice-composer-guard.test.ts` gives: the composer
 *     cannot be mounted under plain Node.
 *  3. The speech path (`chatSession.ts` `speakTail`): while the switch is off no text reaches
 *     the queue, so no `/tts` request is made. Muting playback would not be enough.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Source with comments removed, so a scan cannot pass on the prose explaining the rule. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** A minimal Storage, so persistence is exercised through the real API. */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  };
}

async function load() {
  vi.resetModules();
  return import('../../dashboard/src/lib/voice/readAloud.js');
}

// ── 1. The module ─────────────────────────────────────────────────────────────────────

describe('readAloud module', () => {
  let store: Storage;
  let win: EventTarget;
  beforeEach(() => {
    store = fakeStorage();
    win = new EventTarget();
    vi.stubGlobal('localStorage', store);
    vi.stubGlobal('window', win);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is OFF by default', async () => {
    const m = await load();
    expect(m.readAloudEnabled()).toBe(false);
  });

  it('persists the choice across a reload of the module', async () => {
    let m = await load();
    m.setReadAloud(true);
    m = await load();
    expect(m.readAloudEnabled()).toBe(true);
    m.setReadAloud(false);
    m = await load();
    expect(m.readAloudEnabled()).toBe(false);
  });

  it('tells every subscriber in this window, and stops after unsubscribe', async () => {
    const m = await load();
    const a: boolean[] = [];
    const b: boolean[] = [];
    const offA = m.onReadAloud((on) => a.push(on));
    m.onReadAloud((on) => b.push(on));
    m.setReadAloud(true);
    offA();
    m.setReadAloud(false);
    expect(a).toEqual([true]);
    expect(b).toEqual([true, false]);
  });

  it('hears a change made in ANOTHER window through the storage event', async () => {
    const m = await load();
    const seen: boolean[] = [];
    m.onReadAloud((on) => seen.push(on));
    // Another window wrote the store; the browser fires `storage` here, not in the writer.
    store.setItem('dreamcontext-read-aloud', '1');
    const e = Object.assign(new Event('storage'), { key: 'dreamcontext-read-aloud', newValue: '1' });
    win.dispatchEvent(e);
    const other = Object.assign(new Event('storage'), { key: 'something-else', newValue: '0' });
    win.dispatchEvent(other);
    expect(seen).toEqual([true]);
    expect(m.readAloudEnabled()).toBe(true);
  });

  it('works with no storage and no window at all (SSR, a locked webview)', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('window', undefined);
    const m = await load();
    expect(m.readAloudEnabled()).toBe(false);
    const seen: boolean[] = [];
    const off = m.onReadAloud((on) => seen.push(on));
    m.setReadAloud(true);
    expect(m.readAloudEnabled()).toBe(true);
    expect(seen).toEqual([true]);
    off();
  });

  it('survives a store that throws on write', async () => {
    vi.stubGlobal('localStorage', { ...fakeStorage(), setItem: () => { throw new Error('quota'); }, getItem: () => { throw new Error('locked'); } });
    const m = await load();
    expect(() => m.setReadAloud(true)).not.toThrow();
    expect(m.readAloudEnabled()).toBe(true);
  });
});

// ── 2. The composer's switch ─────────────────────────────────────────────────────────

describe('the composer read-aloud switch', () => {
  const composer = code(read('dashboard/src/components/sleepy/chat/Composer.tsx'));
  const button = composer.match(/\{voiceEnabled && \(\s*<button[^>]*?className="chat-cmp-iconbtn chat-cmp-readaloud"[\s\S]*?<\/button>\s*\)\}/)?.[0] ?? '';

  it('is drawn only where voice is, as a pressed/unpressed toggle', () => {
    expect(button).not.toBe('');
    expect(button).toMatch(/aria-pressed=\{readAloud\}/);
    expect(button).toMatch(/onClick=\{\(\) => setReadAloud\(!readAloud\)\}/);
    expect(button).toContain("'Read replies aloud'");
    expect(button).toContain("'Replies are not read aloud'");
    expect(button).toMatch(/readAloud \? <SpeakerIcon \/> : <HushIcon \/>/);
  });

  it('turning it off silences a reply already playing, through the Hush path', () => {
    const effect = composer.match(/onReadAloud\(\(on\) => \{[\s\S]*?\}\)/)?.[0] ?? '';
    expect(effect).toMatch(/if \(!on\) session\.bargeInSpeech\?\.\(\)/);
  });

  it('starts from the persisted choice, not from true', () => {
    expect(composer).toMatch(/useState\(readAloudEnabled\)/);
  });
});

// ── 3. The speech path ───────────────────────────────────────────────────────────────

/**
 * Does `speakTail` refuse to push while read aloud is off? The check must sit BEFORE
 * `speech.push`, because pushing is what enqueues a chunk and enqueuing is what fetches `/tts`.
 */
function speakTailGates(src: string): boolean {
  const body = code(src).match(/function speakTail\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
  const gate = body.search(/if \(!readAloudEnabled\(\)\)/);
  const push = body.search(/speech\.push\(/);
  return gate !== -1 && push !== -1 && gate < push;
}

/** The delta routed to the owner of `chatSession.ts` (see the lane report). Skipping the push
 *  still advances `spokenChars`, so turning the switch on mid-reply does not replay the
 *  paragraph that was skipped. */
function applySuggestedGate(src: string): string {
  return src.replace(
    '    if (!speech) return;\n    const already = spokenChars.get(itemId) ?? 0;\n    if (full.length <= already) return;\n',
    '    if (!speech) return;\n    const already = spokenChars.get(itemId) ?? 0;\n    if (full.length <= already) return;\n'
      + '    if (!readAloudEnabled()) { spokenChars.set(itemId, full.length); return; }\n',
  );
}

describe('the speech path skips /tts while read aloud is off', () => {
  const session = read('dashboard/src/components/sleepy/chatSession.ts');

  it('the scan tells a gated speakTail from an ungated one', () => {
    expect(speakTailGates(applySuggestedGate(session))).toBe(true);
    expect(speakTailGates(session.replace(/\n\s*if \(!readAloudEnabled\(\)\)[^\n]*/, ''))).toBe(false);
  });

  it('chatSession.ts speakTail checks readAloudEnabled() before speech.push', () => {
    expect(speakTailGates(session)).toBe(true);
  });
});
