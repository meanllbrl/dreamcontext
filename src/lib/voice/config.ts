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
import { normalizeHotkey, effectiveMode, type PushToTalkMode } from './hotkey.js';

/** What lives in `voice.json`. Every field is optional — an absent file is a valid state. */
export interface VoiceConfig {
  /** The OpenRouter API key. The one this feature cannot work without. */
  openRouterKey?: string;
  /**
   * An OPTIONAL Groq key, used only for transcription.
   *
   * Why a second provider at all, when the rule was one key for everything: measured, the
   * same take through OpenRouter's transcription endpoint took anywhere from 1.3s to 14.2s —
   * the model is right but the routing is not something a push-to-talk button can depend on.
   * Groq serves the same `whisper-large-v3-turbo` on its own hardware at 200x realtime and
   * $0.04 an hour, with a free tier that covers this feature's whole usage. It is optional
   * precisely because it is a second account: without it everything still works.
   */
  groqKey?: string;
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
  /**
   * Which transcriber to use.
   *
   * `cloud` is the DEFAULT, and the reason is measured rather than assumed. OpenRouter does
   * serve a real speech recogniser after all — `openai/whisper-large-v3-turbo`, absent from
   * the `/models` catalogue but present on the transcription endpoint — and it answers the
   * owner's Turkish in ~0.7-1.1s for $0.0001 a take. That is the same speed as the local
   * whisper it replaces, without 1.5 GB of resident model or a second of the laptop's CPU,
   * which is the owner's stated preference: put the load on the API.
   *
   * `local` keeps whisper.cpp for offline or free-forever use; `auto` prefers local when it
   * is installed and falls back to the cloud.
   */
  sttEngine?: 'auto' | 'local' | 'cloud';
  /** Whether the Slice-2 correction pass runs at all. Off degrades to the raw transcript. */
  correction?: boolean;
  /**
   * The push-to-talk chord, canonical form (see `hotkey.ts`). Configurable because the
   * shipped default is not neutral: ⌥Space is Spotlight's alternate on some machines and a
   * window-manager binding on others, and a push-to-talk key the OS eats first is a mode
   * that looks broken with nothing on screen to say why.
   */
  pushToTalk?: string;
  /**
   * How the binding is operated: `hold` (speak while it is down) or `toggle` (one press
   * starts, the next ends). Toggle exists because holding a modifier chord to speak is
   * genuinely unpleasant, and because a latch key like Caps Lock cannot do anything else —
   * macOS reports it as on/off, never as held.
   */
  pushToTalkMode?: PushToTalkMode;
  /**
   * Whether answers are SPOKEN. Off leaves push-to-talk and the on-screen structure exactly
   * as they are — the mode is still worth having when the room is quiet or the owner is on a
   * call, and it is also the cheap half: dictation costs a fraction of speech.
   */
  speech?: boolean;
  /** Playback rate for spoken answers, applied to the audio element rather than sent
   *  upstream — a rate the client owns cannot be a request that fails. */
  speechRate?: number;
  /**
   * Whether a known music player is PAUSED while an answer is spoken, and resumed after.
   *
   * Default on: the owner asked for it, and the mode's whole proposition is not reaching for
   * the keyboard. The cost of the default is a one-time macOS Automation consent dialog on
   * the first answer, which `NSAppleEventsUsageDescription` exists to explain.
   */
  musicPause?: boolean;
  /**
   * How far the machine's OUTPUT VOLUME is lowered when nothing we can address precisely is
   * playing — a browser tab, typically. `1` means never. See `audioFocus.ts` for why this
   * number is paired with a compensating gain on our own playback: the system volume is the
   * only lever macOS gives a non-sandboxed app, and it lowers OUR voice by the same amount.
   */
  musicDuck?: number;
}

/** The default voice. A deep one — the closest this provider gets to the character. */
export const DEFAULT_VOICE = 'onyx';

/** Language sentinel meaning "send no `language` parameter and let the model detect". */
export const AUTO_LANGUAGE = 'auto';

/** The default push-to-talk chord. ⌥Space, which is what the composer's tooltip said before
 *  the key was configurable at all. */
export const DEFAULT_PUSH_TO_TALK = 'Alt+Space';

/** Hold is the default: it is the one that cannot leave the microphone open by accident. */
export const DEFAULT_PUSH_TO_TALK_MODE: PushToTalkMode = 'hold';

/** Default playback rate, and the range Settings offers. The bounds are narrow on purpose:
 *  the character survives a modest speed-up and stops being calm and precise past it. */
export const DEFAULT_SPEECH_RATE = 1;
export const MIN_SPEECH_RATE = 0.75;
export const MAX_SPEECH_RATE = 1.75;

/** Default duck depth: audible-but-under, and chosen against the 3x compensating-gain
 *  ceiling in `audioFocus.ts` rather than for roundness — a deeper duck is one we could not
 *  fully give back to our own voice without living in a limiter. */
export const DEFAULT_MUSIC_DUCK = 0.35;

/** Music ducking is OFF-by-value rather than off-by-flag: `1` is "do not duck", which means
 *  the setting is one number instead of a number plus a toggle that can disagree with it. */
export const MIN_MUSIC_DUCK = 0.1;
export const MAX_MUSIC_DUCK = 1;

/** Clamp a duck depth. Out of range is CLAMPED, like the speech rate and unlike the hotkey:
 *  every value in range still produces working audio. */
export function clampMusicDuck(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MUSIC_DUCK;
  return Math.min(MAX_MUSIC_DUCK, Math.max(MIN_MUSIC_DUCK, Math.round(value * 100) / 100));
}

