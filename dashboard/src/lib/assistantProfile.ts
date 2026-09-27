/**
 * The Launcher's client for the dreamcontext Assistant: the owner routes under
 * `/api/assistant/*` (see `src/server/routes/assistant.ts`) and the three desktop-shell
 * commands the wizard drives (`desktop/src-tauri/src/assistant.rs`).
 *
 * Every route here is OWNER-gated on the server (loopback + desktop app); a browser tab gets
 * `403 assistant_local_only`, which surfaces as an {@link AssistantApiError} with that code.
 * The Tauri wrappers never throw: off the desktop they resolve to an honest `desktopOnly`
 * result, and a shell error becomes `{ ok: false, error }` so the wizard can say it.
 */
import { isDesktop } from './desktop';
import {
  checkAvatarFile, sniffAvatarBytes,
  type AssistantAutonomy, type AssistantHotkey, type HotkeyApplyResult,
} from '../components/assistant/assistantWizardLogic';

export interface AssistantConfig {
  name: string;
  hotkey: AssistantHotkey | null;
  autonomy: AssistantAutonomy;
  autostart: boolean;
  conversationId: string | null;
  speak: boolean;
}

export interface AssistantStatus {
  exists: boolean;
  vault: string;
  config: AssistantConfig | null;
  /** Route to the avatar image, or null when none is set. */
  avatar: string | null;
  /** Pending proposals waiting on the owner. */
  proposals: number;
}

export interface AssistantProfile {
  config: AssistantConfig;
  character: string;
  avatar: string | null;
}

export interface AssistantProfilePatch {
  name?: string;
  autonomy?: AssistantAutonomy;
  autostart?: boolean;
  speak?: boolean;
  hotkey?: AssistantHotkey | null;
  character?: string;
}

/** A refused request, carrying the server's own `error` code and human `message`. */
export class AssistantApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'AssistantApiError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null) as (Record<string, unknown> | null);
  if (!res.ok) {
    const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
    const message = typeof body?.message === 'string' ? body.message : `Request failed (${res.status}).`;
    throw new AssistantApiError(code, message, res.status);
  }
  return body as T;
}

const json = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

/** GET /api/assistant/status */
export function getAssistantStatus(): Promise<AssistantStatus> {
  return request<AssistantStatus>('/api/assistant/status');
}

/** POST /api/assistant/create — scaffolds the hidden vault (idempotent; slow on first run). */
export async function createAssistant(input: { name: string; character?: string; autonomy?: AssistantAutonomy }): Promise<AssistantConfig | null> {
  const out = await request<{ created: boolean; config: AssistantConfig | null }>('/api/assistant/create', json(input));
  return out.config;
}

/** GET /api/assistant/profile — 404 `no_assistant` before creation. */
export function getProfile(): Promise<AssistantProfile> {
  return request<AssistantProfile>('/api/assistant/profile');
}

/** POST /api/assistant/profile — merges the patch; returns the stored config. */
export async function saveProfile(patch: AssistantProfilePatch): Promise<AssistantConfig> {
  const out = await request<{ config: AssistantConfig }>('/api/assistant/profile', json(patch));
  return out.config;
}

/**
 * POST /api/assistant/avatar with the RAW bytes. Refused here first (SVG, over 2 MB, not a
 * PNG/JPEG/WebP by its magic bytes) so nothing doomed is sent; the server re-checks all of it
 * and its message is surfaced verbatim on 400/413.
 */
export async function uploadAvatar(file: Blob & { name?: string }): Promise<{ url: string }> {
  const refusal = checkAvatarFile({ name: file.name ?? '', type: file.type, size: file.size });
  if (refusal) throw new AssistantApiError(`avatar_${refusal}`, refusal, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!sniffAvatarBytes(bytes)) throw new AssistantApiError('avatar_unsupported', 'unsupported', 400);
  const out = await request<{ ok: boolean; url: string }>('/api/assistant/avatar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  return { url: out.url };
}

// ─── Voice key (the existing voice settings store: ~/.dreamcontext/voice.json) ────────────

/** Whether a voice key is stored. The server never returns the key itself. */
export async function getVoiceKeySet(): Promise<boolean> {
  const out = await request<{ key: boolean }>('/api/agent/voice/status');
  return !!out.key;
}

/** Write (or clear, with null) the voice key through the SAME route Settings → Voice uses. */
export async function saveVoiceKey(key: string | null): Promise<boolean> {
  const out = await request<{ key: boolean }>('/api/agent/voice/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openRouterKey: key }),
  });
  return !!out.key;
}

// ─── Desktop shell commands ─────────────────────────────────────────────────────────

const DESKTOP_ONLY: HotkeyApplyResult = { ok: false, chord: null, error: null, desktopOnly: true };

interface RawHotkeyStatus { ok?: unknown; chord?: unknown; error?: unknown }

function normalizeHotkeyStatus(raw: RawHotkeyStatus | null | undefined): HotkeyApplyResult {
  return {
    ok: raw?.ok === true,
    chord: typeof raw?.chord === 'string' ? raw.chord : null,
    error: typeof raw?.error === 'string' ? raw.error : null,
  };
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  return err instanceof Error ? err.message : String(err);
}

async function invokeShell<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** Re-read the saved chord and (re)register it. The result is the shell's REAL answer. */
export async function applyAssistantHotkey(): Promise<HotkeyApplyResult> {
  if (!isDesktop()) return DESKTOP_ONLY;
  try {
    return normalizeHotkeyStatus(await invokeShell<RawHotkeyStatus>('assistant_apply_hotkey'));
  } catch (err) {
    return { ok: false, chord: null, error: errorText(err) };
  }
}

export interface AutostartResult {
  ok: boolean;
  /** The Login Item's state after the call, as the OS reports it. */
  enabled: boolean;
  error: string | null;
  desktopOnly?: boolean;
}

/** Turn the Login Item on or off; resolves to the resulting state. */
export async function setAssistantAutostart(enabled: boolean): Promise<AutostartResult> {
  if (!isDesktop()) return { ok: false, enabled: false, error: null, desktopOnly: true };
  try {
    const now = await invokeShell<boolean>('assistant_set_autostart', { enabled });
    return { ok: true, enabled: now === true, error: null };
  } catch (err) {
    // The shell refused before changing anything, so the Login Item is still where it was.
    return { ok: false, enabled: !enabled, error: errorText(err) };
  }
}

export interface WakeResult {
  /** True when the notch is up. */
  woke: boolean;
  /** The hotkey registration the wake performed (meaningful only when `woke`). */
  hotkey: HotkeyApplyResult;
  /** Why the notch could not be shown. */
  error: string | null;
  desktopOnly?: boolean;
}

/** Show the notch and register the hotkey. */
export async function wakeAssistant(): Promise<WakeResult> {
  if (!isDesktop()) return { woke: false, hotkey: DESKTOP_ONLY, error: null, desktopOnly: true };
  try {
    const hotkey = normalizeHotkeyStatus(await invokeShell<RawHotkeyStatus>('assistant_wake'));
    return { woke: true, hotkey, error: null };
  } catch (err) {
    return { woke: false, hotkey: { ok: false, chord: null, error: null }, error: errorText(err) };
  }
}
