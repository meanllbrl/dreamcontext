/**
 * The pure rules behind the "Create dreamcontext Assistant" wizard
 * (`dashboard/src/components/assistant/assistantWizardLogic.ts`).
 *
 * The hotkey is a GLOBAL shortcut, live in every app on the Mac, so what the capture accepts
 * matters more than it looks: a chord without a modifier (or with Shift alone) would swallow a
 * typed character everywhere. The server's `sanitizeConfigPatch` refuses a modifier-less chord
 * too; this pins the client side and that the two agree on the modifier vocabulary.
 */
import { describe, it, expect } from 'vitest';
import {
  captureChord, formatChordGlyphs, isValidAssistantHotkey, hotkeyResultView, autonomyWarnings,
  checkAvatarFile, sniffAvatarBytes, fillCopy, isValidAssistantName, baseKeyLabel,
  AVATAR_MAX_BYTES, WIZARD_STEPS, type KeyEventLike,
} from '../../dashboard/src/components/assistant/assistantWizardLogic.js';
import { sanitizeConfigPatch } from '../../src/lib/assistant/home.js';

const key = (code: string, mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {}, k = 'x'): KeyEventLike => ({
  code, key: k, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift,
});

describe('hotkey capture', () => {
  it('captures the PHYSICAL code with its modifiers, in ⌃⌥⇧⌘ order', () => {
    expect(captureChord(key('KeyJ', { meta: true, ctrl: true, alt: true }))).toEqual({
      kind: 'chord', code: 'KeyJ', mods: ['Control', 'Alt', 'Meta'],
    });
    // ⌥J types "∆" on a Mac; the code still says KeyJ.
    expect(captureChord(key('KeyJ', { alt: true }, '∆'))).toEqual({ kind: 'chord', code: 'KeyJ', mods: ['Alt'] });
  });

  it('keeps listening while only modifiers are down', () => {
    for (const k of ['Meta', 'Control', 'Alt', 'Shift']) {
      expect(captureChord(key(`${k}Left`, { alt: true }, k))).toEqual({ kind: 'assembling' });
    }
  });

  it('refuses a bare key, including function keys (the shell requires a modifier)', () => {
    expect(captureChord(key('KeyJ'))).toEqual({ kind: 'refused', reason: 'needs_modifier' });
    expect(captureChord(key('F8'))).toEqual({ kind: 'refused', reason: 'needs_modifier' });
  });

  it('refuses Shift alone on a printable key, but allows Shift+F-key', () => {
    expect(captureChord(key('KeyJ', { shift: true }))).toEqual({ kind: 'refused', reason: 'shift_only' });
    expect(captureChord(key('F8', { shift: true }))).toEqual({ kind: 'chord', code: 'F8', mods: ['Shift'] });
  });

  it('refuses keys that cannot be a base (Caps Lock, Enter, arrows)', () => {
    for (const code of ['CapsLock', 'Enter', 'ArrowUp', 'Tab', 'Escape']) {
      expect(captureChord(key(code, { meta: true }))).toEqual({ kind: 'refused', reason: 'unsupported_key' });
    }
  });

  it('every captured chord survives the server sanitizer unchanged', () => {
    const out = captureChord(key('Space', { ctrl: true, alt: true }));
    expect(out.kind).toBe('chord');
    if (out.kind !== 'chord') return;
    const hotkey = { code: out.code, mods: out.mods, mode: 'toggle' as const };
    expect(isValidAssistantHotkey(hotkey)).toBe(true);
    expect(sanitizeConfigPatch({ hotkey }).hotkey).toEqual(hotkey);
  });

  it('isValidAssistantHotkey mirrors the capture rules', () => {
    expect(isValidAssistantHotkey(null)).toBe(false);
    expect(isValidAssistantHotkey({ code: 'KeyJ', mods: [], mode: 'hold' })).toBe(false);
    expect(isValidAssistantHotkey({ code: 'KeyJ', mods: ['Shift'], mode: 'hold' })).toBe(false);
    expect(isValidAssistantHotkey({ code: 'CapsLock', mods: ['Meta'], mode: 'hold' })).toBe(false);
    expect(isValidAssistantHotkey({ code: 'KeyJ', mods: ['Meta'], mode: 'hold' })).toBe(true);
  });
});

