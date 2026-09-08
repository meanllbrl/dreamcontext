/**
 * The push-to-talk chord: what may be bound, what the stored string looks like, and that the
 * dashboard's mirror of the parser has not drifted from the server's.
 *
 * WHY THE MIRROR IS TESTED AT ALL. The chord is validated on the server (which refuses a bad
 * one on the way to disk) and MATCHED in the dashboard (which is a separate build with no
 * module graph in common). Two parsers that disagree is a setting the card accepts and the
 * composer never fires on — a failure with nothing on screen to explain it. So this reads
 * both files and pins the parts that must be identical.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseHotkey, formatHotkey, normalizeHotkey, HOTKEY_BASE_RE, isLatchKey, effectiveMode,
} from '../../src/lib/voice/hotkey.js';
import {
  readVoiceConfig, writeVoiceConfig, voiceStatus, clampSpeechRate,
  DEFAULT_PUSH_TO_TALK, DEFAULT_SPEECH_RATE, MIN_SPEECH_RATE, MAX_SPEECH_RATE,
} from '../../src/lib/voice/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = new URL('../../', import.meta.url).pathname;

describe('a chord is accepted only when it can actually be held', () => {
  it('takes a modifier plus a physical key', () => {
    expect(parseHotkey('Alt+Space')).toEqual({ meta: false, control: false, alt: true, shift: false, code: 'Space' });
    expect(parseHotkey('Control+Shift+KeyV')?.code).toBe('KeyV');
    expect(parseHotkey('Meta+Backquote')?.meta).toBe(true);
  });

  it('takes a function key or CAPS LOCK alone — they type nothing, so they are safe unmodified', () => {
    expect(parseHotkey('F8')).toBeTruthy();
    expect(parseHotkey('F13')).toBeTruthy();
    expect(parseHotkey('CapsLock')).toBeTruthy();
  });

  it('REFUSES a bare printable key', () => {
    // Push-to-talk listens at the window, not at the textarea, so a bare letter would be
    // swallowed everywhere in the app — including inside the composer it is meant to fill.
    expect(parseHotkey('KeyV')).toBeNull();
    expect(parseHotkey('Space')).toBeNull();
    expect(parseHotkey('Digit1')).toBeNull();
  });

  it('refuses nonsense, duplicates and keys outside the closed list', () => {
    expect(parseHotkey('')).toBeNull();
    expect(parseHotkey('Alt+Alt+KeyV')).toBeNull();
    expect(parseHotkey('Hyper+KeyV')).toBeNull();
    expect(parseHotkey('Alt+ContextMenu')).toBeNull();
    expect(parseHotkey('Alt+NumpadDivide')).toBeNull();
  });

  it('has ONE canonical spelling, so the stored string can be compared rather than reparsed', () => {
    expect(normalizeHotkey('Shift+Alt+KeyV')).toBe('Alt+Shift+KeyV');
    expect(normalizeHotkey('Control+Meta+F5')).toBe('Meta+Control+F5');
    expect(formatHotkey(parseHotkey('Alt+Space')!)).toBe('Alt+Space');
  });
});

describe('the dashboard mirror agrees with the server', () => {
  const mirror = readFileSync(join(ROOT, 'dashboard/src/lib/voice/hotkey.ts'), 'utf-8');
  const server = readFileSync(join(ROOT, 'src/lib/voice/hotkey.ts'), 'utf-8');

  it('shares the base-key list character for character', () => {
    const grab = (src: string) => src.match(/HOTKEY_BASE_RE\s*=\s*\n?\s*(\/\^[^\n]+\/;)/)?.[1];
    expect(grab(mirror)).toBeTruthy();
    expect(grab(mirror)).toBe(grab(server));
  });

  it('shares the "a function key may stand alone" rule', () => {
    const grab = (src: string) => src.match(/isStandaloneBase[\s\S]{0,160}?return (\/[^\n]+\.test\(base\));/)?.[1];
    expect(grab(mirror)).toBeTruthy();
    expect(grab(mirror)).toBe(grab(server));
  });

  it('the default chord is the same string on both sides', () => {
    const dash = readFileSync(join(ROOT, 'dashboard/src/lib/voice/hotkeyDefaults.ts'), 'utf-8');
    expect(dash).toContain(`'${DEFAULT_PUSH_TO_TALK}'`);
  });

  it('matches on the physical `code`, never the typed character', () => {
    // ⌥+V arrives as `key === '√'` on a Mac: a chord matched by `key` would stop matching the
    // very modifier that defines it.
    expect(mirror).toMatch(/e\.code === chord\.code/);
    expect(mirror).not.toMatch(/e\.key === chord\.code/);
  });

  it('requires an EXACT modifier match, so a chord cannot fire inside a bigger one', () => {
    for (const pair of ['e.metaKey === chord.meta', 'e.ctrlKey === chord.control', 'e.altKey === chord.alt', 'e.shiftKey === chord.shift']) {
      expect(mirror).toContain(pair);
    }
  });
});

describe('the config carries the chord and the speech preferences', () => {
  const withHome = <T>(fn: (home: string) => T): T => {
    const home = mkdtempSync(join(tmpdir(), 'dc-voice-'));
    try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
  };

  it('defaults to ⌥Space, spoken answers on, and normal speed', () => withHome((home) => {
    const status = voiceStatus(home);
    expect(status.pushToTalk).toBe(DEFAULT_PUSH_TO_TALK);
    expect(status.speech).toBe(true);
    expect(status.speechRate).toBe(DEFAULT_SPEECH_RATE);
  }));

  it('stores a chord canonically and reads it back', () => withHome((home) => {
    writeVoiceConfig({ pushToTalk: normalizeHotkey('Shift+Control+KeyJ')!, speech: false, speechRate: 1.35 }, home);
    const status = voiceStatus(home);
    expect(status.pushToTalk).toBe('Control+Shift+KeyJ');
    expect(status.speech).toBe(false);
    expect(status.speechRate).toBe(1.35);
  }));

  it('DROPS an unusable chord on read rather than carrying it', () => withHome((home) => {
    // A hand-edited `voice.json` must degrade to the default binding, not to a mode whose
    // only input never fires.
    writeVoiceConfig({ pushToTalk: 'Alt+Space' }, home);
    const path = join(home, '.dreamcontext', 'voice.json');
    writeFileSync(path, JSON.stringify({ pushToTalk: 'KeyV' }), 'utf-8');
    expect(readVoiceConfig(home).pushToTalk).toBeUndefined();
    expect(voiceStatus(home).pushToTalk).toBe(DEFAULT_PUSH_TO_TALK);
  }));

  it('CLAMPS a rate instead of refusing it — every value in range still plays', () => {
    expect(clampSpeechRate(9)).toBe(MAX_SPEECH_RATE);
    expect(clampSpeechRate(0.1)).toBe(MIN_SPEECH_RATE);
    expect(clampSpeechRate(Number.NaN)).toBe(DEFAULT_SPEECH_RATE);
  });

  it('the base-key list is the one the route validates against', () => {
    expect(HOTKEY_BASE_RE.test('Space')).toBe(true);
    expect(HOTKEY_BASE_RE.test('Enter')).toBe(false);
  });
});

// ── The composer binds what Settings stored, not a constant ──────────────────────────────

describe('the composer listens for the CONFIGURED chord', () => {
  const composer = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/chat/Composer.tsx'), 'utf-8');

  it('no longer hardcodes ⌥Space in the key handler', () => {
    // The bug this pins is a half-migration: a Settings card that saves a chord while the
    // handler still tests `e.altKey && e.code === 'Space'` is a control that appears to work
    // and changes nothing.
    expect(composer).not.toMatch(/e\.altKey \|\| e\.code !== 'Space'/);
    expect(composer).toMatch(/matchesHotkey\(e, chord\)/);
    expect(composer).toMatch(/releasesHotkey\(e, chord\)/);
  });

  it('re-binds when the chord changes, without a reload', () => {
    // `pushToTalk` in the effect's deps is the whole mechanism: Settings publishes to the
    // shared cache, the composer's subscription sets state, the effect re-runs.
    expect(composer).toMatch(/\}, \[voiceEnabled, pushToTalk, pushToTalkMode, startTake, endTake\]\);/);
    expect(composer).toMatch(/return onVoicePrefs\(adopt\);/);
  });

  it('names the real chord in the button, so the tooltip cannot lie about the binding', () => {
    expect(composer).toMatch(/Hold to speak \(\$\{hotkeyLabel\(pushToTalk\)\}\)/);
  });
});

// ── Where the card lives, and that it reads like its neighbours ──────────────────────────

describe('the Voice card is a folded beta group at the bottom of the AGENT section', () => {
  const page = readFileSync(join(ROOT, 'dashboard/src/pages/SettingsPage.tsx'), 'utf-8');
  const card = readFileSync(join(ROOT, 'dashboard/src/components/settings/VoiceSettings.tsx'), 'utf-8');

  it('is rendered in the agents section and NOWHERE else', () => {
    const uses = page.match(/<VoiceSettings \/>/g) ?? [];
    expect(uses.length).toBe(1);
    const at = page.indexOf('<VoiceSettings />');
    const section = page.lastIndexOf("activeSection === 'agents'", at);
    const nextSection = page.indexOf("activeSection === 'memory'", section);
    expect(section).toBeGreaterThan(-1);
    expect(at).toBeLessThan(nextSection);         // inside the agents block, before the next
  });

  it('is the LAST thing in that section', () => {
    const at = page.indexOf('<VoiceSettings />');
    const close = page.indexOf('</section>', at);
    // Nothing but the closing tags between the card and the end of the section.
    expect(page.slice(at + '<VoiceSettings />'.length, close).trim()).toBe('');
  });

  it('renders folded, with a BETA chip', () => {
    expect(card).toMatch(/collapsible/);
    expect(card).not.toMatch(/defaultOpen/);      // folded is the point
    expect(card).toMatch(/settings-beta-badge">BETA/);
  });

  it('uses the same hotkey grammar as the agent hotkey field a few rows above', () => {
    // Two fields doing the same job in one section must be operated the same way: a read-only
    // input that captures while focused, Backspace clears. A second invention here is exactly
    // what the settings regroup was written to end.
    const agentField = page.match(/value=\{capturingAgentHotkey \? [^\n]*\n/);
    expect(agentField).toBeTruthy();
    expect(card).toMatch(/readOnly/);
    expect(card).toMatch(/className="settings-text-input voice-hotkey"/);
    expect(card).toMatch(/onKeyDown=\{captureHotkey\}/);
  });

  it('spells modifiers the way the rest of the app does', () => {
    const mirror = readFileSync(join(ROOT, 'dashboard/src/lib/voice/hotkey.ts'), 'utf-8');
    expect(mirror).toMatch(/Meta: 'Cmd', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift'/);
    // No symbol map survives — the neighbouring field draws "Ctrl+A", not "⌃A", and one
    // section must not spell the same thing two ways. (The ⌥+V prose in the comments is the
    // EXPLANATION of why the stored form is a `code`; it is not a label.)
    expect(mirror).not.toMatch(/MAC_SYMBOLS/);
  });
});

// ── Held, or latched ────────────────────────────────────────────────────────────────────

describe('how a binding is operated', () => {
  it('defaults to HOLD — the mode that cannot leave the microphone open', () => {
    expect(effectiveMode('Alt+Space', 'hold')).toBe('hold');
    expect(effectiveMode('F8', 'hold')).toBe('hold');
  });

  it('honours a stored toggle preference on an ordinary chord', () => {
    expect(effectiveMode('Alt+Space', 'toggle')).toBe('toggle');
  });

  it('FORCES toggle on Caps Lock, whatever is stored', () => {
    // macOS reports the latch as ON and OFF, never as held, so "hold" on it is a setting the
    // composer could not honour — and a Settings card that displayed it would be lying.
    expect(isLatchKey('CapsLock')).toBe(true);
    expect(isLatchKey('KeyV')).toBe(false);
    expect(effectiveMode('CapsLock', 'hold')).toBe('toggle');
    expect(effectiveMode('CapsLock', 'toggle')).toBe('toggle');
  });

  it('the config reports the EFFECTIVE mode, not the stored one', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-voice-'));
    try {
      writeVoiceConfig({ pushToTalk: 'CapsLock', pushToTalkMode: 'hold' }, home);
      expect(voiceStatus(home).pushToTalkMode).toBe('toggle');
      writeVoiceConfig({ pushToTalk: 'Alt+Space' }, home);
      expect(voiceStatus(home).pushToTalkMode).toBe('hold');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('the composer honours both ways of pressing it', () => {
  const composer = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/chat/Composer.tsx'), 'utf-8');

  it('ends a HELD take on the release, and a TOGGLED one only on the next press', () => {
    expect(composer).toMatch(/if \(mode === 'toggle'\) flip\(\);\s*\n\s*else startTake\(\);/);
    expect(composer).toMatch(/if \(latch && e\.code === chord\.code\) flip\(\);/);
    expect(composer).toMatch(/if \(releasesHotkey\(e, chord\)\) endTake\(\);/);
  });

  it('debounces the flip — a browser that reports the latch as a physical press sends keyup at once', () => {
    // Without the window, that release would end every take milliseconds after it started.
    expect(composer).toMatch(/if \(now - lastFlipRef\.current < 250\) return;/);
  });

  it('matches a latch on the CODE alone, and any other chord exactly', () => {
    // A latch arrives carrying no modifiers of its own; an ordinary chord that matched loosely
    // would fire inside somebody else's binding.
    expect(composer).toMatch(/const hit = latch \? e\.code === chord\.code : matchesHotkey\(e, chord\);/);
  });

  it('reads the capture state from a REF, so the listener is not rebuilt mid-take', () => {
    expect(composer).toMatch(/voiceStateRef\.current === 'recording'/);
  });
});
