/**
 * Agents (beta) surface preferences — feature on/off, restore-past-tabs, default
 * agent, and the in-app open/close hotkey. Mirrors lib/sleepy.ts's persistence
 * shape: localStorage for the live launch + a server-side file
 * (~/.dreamcontext/agent-ui.json) that survives the app's per-launch origin reset.
 *
 * These are surface preferences shared by every project window, so they're
 * app-global (not vault-scoped). The Settings page writes them; the persistent
 * AgentSurface reads them and re-applies live via the window event below.
 */
import { api } from '../api/client';

/** localStorage key (versioned so a shape change can invalidate cleanly). */
const CONFIG_KEY = 'agent:settings:v1';

/** Dispatched on `window` after a write so the always-mounted AgentSurface picks
 *  up a Settings-page change immediately (same pattern as `dreamcontext-zoom`). */
export const AGENT_SETTINGS_EVENT = 'dreamcontext-agent-settings';

/** The only agent backend today; typed as a union so adding one later is a compile
 *  step, not a magic string. */
export type DefaultAgent = 'claude';

export interface AgentSettings {
  /** Show the Agents surface at all (FAB / dock / overlay). Off → fully hidden. */
  enabled: boolean;
  /** Restore the previous session tabs on launch (off → always start clean). */
  restoreTabs: boolean;
  /** Which agent a new session runs (only Claude Code for now). */
  defaultAgent: DefaultAgent;
  /** After a session's first turn, let Haiku rename its tab from the first message. */
  autoTitle: boolean;
  /** In-app accelerator that toggles the Agents overlay, e.g. "Ctrl+A". */
  hotkey: string;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: true,
  restoreTabs: true,
  defaultAgent: 'claude',
  autoTitle: true,
  hotkey: 'Ctrl+A',
};

/** Coerce an arbitrary blob to a valid AgentSettings (defaults fill gaps). The two
 *  flags default TRUE — only an explicit `false` disables, so a missing key never
 *  silently hides the surface. */
export function coerceAgentSettings(raw: Partial<AgentSettings> | null | undefined): AgentSettings {
  const r = raw ?? {};
  return {
    enabled: r.enabled !== false,
    restoreTabs: r.restoreTabs !== false,
    defaultAgent: r.defaultAgent === 'claude' ? 'claude' : DEFAULT_AGENT_SETTINGS.defaultAgent,
    autoTitle: r.autoTitle !== false,
    hotkey: typeof r.hotkey === 'string' && r.hotkey.trim() ? r.hotkey.trim() : DEFAULT_AGENT_SETTINGS.hotkey,
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
