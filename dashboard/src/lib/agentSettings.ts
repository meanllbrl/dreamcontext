/**
 * Agents (beta) surface preferences — feature on/off, restore-past-tabs, default
 * agent, and the in-app open/close hotkey. Mirrors lib/sleepy.ts's persistence
 * shape: localStorage for the live launch + a server-side file
 * (~/.dreamcontext/agent-ui.json) that survives the app's per-launch origin reset.
 *
 * These are surface preferences shared by every project window, so they're
 * app-global (not vault-scoped). The Settings page writes them; the persistent
 * AgentSurface reads them and re-applies live via the window event below.
 *
 * ONE field is deliberately NOT in this blob: `chatPermissionMode`. It is a permission
 * gate, not a surface preference — see {@link readChatPermissionMode} at the bottom of
 * this file.
 */
import { api } from '../api/client';
import { SCOPE_PREFIX } from './scopedStorage';
import { emitInstance } from '../context/VaultContext';

/** localStorage key (versioned so a shape change can invalidate cleanly). */
const CONFIG_KEY = 'agent:settings:v1';

/** Dispatched on `window` after a write so the always-mounted AgentSurface picks
 *  up a Settings-page change immediately (same pattern as `dreamcontext-zoom`).
 *
 *  Its `detail` is the WHOLE coerced {@link AgentSettings} blob, never a patch — so every
 *  field added to that interface rides this event by construction, including the chat
 *  model/effort defaults a composer "Set as default" writes. That is what lets a change made
 *  in one surface reach `AgentSurface`'s spawn path without a reload. */
export const AGENT_SETTINGS_EVENT = 'dreamcontext-agent-settings';

/** The only agent backend today; typed as a union so adding one later is a compile
 *  step, not a magic string. */
export type DefaultAgent = 'claude';

/** How xterm paints the terminal. `webgl` = GPU renderer: full frame rate under
 *  Claude's heavy TUI streams (the smoothness path), glyphs from a canvas atlas.
 *  `dom` = real text nodes with native macOS font smoothing: the softest glyph
 *  edges, but the renderer can stutter when output redraws fast. */
export type AgentRenderer = 'webgl' | 'dom';

export interface AgentSettings {
  /** Show the Agents surface at all (FAB / dock / overlay). Off → fully hidden. */
  enabled: boolean;
  /** Restore the previous session tabs on launch (off → always start clean). */
  restoreTabs: boolean;
  /** Which agent a new session runs (only Claude Code for now). */
  defaultAgent: DefaultAgent;
  /** After a session's first turn, let Haiku rename its tab from the first message.
   *  Off by default — an opt-in that costs a (cheap) Haiku call per session. */
  autoTitle: boolean;
  /** In-app accelerator that toggles the Agents overlay, e.g. "Ctrl+A". */
  hotkey: string;
  /** Terminal renderer. Default `webgl` (smoothness); `dom` opts back into the
   *  native-text comfort rendering. Applied live to open sessions. */
  renderer: AgentRenderer;
  /** The "Agent screen" preference (Settings → Agents): which surface a Claude session
   *  opens as. `true` = Chat — the SAME engine rendered as native chat UI (markdown
   *  bubbles, tool cards, question/permission cards) and the DEFAULT since 0.22;
   *  `false` = Terminal (legacy) — the classic embedded TUI, kept for anyone who wants
   *  the raw surface back. Mutually exclusive by design: the chosen surface takes over
   *  every Claude entry point (＋ New, ⌘T/⌘D, tab restore/resume, Sleep/delegate spawns);
   *  running sessions keep their surface. Key name kept from the original beta checkbox
   *  for agent-ui.json compatibility. */
  chatView: boolean;
  /** Remembered default MODEL for a new Chat session — written by the composer's model+effort
   *  menu ("Set as default"), read by `AgentSurface`'s spawn when the caller named no model.
   *  EMPTY STRING is the resting value, not a missing one: it means "inherit whatever the
   *  Claude CLI itself defaults to" (`~/.claude/settings.json`), so nothing is forced at
   *  launch until the user deliberately pins a model. */
  chatDefaultModel: string;
  /** Remembered default EFFORT level for a new Chat session — same menu, same
   *  empty-string-means-inherit contract as {@link AgentSettings.chatDefaultModel}. */
  chatDefaultEffort: string;
  /** One-time marker that this blob has been through the "Chat is the default screen"
   *  flip (0.22). Before the flip, `chatView:false` was written into EVERY persisted
   *  blob as the old opt-out default, so a raw `false` is not evidence anybody chose
   *  Terminal — it is just the old default. Until this marker is present, `chatView`
   *  is forced TRUE regardless of what is on disk, which is what moves existing users
   *  onto Chat; from the first coerce onward the marker rides along, so a DELIBERATE
   *  switch back to Terminal (legacy) in Settings sticks forever after. */
  screenMigrated: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: true,
  restoreTabs: true,
  defaultAgent: 'claude',
  autoTitle: false,
  hotkey: 'Ctrl+A',
  renderer: 'webgl',
  chatView: true,
  screenMigrated: true,
  chatDefaultModel: '',
  chatDefaultEffort: '',
};

