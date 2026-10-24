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
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
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
  // The notch Assistant's AND the Super Agent's (owner, 2026-10-21: one visible speech switch on
  // the Super stage), and never on the hands-free phone (`!phoneVoice`): speech is the laptop's.
  const button = composer.match(/\{voiceEnabled && \(mode === 'assistant' \|\| mode === 'super'\) && !phoneVoice && \(\s*<button[^>]*?className="chat-cmp-iconbtn chat-cmp-readaloud"[\s\S]*?<\/button>\s*\)\}/)?.[0] ?? '';

  it('is drawn in the notch and the Super composer, as a pressed/unpressed toggle', () => {
    expect(button).not.toBe('');
    expect(button).toMatch(/aria-pressed=\{readAloud\}/);
    expect(button).toMatch(/onClick=\{\(\) => toggleReadAloud\(!readAloud\)\}/);
    expect(button).toContain("t('voice.readAloud.on')");
    expect(button).toContain("t('voice.readAloud.off')");
    expect(button).toMatch(/readAloud \? <SpeakerIcon \/> : <HushIcon \/>/);
  });

  it('is the ONLY speech switch: no second store, no second key', () => {
    const files = ['dashboard/src/components/sleepy/chat/Composer.tsx', 'dashboard/src/components/sleepy/chatSession.ts'];
    for (const f of files) {
      const src = code(read(f));
      expect(src).not.toMatch(/localStorage\.(get|set)Item\([^)]*(speech|voice|aloud)/i);
    }
    expect(composer.match(/chat-cmp-readaloud/g)?.length).toBe(1);
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

// ── 4. The super side of the switch ──────────────────────────────────────────────────

describe('the Super Agent speaks only while the switch is on', () => {
  const session = code(read('dashboard/src/components/sleepy/chatSession.ts'));

  it('speakSuperTail pushes only inside a voice turn AND with the switch on', () => {
    const body = session.match(/function speakSuperTail\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    expect(body).toMatch(/if \(voiceTurn && readAloudEnabled\(\)\) speech\?\.push\(/);
  });

  it('a message is sent spoken only with the switch on and never from the phone', () => {
    expect(session).toMatch(/const spoken = saidAloud && readAloudEnabled\(\) && !isMacPhoneSurface\(\);/);
  });

  it('the briefing asks for a short reply only to a message carrying <owner-voice>', async () => {
    const { SUPER_VOICE_SECTION, SUPER_BRIEF_REV } = await import('../../src/lib/super/types.js');
    expect(SUPER_VOICE_SECTION).toMatch(/Only a message carrying an `<owner-voice>` block is read aloud/);
    expect(SUPER_VOICE_SECTION).toMatch(/Every other message, typed or dictated, is only read on screen/);
    // The section changed, so the running super sessions are re-briefed once (K9).
    expect(SUPER_BRIEF_REV).toBeGreaterThanOrEqual(2);
  });
});

// ── 5. The voice row's words ─────────────────────────────────────────────────────────

describe('the voice row says two to four words, in both languages', () => {
  const i18n = read('dashboard/src/context/I18nContext.tsx');
  const trStart = i18n.indexOf('const TR_PARTIAL');
  const pick = (src: string) => Object.fromEntries([...src.matchAll(/^\s*'(voice\.[\w.]+)': '((?:[^'\\]|\\.)*)',$/gm)].map((m) => [m[1], m[2]]));
  const en = pick(i18n.slice(0, trStart));
  const tr = pick(i18n.slice(trStart));
  const composer = code(read('dashboard/src/components/sleepy/chat/Composer.tsx'));
  const overlay = code(read('dashboard/src/components/assistant/ListeningOverlay.tsx'));

  it('every key the composer and the notch card use exists in EN and in TR', () => {
    const used = new Set([...`${composer}\n${overlay}`.matchAll(/t\('(voice\.[\w.]+)'\)/g)].map((m) => m[1]));
    used.add('voice.note.muted');
    used.add('voice.note.added');
    expect(used.size).toBeGreaterThan(15);
    for (const k of used) {
      expect(en[k], `EN ${k}`).toBeTruthy();
      expect(tr[k], `TR ${k}`).toBeTruthy();
    }
    expect(Object.keys(en).sort()).toEqual(Object.keys(tr).sort());
  });

  it('no line is longer than four words', () => {
    for (const [k, v] of [...Object.entries(en), ...Object.entries(tr)]) {
      const words = v.replace('{key}', 'Shift+V').replace('{n}/{max}', '1/2').split(/\s+/).filter(Boolean);
      expect(words.length, `${k}: "${v}"`).toBeLessThanOrEqual(4);
    }
  });

  it('the composer keeps no sentence of its own in the row', () => {
    for (const gone of ['or the mic to speak', 'That was a tap', 'let go to send', 'Nothing was heard — try again', 'Added to what you typed', 'Another window was speaking']) {
      expect(composer).not.toContain(gone);
    }
  });

  it('the line sits LEFT of the mic, so its changing width never moves the button under a held pointer', () => {
    const note = composer.indexOf('className="chat-cmp-voice-note is-idle"');
    const mic = composer.indexOf('chat-cmp-send chat-cmp-mic');
    expect(note).toBeGreaterThan(-1);
    expect(mic).toBeGreaterThan(note);
  });

  it('one line, cut with an ellipsis', () => {
    const css = read('dashboard/src/components/sleepy/chat/composer.css');
    const rule = css.match(/\.chat-cmp-voice-note \{[\s\S]*?\}/)?.[0] ?? '';
    for (const d of ['white-space: nowrap', 'text-overflow: ellipsis', 'overflow: hidden']) expect(rule).toContain(d);
    const notch = read('dashboard/src/components/assistant/notch.css');
    for (const cls of ['dc-listen__title', 'dc-listen__sub']) {
      const r = notch.match(new RegExp(`\\.${cls} \\{[^}]*\\}`))?.[0] ?? '';
      expect(r, cls).toContain('white-space: nowrap');
      expect(r, cls).toContain('text-overflow: ellipsis');
    }
  });
});

// ── 6. The recording look, tokens only ───────────────────────────────────────────────

describe('the recording strip draws in the theme', () => {
  it('the meter resolves its colour on the element (a canvas cannot read var())', () => {
    const meter = code(read('dashboard/src/components/sleepy/chat/VoiceMeter.tsx'));
    expect(meter).toMatch(/getComputedStyle\(canvas\)\.color/);
    expect(meter).toMatch(/style=\{\{ color \}\}/);
    expect(meter).not.toMatch(/fillStyle = colorRef\.current/);
  });

  it('the recording mic uses error tokens, no fixed colour', () => {
    const css = read('dashboard/src/components/sleepy/chat/composer.css');
    const rules = [...css.matchAll(/\.chat-cmp-send\.chat-cmp-mic\.is-recording(::after)? \{[\s\S]*?\}/g)].map((m) => m[0]).join('\n');
    expect(rules).toContain('var(--color-error-subtle)');
    expect(rules).toContain('var(--color-error-ink)');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });
});

// ── 7. The switch survives a relaunch ────────────────────────────────────────────────

describe('the speech switch is persisted in agent-ui.json (each launch is a new origin)', () => {
  let store: Storage;
  beforeEach(() => {
    store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible', hidden: false }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in this test'); }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function loadAll() {
    vi.resetModules();
    const ra = await import('../../dashboard/src/lib/voice/readAloud.js');
    const persist = await import('../../dashboard/src/lib/voice/readAloudPersist.js');
    const settings = await import('../../dashboard/src/lib/agentSettings.js');
    return { ra, persist, settings };
  }

  it('the button writes the settings blob as well as the fast copy', async () => {
    const { ra, persist, settings } = await loadAll();
    persist.toggleReadAloud(true);
    expect(ra.readAloudEnabled()).toBe(true);
    expect(settings.readAgentSettings().readAloud).toBe(true);
    persist.toggleReadAloud(false);
    expect(settings.readAgentSettings().readAloud).toBe(false);
  });

  it('a fresh launch (empty localStorage) adopts the persisted ON from the settings', async () => {
    const { ra, persist, settings } = await loadAll();
    persist.wireReadAloudPersistence();
    expect(ra.readAloudEnabled()).toBe(false);
    // What hydration does: the server's blob arrives as a settings event.
    window.dispatchEvent(new CustomEvent(settings.AGENT_SETTINGS_EVENT, { detail: settings.coerceAgentSettings({ readAloud: true }) }));
    expect(ra.readAloudEnabled()).toBe(true);
    window.dispatchEvent(new CustomEvent(settings.AGENT_SETTINGS_EVENT, { detail: settings.coerceAgentSettings({}) }));
    expect(ra.readAloudEnabled()).toBe(false);
  });
});

// ── 8. A tap is called a tap on the WebKit path too (the phone's) ───────────────────────

describe('a frameless release inside the tap window is too-short, not silent', () => {
  const capture = code(read('dashboard/src/lib/voice/useVoiceCapture.ts'));
  it('finishTake: no frame + released before MIN_TAKE_MS from the press → too-short', () => {
    expect(capture).toMatch(/const verdict = wav \? judgeTake\(durationMs, peak, noise\)\s*: Date\.now\(\) - pressedAtRef\.current < MIN_TAKE_MS \? 'too-short' : 'silent';/);
  });
  it('a release while the device was still opening: a tap says so, a long press goes back to rest', () => {
    expect(capture).toMatch(/setState\(Date\.now\(\) - pressedAtRef\.current < MIN_TAKE_MS \? 'too-short' : 'idle'\);/);
  });
  it('the notch card says one word for a tap, with no second line', () => {
    const overlay = code(read('dashboard/src/components/assistant/ListeningOverlay.tsx'));
    expect(overlay).toMatch(/act\.phase === 'too-short'\) \{\s*title = t\('voice\.note\.tap'\);\s*sub = '';/);
    expect(overlay).toMatch(/\{sub && <p className="dc-listen__sub">\{sub\}<\/p>\}/);
  });
});
