/**
 * The push-to-talk chord, as a string both ends of the app agree on.
 *
 * ONE CANONICAL FORM, `Meta+Control+Alt+Shift+<Code>` with the absent modifiers dropped —
 * `Alt+Space`, `Control+Shift+KeyV`, `F8`. Canonical because the string is compared, never
 * parsed twice into two opinions: the server stores exactly what it validated, and the
 * composer matches a `KeyboardEvent` against exactly what it was handed.
 *
 * THE BASE IS A `KeyboardEvent.code`, NOT A `key`. `code` is the physical key, so a chord
 * survives a layout change and — the reason that matters here — survives the MODIFIER
 * itself: on macOS ⌥+V produces `key === '√'`, and a chord stored as a `key` would stop
 * matching the moment the owner held the modifier that defines it.
 *
 * WHY A BARE LETTER IS REFUSED. Push-to-talk listens at the WINDOW, not at the textarea, so
 * a chord with no modifier would swallow that key everywhere in the app — including inside
 * the composer it is meant to fill. Function keys are the documented exception: they type
 * nothing, so they are safe alone.
 *
 * The dashboard has a mirror of the matching half in `dashboard/src/lib/voice/hotkey.ts`
 * (the two builds share no module graph); the SHAPE is defined here, and the mirror's tests
 * read this file's constants so the two cannot drift.
 */

/** The modifiers, in canonical order. Order is fixed so `Alt+Shift+KeyV` has exactly one
 *  spelling and string equality is a legitimate comparison. */
export const HOTKEY_MODIFIERS = ['Meta', 'Control', 'Alt', 'Shift'] as const;

/** Physical keys a chord may end in. Deliberately a closed list: `code` also carries things
 *  like `ContextMenu` and `NumpadDivide`, and a chord nobody can reliably press is worse
 *  than a refused one. */
export const HOTKEY_BASE_RE =
  /^(?:Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-9]|F20|CapsLock|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

/** A function key may stand alone; everything else needs a modifier. */
export function isStandaloneBase(base: string): boolean {
  return /^(F([1-9]|1[0-9]|20)|CapsLock)$/.test(base);
}

/**
 * A LATCH key: one the OS toggles rather than reports held.
 *
 * Caps Lock is the only one, and it is here because holding a modifier to talk is the thing
 * the owner did not want. macOS reports it as a latch — `keydown` when the light comes ON,
 * `keyup` when it goes OFF — so "hold to talk" is not available on it at any price. What IS
 * available is better: the take runs for exactly as long as the light is on, and the keyboard
 * itself becomes the recording indicator.
 */
export function isLatchKey(code: string): boolean {
  return code === 'CapsLock';
}

/** How a binding is operated. `hold` is the default; `toggle` starts on one press and ends
 *  on the next, which is the only thing a latch key can do. */
export type PushToTalkMode = 'hold' | 'toggle';

/** The mode that will ACTUALLY be used: a latch key forces `toggle` whatever is stored, so
 *  the stored preference can never describe a binding that cannot work. */
export function effectiveMode(hotkey: string, stored: PushToTalkMode): PushToTalkMode {
  const chord = parseHotkey(hotkey);
  if (chord && isLatchKey(chord.code)) return 'toggle';
  return stored === 'toggle' ? 'toggle' : 'hold';
}

export interface Chord {
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
  /** A `KeyboardEvent.code`. */
  code: string;
}

/**
 * Parse a chord string, or null when it is not one this app will accept.
 *
 * Rejects rather than repairs. A hotkey that silently became something else would be a
 * control the Settings card claims to hold and the composer does not listen for.
 */
export function parseHotkey(raw: string): Chord | null {
  const parts = String(raw || '').trim().split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 5) return null;
  const base = parts[parts.length - 1];
  if (!HOTKEY_BASE_RE.test(base)) return null;
  const chord: Chord = { meta: false, control: false, alt: false, shift: false, code: base };
  for (const mod of parts.slice(0, -1)) {
    switch (mod) {
      case 'Meta': if (chord.meta) return null; chord.meta = true; break;
      case 'Control': if (chord.control) return null; chord.control = true; break;
      case 'Alt': if (chord.alt) return null; chord.alt = true; break;
      case 'Shift': if (chord.shift) return null; chord.shift = true; break;
      default: return null;
    }
  }
  if (!chord.meta && !chord.control && !chord.alt && !chord.shift && !isStandaloneBase(base)) return null;
  return chord;
}

/** The canonical spelling of a chord. */
export function formatHotkey(chord: Chord): string {
  const mods: string[] = [];
  if (chord.meta) mods.push('Meta');
  if (chord.control) mods.push('Control');
  if (chord.alt) mods.push('Alt');
  if (chord.shift) mods.push('Shift');
  return [...mods, chord.code].join('+');
}

/** Round-trip a stored or submitted string through the parser, so what is written to disk is
 *  always the canonical spelling — `Shift+Alt+KeyV` and `Alt+Shift+KeyV` are one setting. */
export function normalizeHotkey(raw: string): string | null {
  const chord = parseHotkey(raw);
  return chord ? formatHotkey(chord) : null;
}
