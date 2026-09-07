/**
 * The voice feature's ONE secret and its three non-secret preferences, on disk at
 * `~/.dreamcontext/voice.json`.
 *
 * ONE KEY FOR ALL THREE CALLS — transcription, the correction pass, and speech — and it is
 * an OpenRouter key. This is the owner's explicit instruction and it is not a shape to
 * generalise later: no OpenAI key is read, requested, or fallen back to anywhere in this
 * feature. The reason is measured rather than ideological. Local whisper saves about a
 * dollar a month, and OpenAI-via-anyone at $15 per million characters is already the FLOOR
 * of hosted TTS (Cartesia and ElevenLabs are 3x, premium voices 15x). A second provider
 * buys nothing that the `instructions` parameter does not already give us.
 *
 * WHY A FILE AND NOT THE VAULT. The key belongs to the machine's owner, not to a project.
 * Putting it in a vault would sync it to a teammate's brain the first time anyone ran a
 * team sync. `~/.dreamcontext/` is where this codebase already keeps per-machine secrets
 * (`claude-accounts.json`, `vaults.json`), and the 0600 atomic write below is
 * `claude-account-sandbox.ts:139`'s, unchanged.
 *
 * THE KEY NEVER LEAVES THE SERVER. {@link voiceStatus} reports a BOOLEAN and the non-secret
 * preferences; there is no route, no log line and no error path that returns the key itself.
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** What lives in `voice.json`. Every field is optional — an absent file is a valid state. */
export interface VoiceConfig {
  /** The OpenRouter API key. The ONLY secret this feature has. */
  openRouterKey?: string;
  /** TTS voice name passed through to the speech endpoint. */
  voice?: string;
  /**
   * STT language hint. `'auto'` (the default) sends no `language` at all and lets the model
   * detect it. Pinning a language is the documented escape hatch for AC4: auto-detect on
   * SHORT takes is unproven on this code path — the only benchmark ever run used an explicit
   * `-l tr` against LOCAL whisper, which is not this path — so if it misfires in the real
   * app, the fix is a pinned default here rather than a code change.
   */
  sttLanguage?: string;
  /** Whether the Slice-2 correction pass runs at all. Off degrades to the raw transcript. */
  correction?: boolean;
}

/** The default voice. A deep one — the closest this provider gets to the character. */
export const DEFAULT_VOICE = 'onyx';

/** Language sentinel meaning "send no `language` parameter and let the model detect". */
export const AUTO_LANGUAGE = 'auto';

/** The register file. Injectable `home` for testability (precedent: `vaults.ts:39`). */
export function voiceConfigPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'voice.json');
}

/** Read the config. A missing, unreadable or malformed file is an EMPTY config, never a
 *  throw: a corrupt preferences file must degrade the mode to "no key", not break the app. */
export function readVoiceConfig(home: string = homedir()): VoiceConfig {
  const path = voiceConfigPath(home);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const raw = parsed as Record<string, unknown>;
    const out: VoiceConfig = {};
    if (typeof raw.openRouterKey === 'string' && raw.openRouterKey.trim()) {
      out.openRouterKey = raw.openRouterKey.trim();
    }
    if (typeof raw.voice === 'string' && raw.voice.trim()) out.voice = raw.voice.trim();
    if (typeof raw.sttLanguage === 'string') out.sttLanguage = raw.sttLanguage.trim();
    if (typeof raw.correction === 'boolean') out.correction = raw.correction;
    return out;
  } catch {
    return {};
  }
}

/** Atomic 0600 write: temp file (pid+nonce) → `rename`. A reader never sees a half file.
 *  Lifted unchanged from `claude-account-sandbox.ts:139` — same secrecy class, same idiom. */
function writeAtomic0600(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, filePath);
}

/**
 * Merge `patch` into the stored config and write it back, returning the merged result.
 *
 * A field set to `null` is DELETED — that is how Settings clears the key without a second
 * verb. `undefined` means "leave it alone", so a Settings page saving only the voice picker
 * cannot blank the key it never rendered.
 */
export function writeVoiceConfig(
  patch: Partial<Record<keyof VoiceConfig, string | boolean | null | undefined>>,
  home: string = homedir(),
): VoiceConfig {
  const current = readVoiceConfig(home);
  const next: VoiceConfig = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    const key = k as keyof VoiceConfig;
    if (v === undefined) continue;
    if (v === null || v === '') { delete next[key]; continue; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (next as any)[key] = typeof v === 'string' ? v.trim() : v;
  }
  writeAtomic0600(voiceConfigPath(home), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * The key, or null. Reads the file first, then `OPENROUTER_API_KEY` from the environment.
 *
 * The env fallback exists so a machine that already exports the key (and every test in this
 * suite) never has to write a real secret to a real home directory. The FILE wins when both
 * are present, because that is the one the Settings card can actually change.
 */
export function voiceApiKey(home: string = homedir()): string | null {
  const stored = readVoiceConfig(home).openRouterKey;
  if (stored) return stored;
  const env = process.env.OPENROUTER_API_KEY;
  return env && env.trim() ? env.trim() : null;
}

/** What Settings and the composer are allowed to know. Note `key` is a BOOLEAN: there is
 *  deliberately no route by which the key itself travels back to a client. */
export interface VoiceStatus {
  key: boolean;
  voice: string;
  sttLanguage: string;
  correction: boolean;
}

export function voiceStatus(home: string = homedir()): VoiceStatus {
  const cfg = readVoiceConfig(home);
  return {
    key: Boolean(voiceApiKey(home)),
    voice: cfg.voice || DEFAULT_VOICE,
    sttLanguage: cfg.sttLanguage || AUTO_LANGUAGE,
    // Default ON, but the whole pass is behind AC6b: if the measured push-to-talk-to-submit
    // time blows the budget in the real app, this default flips to false and the pass
    // becomes an explicit opt-in. That is a one-line change here, by design.
    correction: cfg.correction !== false,
  };
}