/** Clamp a rate into the offered range. Out-of-range input is CLAMPED rather than refused —
 *  unlike the hotkey, every value here still produces working audio. */
export function clampSpeechRate(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPEECH_RATE;
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, Math.round(value * 100) / 100));
}

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
    if (typeof raw.groqKey === 'string' && raw.groqKey.trim()) out.groqKey = raw.groqKey.trim();
    if (typeof raw.voice === 'string' && raw.voice.trim()) out.voice = raw.voice.trim();
    if (typeof raw.sttLanguage === 'string') out.sttLanguage = raw.sttLanguage.trim();
    if (raw.sttEngine === 'auto' || raw.sttEngine === 'local' || raw.sttEngine === 'cloud') {
      out.sttEngine = raw.sttEngine;
    }
    if (typeof raw.correction === 'boolean') out.correction = raw.correction;
    // An unparseable chord is DROPPED, not carried: a hand-edited `voice.json` must degrade
    // to the default binding rather than to a mode whose only input never fires.
    if (typeof raw.pushToTalk === 'string') {
      const chord = normalizeHotkey(raw.pushToTalk);
      if (chord) out.pushToTalk = chord;
    }
    if (raw.pushToTalkMode === 'hold' || raw.pushToTalkMode === 'toggle') {
      out.pushToTalkMode = raw.pushToTalkMode;
    }
    if (typeof raw.speech === 'boolean') out.speech = raw.speech;
    if (typeof raw.speechRate === 'number') out.speechRate = clampSpeechRate(raw.speechRate);
    if (typeof raw.musicPause === 'boolean') out.musicPause = raw.musicPause;
    if (typeof raw.musicDuck === 'number') out.musicDuck = clampMusicDuck(raw.musicDuck);
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
  patch: Partial<Record<keyof VoiceConfig, string | number | boolean | null | undefined>>,
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

/** The Groq key, or null. Same env fallback as the OpenRouter one, same reason. */
export function groqApiKey(home: string = homedir()): string | null {
  const stored = readVoiceConfig(home).groqKey;
  if (stored) return stored;
  const env = process.env.GROQ_API_KEY;
  return env && env.trim() ? env.trim() : null;
}

/** What Settings and the composer are allowed to know. Note `key` is a BOOLEAN: there is
 *  deliberately no route by which the key itself travels back to a client. */
export interface VoiceStatus {
  key: boolean;
  /** Whether a Groq key is set. Like `key`, a BOOLEAN: no route returns a key. */
  groq: boolean;
  voice: string;
  sttLanguage: string;
  sttEngine: 'auto' | 'local' | 'cloud';
  correction: boolean;
  pushToTalk: string;
  /** The mode as STORED. A latch key overrides it — see `pushToTalkMode` below. */
  pushToTalkMode: PushToTalkMode;
  speech: boolean;
  speechRate: number;
  /** Whether a known player is paused while an answer is spoken. */
  musicPause: boolean;
  /** Duck depth for sources we cannot address precisely; `1` means never. */
  musicDuck: number;
  /** Whether this machine can control its own audio at all — false off macOS, where the
   *  speaker floor still works but nothing can be paused. Reported so Settings can say why
   *  the rows are inert instead of showing switches that do nothing. */
  musicControl: boolean;
}

export function voiceStatus(home: string = homedir()): VoiceStatus {
  const cfg = readVoiceConfig(home);
  return {
    key: Boolean(voiceApiKey(home)),
    groq: Boolean(groqApiKey(home)),
    voice: cfg.voice || DEFAULT_VOICE,
    sttLanguage: cfg.sttLanguage || AUTO_LANGUAGE,
    // `auto` again, and the reason is a measurement rather than a preference: the cloud
    // model is right but its ROUTING is not dependable — the same 4.7s take came back in
    // 1.3s, 9.2s, 14.2s and 1.3s through OpenRouter, where a warm local whisper answered in
    // 0.85s every time. Auto prefers local when it is installed, cloud when it is not, and a
    // Groq key (Settings) makes the cloud path fast and steady too.
    sttEngine: cfg.sttEngine || 'auto',
    // Default ON, but the whole pass is behind AC6b: if the measured push-to-talk-to-submit
    // time blows the budget in the real app, this default flips to false and the pass
    // becomes an explicit opt-in. That is a one-line change here, by design.
    correction: cfg.correction !== false,
    pushToTalk: cfg.pushToTalk || DEFAULT_PUSH_TO_TALK,
    // REPORTED EFFECTIVE, not as stored: Caps Lock can only toggle, and a Settings card that
    // showed "hold" for it would be describing a binding the composer will never honour.
    pushToTalkMode: effectiveMode(
      cfg.pushToTalk || DEFAULT_PUSH_TO_TALK,
      cfg.pushToTalkMode || DEFAULT_PUSH_TO_TALK_MODE,
    ),
    // Both default ON: the mode's whole proposition is a spoken answer, and a feature that
    // has to be switched on twice reads as broken the first time.
    speech: cfg.speech !== false,
    speechRate: cfg.speechRate ?? DEFAULT_SPEECH_RATE,
    // Also default ON, for the same reason and with one extra: an answer spoken over music
    // is an answer the owner has to ask for twice.
    musicPause: cfg.musicPause !== false,
    musicDuck: cfg.musicDuck ?? DEFAULT_MUSIC_DUCK,
    // Reported rather than inferred client-side: the dashboard cannot know what platform the
    // SERVER is on, and that is the side that owns the AppleScript.
    musicControl: process.platform === 'darwin',
  };
}