/** MIRRORED from `sanitizeModel` in `src/server/routes/agent-spawn-shared.ts`. The dashboard
 *  cannot import that module (it is a Node/server file), so the rule is re-spelled here and
 *  the two are pinned together by `tests/unit/agent-settings.test.ts`, which runs the SAME
 *  input table through both coercers and asserts identical output. Claude Code's `--model`
 *  takes an alias (`opus`) or a full model id — all `[A-Za-z0-9._-]`, never a shell
 *  metacharacter, never over 64 chars. */
const CHAT_DEFAULT_MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** MIRRORED from `EFFORT_LEVELS` in `src/server/routes/agent-spawn-shared.ts` — the levels
 *  `claude --effort` documents. Same pinning as above. */
const CHAT_DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Coerce an arbitrary blob to a valid AgentSettings (defaults fill gaps). `enabled`
 *  and `restoreTabs` default TRUE (only an explicit `false` disables, so a missing key
 *  never silently hides the surface); `autoTitle` defaults FALSE (opt-in — only an
 *  explicit `true` turns tab auto-naming on); `chatView` defaults TRUE but honours an
 *  explicit `false` only on a `screenMigrated` blob (see the field docs above — that
 *  gate is the one-time move of existing users onto the Chat surface). */
export function coerceAgentSettings(raw: Partial<AgentSettings> | null | undefined): AgentSettings {
  const r = raw ?? {};
  return {
    enabled: r.enabled !== false,
    restoreTabs: r.restoreTabs !== false,
    defaultAgent: r.defaultAgent === 'claude' ? 'claude' : DEFAULT_AGENT_SETTINGS.defaultAgent,
    autoTitle: r.autoTitle === true,
    hotkey: typeof r.hotkey === 'string' && r.hotkey.trim() ? r.hotkey.trim() : DEFAULT_AGENT_SETTINGS.hotkey,
    // Only an explicit 'dom' opts back into comfort rendering; anything else
    // (absent key, old blob, garbage) lands on the smooth GPU default.
    renderer: r.renderer === 'dom' ? 'dom' : DEFAULT_AGENT_SETTINGS.renderer,
    // Agent screen. Chat is the standard surface, so this is a default-TRUE flag — but an
    // explicit `false` only counts once the blob has been through the 0.22 flip, because
    // every pre-flip blob carries `chatView:false` from the old opt-in default. Un-migrated
    // blob → Chat (that IS the migration); migrated blob → whatever the user picked.
    chatView: r.screenMigrated === true ? r.chatView !== false : true,
    screenMigrated: true,
    // The two chat defaults reject to '' — which is not a failure state but the documented
    // "inherit the CLI's own default". Validated on this side too, not only server-side:
    // `readAgentSettings` parses localStorage, so a hand-edited or stale store reaches this
    // function without ever passing through the route's coercer.
    chatDefaultModel: typeof r.chatDefaultModel === 'string' && CHAT_DEFAULT_MODEL_RE.test(r.chatDefaultModel)
      ? r.chatDefaultModel : '',
    chatDefaultEffort: typeof r.chatDefaultEffort === 'string' && CHAT_DEFAULT_EFFORT_LEVELS.includes(r.chatDefaultEffort)
      ? r.chatDefaultEffort : '',
    // NOTE: a legacy blob's `chatPermissionMode` is dropped here, on purpose — it is no
    // longer part of this shape. See {@link readChatPermissionMode}.
  };
}

export function readAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return coerceAgentSettings(JSON.parse(raw) as Partial<AgentSettings>);
  } catch {
    /* fall through to default */
  }
  return { ...DEFAULT_AGENT_SETTINGS };
}

function writeLocal(cfg: AgentSettings): void {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* best-effort */ }
}

/**
 * Persist the settings: localStorage (live this launch) + server-side
 * (~/.dreamcontext/agent-ui.json, survives the per-launch origin change) + a
 * window event so the mounted AgentSurface re-applies them without a reload.
 */
export function writeAgentSettings(cfg: AgentSettings): void {
  writeLocal(cfg);
  void api.post('/launcher/agent-settings', cfg).catch(() => {});
  try { window.dispatchEvent(new CustomEvent<AgentSettings>(AGENT_SETTINGS_EVENT, { detail: cfg })); } catch { /* SSR/none */ }
}

