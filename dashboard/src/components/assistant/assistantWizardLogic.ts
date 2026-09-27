/**
 * The pure half of the "Create dreamcontext Assistant" wizard: hotkey capture rules, how a
 * chord and a registration result are drawn, the autonomy warnings, and the avatar gate.
 *
 * No DOM, no fetch, no Tauri — so `tests/unit/assistant-wizard.test.ts` can pin every rule in
 * plain Node, and the wizard component stays a thin shell over it.
 *
 * WHY A SEPARATE CHORD GRAMMAR FROM THE VOICE ONE (`lib/voice/hotkey.ts`). That one is matched
 * by the webview, inside the app, and may bind F-keys or Caps Lock ALONE. This one is a GLOBAL
 * shortcut registered by the desktop shell (`assistant.rs`), live in every other app on the
 * Mac, and the server (`sanitizeConfigPatch`) and the shell both refuse a chord with no
 * modifier. So: at least one modifier, always; Caps Lock never (it is a latch, there is no
 * "held"); and Shift alone never, because Shift+J registered globally would swallow every
 * capital J the owner types anywhere.
 */

export type AssistantMod = 'Meta' | 'Control' | 'Alt' | 'Shift';
export type HotkeyMode = 'hold' | 'toggle';
export type AssistantAutonomy = 'ask' | 'auto' | 'bypass';

export interface AssistantHotkey {
  /** Physical `KeyboardEvent.code` — never the layout-dependent character. */
  code: string;
  mods: AssistantMod[];
  mode: HotkeyMode;
}

/** The subset of a `KeyboardEvent` the capture reads — structural, so tests pass plain objects. */
export interface KeyEventLike {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Keys the shell can register as a chord's base. Mirrors the voice grammar minus Caps Lock. */
export const ASSISTANT_HOTKEY_BASE_RE =
  /^(?:Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-9]|F20|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

/** macOS reading order for modifier glyphs: ⌃ ⌥ ⇧ ⌘. Stored in the same order. */
export const MOD_ORDER: readonly AssistantMod[] = ['Control', 'Alt', 'Shift', 'Meta'];
const MOD_GLYPHS: Record<AssistantMod, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'OS', 'Hyper', 'Super']);

export type CaptureOutcome =
  /** Only modifiers are down so far — keep listening, say nothing. */
  | { kind: 'assembling' }
  /** Not a usable chord; `reason` names why (an i18n key suffix). */
  | { kind: 'refused'; reason: 'needs_modifier' | 'shift_only' | 'unsupported_key' }
  | { kind: 'chord'; code: string; mods: AssistantMod[] };

/** Turn one keydown into a capture outcome. */
export function captureChord(e: KeyEventLike): CaptureOutcome {
  if (MODIFIER_KEYS.has(e.key)) return { kind: 'assembling' };
  if (!ASSISTANT_HOTKEY_BASE_RE.test(e.code)) return { kind: 'refused', reason: 'unsupported_key' };
  const down: Record<AssistantMod, boolean> = {
    Control: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Meta: e.metaKey,
  };
  const mods = MOD_ORDER.filter((m) => down[m]);
  if (mods.length === 0) return { kind: 'refused', reason: 'needs_modifier' };
  if (mods.length === 1 && mods[0] === 'Shift' && !/^F\d+$/.test(e.code)) {
    return { kind: 'refused', reason: 'shift_only' };
  }
  return { kind: 'chord', code: e.code, mods };
}

/** True when a stored hotkey is one this wizard would have accepted. */
export function isValidAssistantHotkey(h: AssistantHotkey | null | undefined): h is AssistantHotkey {
  if (!h || !ASSISTANT_HOTKEY_BASE_RE.test(h.code)) return false;
  if (!Array.isArray(h.mods) || h.mods.length === 0) return false;
  if (!h.mods.every((m) => (MOD_ORDER as readonly string[]).includes(m))) return false;
  if (h.mods.length === 1 && h.mods[0] === 'Shift' && !/^F\d+$/.test(h.code)) return false;
  return h.mode === 'hold' || h.mode === 'toggle';
}

