import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The dreamcontext Assistant's HIDDEN vault — a normal `_dream_context/` that lives at
 * `~/.dreamcontext/assistant/` and is deliberately NOT in `vaults.json`.
 *
 * WHY HIDDEN. The assistant sits ABOVE every project: its soul is the character the owner
 * gave it and its memory is what it learned about the owner. Registering it as a vault would
 * put it in the Launcher, the ⌘P switcher, the peer list and federation — every surface that
 * says "your projects" would then list the thing that manages them. So it is reached by ONE
 * reserved name, {@link ASSISTANT_VAULT}, and every resolver states explicitly whether it
 * accepts that name (see `tests/unit/assistant-resolver-contract.test.ts`, which pins each).
 *
 * `home` is injectable everywhere (`pattern-test-isolation-injectable`), defaulting to the
 * real home directory.
 */

/** The one reserved vault name the assistant is reached by. Double underscores so it can
 *  never collide with a folder-derived vault name, and `addVault` refuses it outright. */
export const ASSISTANT_VAULT = '__assistant__';

export function isAssistantVault(name: unknown): boolean {
  return name === ASSISTANT_VAULT;
}

/** `~/.dreamcontext/assistant` — the assistant's project root (claude's cwd). */
export function assistantProjectRoot(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'assistant');
}

/** The hidden vault's `_dream_context/`. */
export function assistantContextRoot(home: string = homedir()): string {
  return join(assistantProjectRoot(home), '_dream_context');
}

/** True once `POST /api/assistant/create` has scaffolded the hidden vault. */
export function assistantExists(home: string = homedir()): boolean {
  return existsSync(assistantContextRoot(home));
}

// ─── Config ──────────────────────────────────────────────────────────────────────────

export const AUTONOMY_LEVELS = ['ask', 'auto', 'bypass'] as const;
export type Autonomy = typeof AUTONOMY_LEVELS[number];

export interface AssistantHotkey {
  /** Physical `KeyboardEvent.code` — never a layout-dependent character. */
  code: string;
  mods: string[];
  mode: 'hold' | 'toggle';
}

export interface AssistantConfig {
  name: string;
  hotkey: AssistantHotkey | null;
  autonomy: Autonomy;
  autostart: boolean;
  /** The one long-lived conversation the notch resumes on every summon. */
  conversationId: string | null;
  speak: boolean;
}

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  name: 'Assistant',
  hotkey: null,
  autonomy: 'ask',
  autostart: false,
  conversationId: null,
  speak: false,
};

export function assistantConfigPath(home: string = homedir()): string {
  return join(assistantProjectRoot(home), 'config.json');
}

const MODS = new Set(['Meta', 'Control', 'Alt', 'Shift']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict-pick a (partial) config from untrusted input. Unknown keys are dropped and a bad
 * value is dropped rather than coerced, so a PATCH can never write a shape the rest of the
 * app would misread. Exported for tests.
 */
export function sanitizeConfigPatch(raw: unknown): Partial<AssistantConfig> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<AssistantConfig> = {};
  if (typeof r.name === 'string' && r.name.trim() && r.name.trim().length <= 40) out.name = r.name.trim();
  if (typeof r.autonomy === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(r.autonomy)) {
    out.autonomy = r.autonomy as Autonomy;
  }
  if (typeof r.autostart === 'boolean') out.autostart = r.autostart;
  if (typeof r.speak === 'boolean') out.speak = r.speak;
  if (r.conversationId === null) out.conversationId = null;
  else if (typeof r.conversationId === 'string' && UUID_RE.test(r.conversationId)) out.conversationId = r.conversationId;
  if (r.hotkey === null) out.hotkey = null;
  else if (r.hotkey && typeof r.hotkey === 'object') {
    const h = r.hotkey as Record<string, unknown>;
    const code = typeof h.code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(h.code) ? h.code : '';
    const mods = Array.isArray(h.mods) ? h.mods.filter((m): m is string => typeof m === 'string' && MODS.has(m)) : [];
    const mode = h.mode === 'toggle' ? 'toggle' : 'hold';
    // A bare key (no modifier) would fire on every keystroke in every app — refused, the
    // same rule the composer's push-to-talk chord follows.
    if (code && mods.length > 0) out.hotkey = { code, mods: [...new Set(mods)], mode };
  }
  return out;
}

export function readAssistantConfig(home: string = homedir()): AssistantConfig | null {
  const p = assistantConfigPath(home);
  if (!existsSync(p)) return null;
  try {
    return { ...DEFAULT_ASSISTANT_CONFIG, ...sanitizeConfigPatch(JSON.parse(readFileSync(p, 'utf-8'))) };
  } catch {
    return { ...DEFAULT_ASSISTANT_CONFIG };
  }
}

/** Merge `patch` into the stored config and write it 0600 (it names the hotkey and the
 *  conversation; nothing secret, but nothing another user on the box should read either). */
export function writeAssistantConfig(patch: Partial<AssistantConfig>, home: string = homedir()): AssistantConfig {
  const next = { ...(readAssistantConfig(home) ?? DEFAULT_ASSISTANT_CONFIG), ...sanitizeConfigPatch(patch) };
  const p = assistantConfigPath(home);
  mkdirSync(assistantProjectRoot(home), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* best-effort on filesystems without modes */ }
  return next;
}