/**
 * Change SOME settings, leaving the rest exactly as they are on disk right now.
 *
 * Use this, not `writeAgentSettings({ ...snapshot, one: value })`, whenever a control owns a
 * single field. The whole-object form silently rewrites every OTHER field from whatever the
 * caller's React render captured — and a component that rendered before
 * `initAgentSettingsFromServer` resolved is holding DEFAULTS, so flipping one toggle can
 * quietly revert unrelated ones (observed: changing the chat permission mode reset
 * `chatView` to its default `false`, which silently moved every new session back to the
 * terminal surface). Merging against the freshest persisted value at write time removes the
 * whole class of bug.
 */
export function patchAgentSettings(patch: Partial<AgentSettings>): AgentSettings {
  const next = coerceAgentSettings({ ...readAgentSettings(), ...patch });
  writeAgentSettings(next);
  return next;
}

/**
 * Load the persisted settings from the server and seed localStorage (each launch
 * starts on a fresh origin with empty localStorage). Falls back to local/defaults
 * if the server is unreachable. Call once on AgentSurface mount.
 */
export async function initAgentSettingsFromServer(): Promise<AgentSettings> {
  try {
    const raw = await api.get<Partial<AgentSettings>>('/launcher/agent-settings');
    const cfg = coerceAgentSettings(raw);
    writeLocal(cfg);
    return cfg;
  } catch {
    return readAgentSettings();
  }
}

// ─── Chat permission mode — PER VAULT, split out of the global blob ─────────────
//
// `'auto'` maps to the CLI's `auto` mode (NOT `acceptEdits` — that one asks on every
// non-edit command), `'bypass'` to `bypassPermissions` — the same mapping as
// `permissionModeFor` in `src/server/routes/agent-chat.ts`. The chosen mode applies to the
// NEXT chat session spawned (new, split, resume, sleep/brain/delegate, skill-insert
// fallback) AND to every running one (`changeChatPermissionMode` → `set_permission_mode`).
//
// WHY IT LEFT THE BLOB. Everything else above is a surface preference that is genuinely the
// same in every project. This one is a permission gate: it decides whether an agent
// auto-approves everything it is asked to do, against one project's files and one project's
// git. It could not cross projects while each vault owned an OS window (one JS realm per
// project). With several live projects in ONE window it would: flipping bypass while looking
// at project A rewrites the remembered default for B, and every session B spawns afterwards
// runs auto-approved in a project the user never touched. So the value is stored per vault
// and its change notification rides the INSTANCE BUS, never `window`.

export type ChatPermissionMode = 'auto' | 'bypass';

/** Storage key. Namespaced per vault by {@link permissionModeStorageKey}, never read bare. */
export const CHAT_PERMISSION_MODE_KEY = 'agent:settings:chatPermissionMode';

/** Change notification. Dispatched on the INSTANCE BUS (`useVault().bus`), not `window` —
 *  a permission change must reach only the project it was made in. */
export const CHAT_PERMISSION_MODE_EVENT = 'dc-chat-permission-mode';

/**
 * The one key in the app that is namespaced by hand rather than through
 * `scopedStorage`'s `readScopedRaw`/`writeScopedRaw`.
 *
 * MIGRATION IS THE REASON, and it is deliberate. `readScopedRaw` MOVES a value found at the
 * bare legacy key into the first vault that reads it — the right default for a preference,
 * and precisely wrong for this one: the pre-split value must be DROPPED, not carried forward,
 * because a `'bypass'` set once when it meant "this window's project" would otherwise fan out
 * to a project the user never opted in for. Relying on "the key is new so nothing is at the
 * bare name" would make that safety an accident of history — an old build, a hand-edited
 * store or a future rename would silently resurrect it, and a permission gate must not fail
 * open on a coincidence. So the bare name is never read, for a null vault either.
 *
 * `SCOPE_PREFIX` is still imported rather than re-spelled, so the namespace stays
 * single-sourced with the rest of the scoped keys.
 */
function permissionModeStorageKey(vault: string | null): string {
  return `${SCOPE_PREFIX}${vault ?? ''}:${CHAT_PERMISSION_MODE_KEY}`;
}

/**
 * This vault's remembered chat permission mode.
 *
 * Only an exact `'bypass'` opts into the caution mode; absent, stale, malformed or unreadable
 * storage all read as `'auto'` — the same posture the old `coerceAgentSettings` held, and the
 * only safe direction for a value that decides whether an agent auto-approves everything.
 * Every vault therefore starts at `'auto'` and the user re-opts-in per project: a one-time
 * reset of a permission toggle, which is the correct trade.
 */