const BASE_LABELS: Record<string, string> = {
  Space: 'Space', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

/** What is printed on the key: `KeyJ` → `J`, `Digit4` → `4`. */
export function baseKeyLabel(code: string): string {
  if (BASE_LABELS[code]) return BASE_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

/** A chord as a Mac reads it: `⌃⌥⌘J`. Modifier order is normalised, whatever was stored. */
export function formatChordGlyphs(h: Pick<AssistantHotkey, 'code' | 'mods'>): string {
  const mods = MOD_ORDER.filter((m) => h.mods.includes(m));
  return mods.map((m) => MOD_GLYPHS[m]).join('') + baseKeyLabel(h.code);
}

/** The shell's answer to "register this chord" (`assistant_apply_hotkey` / `assistant_wake`). */
export interface HotkeyApplyResult {
  ok: boolean;
  /** The shell's own label for the chord it tried, or null when none is configured. */
  chord: string | null;
  error: string | null;
  /** True when there is no desktop shell to ask (a browser tab). */
  desktopOnly?: boolean;
}

export type HotkeyResultView =
  | { kind: 'registered'; chord: string }
  | { kind: 'taken'; detail: string }
  | { kind: 'none' }
  | { kind: 'desktop_only' };

/**
 * What the wizard SAYS about a registration result. The chord is drawn from the hotkey the
 * owner just saved (glyphs), never from the shell's debug label.
 */
export function hotkeyResultView(r: HotkeyApplyResult, saved: AssistantHotkey | null): HotkeyResultView {
  if (r.desktopOnly) return { kind: 'desktop_only' };
  if (r.ok && r.chord && saved) return { kind: 'registered', chord: formatChordGlyphs(saved) };
  if (r.ok) return { kind: 'none' };
  return { kind: 'taken', detail: r.error ?? '' };
}

export type AutonomyWarning = 'bypass' | 'bypass_autostart';

/**
 * Warnings the owner must see before trusting the assistant this far. Bypass lets it act on
 * text it read from a project without asking; bypass that also starts on login means it is
 * doing so from the moment the Mac boots, before the owner has looked at anything.
 */
export function autonomyWarnings(autonomy: AssistantAutonomy, autostart: boolean): AutonomyWarning[] {
  if (autonomy !== 'bypass') return [];
  return autostart ? ['bypass', 'bypass_autostart'] : ['bypass'];
}

// ─── Avatar ───────────────────────────────────────────────────────────────────────

/** The server's cap (`AVATAR_MAX_BYTES`), checked here first so a big file is refused before
 *  it is read and sent. The server stays the authority. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp';

export type AvatarRefusal = 'svg' | 'too_large' | 'unsupported' | 'empty';

/** Refuse what the server would refuse, from what the picker tells us, before reading bytes. */
export function checkAvatarFile(f: { name: string; type: string; size: number }): AvatarRefusal | null {
  if (f.size === 0) return 'empty';
  if (f.type === 'image/svg+xml' || /\.svgz?$/i.test(f.name)) return 'svg';
  if (f.size > AVATAR_MAX_BYTES) return 'too_large';
  return null;
}

/** Sniff the image kind from its first bytes — the same magic numbers the server checks. */
export function sniffAvatarBytes(b: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}

// ─── Steps ────────────────────────────────────────────────────────────────────────

export const WIZARD_STEPS = [
  'name', 'avatar', 'character', 'hotkey', 'autonomy', 'voice', 'autostart', 'permissions', 'wake',
] as const;
export type WizardStep = typeof WIZARD_STEPS[number];

/** Name rule, same as the server's (`1-40` characters after trimming). */
export const NAME_MAX = 40;
export const CHARACTER_MAX = 4000;
export function isValidAssistantName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= NAME_MAX;
}

/** Substitute `{name}` placeholders in an i18n string (`t()` itself is a plain lookup). */
export function fillCopy(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
}