describe('off switch', () => {
  it('keeps a boolean enabled and drops anything else', () => {
    expect(sanitizeConfigPatch({ enabled: false }).enabled).toBe(false);
    expect(sanitizeConfigPatch({ enabled: true }).enabled).toBe(true);
    expect('enabled' in sanitizeConfigPatch({ enabled: 'no' })).toBe(false);
  });
});

describe('chord display', () => {
  it('draws Mac glyphs in the standard order whatever order was stored', () => {
    expect(formatChordGlyphs({ code: 'KeyJ', mods: ['Meta', 'Alt', 'Control'] })).toBe('⌃⌥⌘J');
    expect(formatChordGlyphs({ code: 'Digit4', mods: ['Shift', 'Meta'] })).toBe('⇧⌘4');
    expect(formatChordGlyphs({ code: 'Space', mods: ['Alt'] })).toBe('⌥Space');
    expect(baseKeyLabel('Backquote')).toBe('`');
  });

  it('turns the shell result into what the wizard says', () => {
    const saved = { code: 'KeyJ', mods: ['Control', 'Alt', 'Meta'] as const, mode: 'hold' as const };
    const hk = { ...saved, mods: [...saved.mods] };
    expect(hotkeyResultView({ ok: true, chord: 'Control+Alt+Meta+KeyJ (hold)', error: null }, hk))
      .toEqual({ kind: 'registered', chord: '⌃⌥⌘J' });
    expect(hotkeyResultView({ ok: false, chord: 'Control+Alt+Meta+KeyJ (hold)', error: 'hotkey unavailable: taken' }, hk))
      .toEqual({ kind: 'taken', detail: 'hotkey unavailable: taken' });
    expect(hotkeyResultView({ ok: true, chord: null, error: null }, null)).toEqual({ kind: 'none' });
    expect(hotkeyResultView({ ok: false, chord: null, error: null, desktopOnly: true }, hk)).toEqual({ kind: 'desktop_only' });
  });
});

describe('autonomy warnings', () => {
  it('warns only for bypass, and adds the stronger one when autostart is also on', () => {
    expect(autonomyWarnings('ask', true)).toEqual([]);
    expect(autonomyWarnings('auto', true)).toEqual([]);
    expect(autonomyWarnings('bypass', false)).toEqual(['bypass']);
    expect(autonomyWarnings('bypass', true)).toEqual(['bypass', 'bypass_autostart']);
  });
});

describe('avatar gate', () => {
  it('refuses SVG by type or name, empty and oversized files', () => {
    expect(checkAvatarFile({ name: 'a.svg', type: '', size: 10 })).toBe('svg');
    expect(checkAvatarFile({ name: 'a.png', type: 'image/svg+xml', size: 10 })).toBe('svg');
    expect(checkAvatarFile({ name: 'a.png', type: 'image/png', size: 0 })).toBe('empty');
    expect(checkAvatarFile({ name: 'a.png', type: 'image/png', size: AVATAR_MAX_BYTES + 1 })).toBe('too_large');
    expect(checkAvatarFile({ name: 'a.png', type: 'image/png', size: AVATAR_MAX_BYTES })).toBeNull();
  });

  it('sniffs PNG, JPEG and WebP by magic bytes and nothing else', () => {
    expect(sniffAvatarBytes(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffAvatarBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffAvatarBytes(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('webp');
    expect(sniffAvatarBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});

describe('small helpers', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(fillCopy('Registered {chord}', { chord: '⌃⌥⌘J' })).toBe('Registered ⌃⌥⌘J');
    expect(fillCopy('{n} of {max}', { n: 3 })).toBe('3 of {max}');
  });

  it('names follow the server rule (1-40 characters, trimmed)', () => {
    expect(isValidAssistantName('  ')).toBe(false);
    expect(isValidAssistantName('Friday')).toBe(true);
    expect(isValidAssistantName('x'.repeat(41))).toBe(false);
  });

  it('creates on step one, wakes on the last', () => {
    expect(WIZARD_STEPS[0]).toBe('name');
    expect(WIZARD_STEPS[WIZARD_STEPS.length - 1]).toBe('wake');
  });
});
