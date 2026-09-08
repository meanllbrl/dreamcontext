/**
 * The push-to-talk chord on the client: match it, record it, draw it.
 *
 * MIRROR OF `src/lib/voice/hotkey.ts`, which owns the SHAPE (canonical spelling, the closed
 * list of base keys, the "a bare letter is refused" rule). The two builds share no module
 * graph, so the parser is duplicated on purpose and `voice-hotkey.test.ts` reads both files
 * to prove the constants still agree. What lives ONLY here is the half that needs a
 * `KeyboardEvent`: matching a real keypress and turning one into a chord.
 *
 * `code` rather than `key` throughout — on macOS ⌥+V arrives as `key === '√'`, so a chord
 * stored by `key` would stop matching the very modifier that defines it.
 */

export const HOTKEY_BASE_RE =
  /^(?:Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-9]|F20|CapsLock|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

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
  code: string;
}

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

export function formatHotkey(chord: Chord): string {
  const mods: string[] = [];
  if (chord.meta) mods.push('Meta');
  if (chord.control) mods.push('Control');
  if (chord.alt) mods.push('Alt');
  if (chord.shift) mods.push('Shift');
  return [...mods, chord.code].join('+');
}

/**
 * The chord a keydown describes, or null when it is not a usable one.
 *
 * A press of a bare modifier returns null rather than a half chord — the recorder has to
 * keep listening while the owner is still assembling one, and `Alt` alone is not an answer.
 */
export function chordFromEvent(e: KeyboardEvent): Chord | null {
  if (!HOTKEY_BASE_RE.test(e.code)) return null;
  const chord: Chord = {
    meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, code: e.code,
  };
  if (!chord.meta && !chord.control && !chord.alt && !chord.shift && !isStandaloneBase(e.code)) return null;
  return chord;
}

/**
 * Does this keydown press the chord?
 *
 * EXACT modifier match, not a subset: `Alt+Space` must not fire on ⌘⌥Space, which is a
 * different binding the owner may have given the OS. A superset match would open the mic
 * inside somebody else's shortcut.
 */
export function matchesHotkey(e: KeyboardEvent, chord: Chord): boolean {
  return e.code === chord.code
    && e.metaKey === chord.meta
    && e.ctrlKey === chord.control
    && e.altKey === chord.alt
    && e.shiftKey === chord.shift;
}

/** Does releasing this key END a take started with `chord`? The base key or ANY of the
 *  chord's modifiers — letting go of ⌥ before the space bar is common enough that not
 *  handling it would strand the recorder open with the macOS mic indicator lit. */
export function releasesHotkey(e: KeyboardEvent, chord: Chord): boolean {
  if (e.code === chord.code) return true;
  if (chord.meta && e.key === 'Meta') return true;
  if (chord.control && e.key === 'Control') return true;
  if (chord.alt && e.key === 'Alt') return true;
  if (chord.shift && e.key === 'Shift') return true;
  return false;
}

/**
 * Modifier names as the REST OF THIS APP spells them.
 *
 * `agentSettings.ts` already had a hotkey vocabulary — `Cmd+Ctrl+Alt+Shift` accelerators,
 * drawn by its own `formatHotkey` — and the agent open/close binding now sits a few rows
 * above this one in the same Settings section. Two fields doing the same job must READ the
 * same, so the label follows that spelling exactly.
 *
 * The STORED form still differs, and deliberately: an accelerator is built from
 * `KeyboardEvent.key`, which cannot express a HELD binding safely — on macOS ⌥+V arrives as
 * `key === '√'`, so the string stops describing the key the moment the modifier that defines
 * it is pressed. Push-to-talk has to match a keydown AND a keyup, so it stores the physical
 * `code`. The difference is invisible; the labels are not, so those match.
 */
const MOD_LABELS: Record<string, string> = { Meta: 'Cmd', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
const BASE_LABELS: Record<string, string> = {
  CapsLock: 'Caps Lock',
  Space: 'Space', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

/** What the base key is CALLED — `KeyV` is a code, "V" is what is printed on it. */
export function baseLabel(code: string): string {
  if (BASE_LABELS[code]) return BASE_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

/** A chord as the owner should read it: `Alt+Space`, `Ctrl+Shift+V`, `F8` — the same
 *  spelling the agent hotkey field a few rows above uses. */
export function hotkeyLabel(raw: string): string {
  const chord = parseHotkey(raw);
  if (!chord) return raw;
  const mods: string[] = [];
  if (chord.meta) mods.push(MOD_LABELS.Meta);
  if (chord.control) mods.push(MOD_LABELS.Control);
  if (chord.alt) mods.push(MOD_LABELS.Alt);
  if (chord.shift) mods.push(MOD_LABELS.Shift);
  return [...mods, baseLabel(chord.code)].join('+');
}
