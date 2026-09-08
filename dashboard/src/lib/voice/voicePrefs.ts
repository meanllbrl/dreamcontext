/**
 * The voice preferences the CHAT surface needs, cached in the module and refreshed on
 * demand.
 *
 * WHY A MODULE CACHE AND NOT A HOOK. Two very different consumers read the same three
 * values: the composer (a React component, which could have used a hook) and `SpeechQueue`
 * (a plain class the session owns, which could not). One cache with a synchronous getter
 * serves both, and — the part that matters — means the queue reads the CURRENT rate at the
 * moment it plays a chunk rather than the one that happened to be true when the session was
 * created. Toggling speech off mid-turn silences the next chunk, not the next session.
 *
 * THE KEY IS NOT HERE AND NEVER WILL BE. `/status` reports `key: boolean`; there is no route
 * that returns the key itself, which is the property that makes leaving voice configured
 * safe. This module carries only the non-secret preferences.
 */

import { DEFAULT_PUSH_TO_TALK } from './hotkeyDefaults';
import type { PushToTalkMode } from './hotkey';

export interface VoicePrefs {
  /** Canonical chord string — see `hotkey.ts`. */
  pushToTalk: string;
  /** How it is operated. The server reports the EFFECTIVE mode: a latch key is always
   *  `toggle`, whatever is stored. */
  pushToTalkMode: PushToTalkMode;
  /** Whether answers are spoken at all. */
  speech: boolean;
  /** Playback rate for spoken answers. */
  speechRate: number;
}

const DEFAULTS: VoicePrefs = {
  pushToTalk: DEFAULT_PUSH_TO_TALK, pushToTalkMode: 'hold', speech: true, speechRate: 1,
};

let cached: VoicePrefs = DEFAULTS;

/** The event Settings fires after a save, so a chat window open in another tab of the same
 *  app picks up the new chord without a reload. */
const EVENT = 'dreamcontext:voice-prefs';

/** The current preferences. Synchronous by design: a play loop cannot await a fetch. */
export function voicePrefs(): VoicePrefs {
  return cached;
}

/** Adopt a `/status` (or `PUT /config`) response. Unknown or missing fields keep their
 *  default rather than becoming `undefined` — a stale server that predates these fields must
 *  degrade to the shipped defaults, not to a broken chord. */
export function adoptVoicePrefs(body: Partial<VoicePrefs> | null | undefined): VoicePrefs {
  cached = {
    pushToTalk: typeof body?.pushToTalk === 'string' && body.pushToTalk ? body.pushToTalk : DEFAULTS.pushToTalk,
    pushToTalkMode: body?.pushToTalkMode === 'toggle' ? 'toggle' : DEFAULTS.pushToTalkMode,
    speech: typeof body?.speech === 'boolean' ? body.speech : DEFAULTS.speech,
    speechRate: typeof body?.speechRate === 'number' && body.speechRate > 0 ? body.speechRate : DEFAULTS.speechRate,
  };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<VoicePrefs>(EVENT, { detail: cached }));
  }
  return cached;
}

/** Re-read the preferences from the server. A failure leaves the cache alone: the last
 *  known-good chord is a better answer than a default that silently replaces it. */
export async function refreshVoicePrefs(): Promise<VoicePrefs> {
  try {
    const res = await fetch('/api/agent/voice/status');
    if (!res.ok) return cached;
    return adoptVoicePrefs(await res.json() as Partial<VoicePrefs>);
  } catch {
    return cached;
  }
}

/** Subscribe to changes. Returns the unsubscribe. */
export function onVoicePrefs(fn: (prefs: VoicePrefs) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => fn((e as CustomEvent<VoicePrefs>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