export function readChatPermissionMode(vault: string | null): ChatPermissionMode {
  try {
    return localStorage.getItem(permissionModeStorageKey(vault)) === 'bypass' ? 'bypass' : 'auto';
  } catch {
    return 'auto'; // storage unavailable (private mode) — fail safe, never open
  }
}

/** Persist this vault's mode and tell THIS instance's surfaces about it. */
export function writeChatPermissionMode(bus: EventTarget, vault: string | null, mode: ChatPermissionMode): void {
  try {
    localStorage.setItem(permissionModeStorageKey(vault), mode);
  } catch { /* quota/disabled — the live sessions below still get the change */ }
  emitInstance<ChatPermissionMode>(bus, CHAT_PERMISSION_MODE_EVENT, mode);
}

/**
 * Build a Tauri-style accelerator string (e.g. "Ctrl+A", "Alt+Cmd+S") from a
 * keydown, or null if it's modifier-only / has no modifier. Shared by the Settings
 * capture input and the matcher below so both speak the same format.
 */
export function accelFromKeyEvent(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push('Cmd');
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (mods.length === 0) return null; // a toggle chord needs at least one modifier
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else key = key.charAt(0).toUpperCase() + key.slice(1);
  return [...mods, key].join('+');
}

/** True when a keydown matches the stored accelerator (modifier set + key, order-
 *  independent, case-insensitive on the key). */
export function matchesAccel(e: KeyboardEvent, accel: string): boolean {
  const built = accelFromKeyEvent(e);
  if (!built) return false;
  const norm = (s: string) => s.split('+').map((p) => p.trim().toLowerCase()).sort().join('+');
  return norm(built) === norm(accel);
}

// ─── Double-tap-a-single-modifier bindings ──────────────────────────────────────
// A second flavour of hotkey: instead of a chord, press ONE modifier twice quickly
// (⌃⌃, ⌥⌥, ⌘⌘, ⇧⇧, or Fn Fn where the platform reports it). Stored as "Ctrl+Ctrl"
// etc. — a form no real chord can ever produce, so it never collides with the chord
// matcher above. Fn is best-effort: many browsers/webviews don't emit a keydown for
// it, in which case the binding simply never fires (Ctrl/Option/⌘/Shift are reliable).

/** How close together the two taps must land, in ms. */
export const DOUBLE_TAP_MS = 400;

/** KeyboardEvent.key for a bare modifier → its accelerator token (else no entry). */
const LONE_MOD_TO_TOKEN: Record<string, string> = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Meta: 'Cmd',
  Shift: 'Shift',
  Fn: 'Fn',
  FnLock: 'Fn',
};

/** If a keydown is a *lone* modifier press (the modifier key itself, nothing else),
 *  return its token (Ctrl/Alt/Cmd/Shift/Fn); otherwise null. */
export function loneModifierToken(e: Pick<KeyboardEvent, 'key'>): string | null {
  return LONE_MOD_TO_TOKEN[e.key] ?? null;
}

/** If a stored accelerator is a double-tap binding ("Ctrl+Ctrl"), return the token;
 *  otherwise null. */
export function doubleTapToken(accel: string): string | null {
  const parts = accel.split('+').map((p) => p.trim());
  if (parts.length === 2 && parts[0] && parts[0] === parts[1] &&
      Object.values(LONE_MOD_TO_TOKEN).includes(parts[0])) {
    return parts[0];
  }
  return null;
}

/** Human-readable rendering of a stored accelerator — double-taps become e.g.
 *  "Ctrl ×2"; ordinary chords are shown as-is. */
export function formatHotkey(accel: string): string {
  const dt = doubleTapToken(accel);
  return dt ? `${dt} ×2` : accel;
}

/**
 * Build a stateful matcher for a double-tap binding. Returns a function to feed every
 * keydown; it returns true exactly on the second qualifying tap of `token` within the
 * window. Auto-repeat (holding the key) is ignored, and any intervening different key
 * resets the pending tap so only two *deliberate* presses in a row count.
 */
export function createDoubleTapMatcher(token: string, windowMs = DOUBLE_TAP_MS): (e: KeyboardEvent) => boolean {
  let lastTs = 0;
  return (e: KeyboardEvent): boolean => {
    if (loneModifierToken(e) !== token) {
      // A different key breaks the sequence (ignore auto-repeat noise of a held key).
      if (!e.repeat) lastTs = 0;
      return false;
    }
    if (e.repeat) return false; // holding the modifier isn't a second tap
    const now = Date.now();
    if (lastTs !== 0 && now - lastTs <= windowMs) {
      lastTs = 0;
      return true;
    }
    lastTs = now;
    return false;
  };
}
