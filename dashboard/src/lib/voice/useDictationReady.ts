import { useEffect, useState } from 'react';

/**
 * Is local dictation (whisper) installed on this machine? Asked ONCE per window
 * (`GET /api/agent/voice/dictation`), cached for every composer, and asked again only when the
 * Settings installer says it finished (`notifyDictationChanged`). The mic gate (K7, jarvis
 * plan r9): every desktop chat gets the mic when this is true; the Assistant always has it, so
 * its notch keeps the install hint.
 */

const EVENT = 'dc:dictation-changed';
let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

async function ask(): Promise<boolean> {
  try {
    const res = await fetch('/api/agent/voice/dictation');
    if (!res.ok) return false;
    const s = await res.json() as { installed?: unknown };
    return s.installed === true;
  } catch {
    return false;
  }
}

export function dictationReady(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  inflight ??= ask().then((v) => { cached = v; inflight = null; return v; });
  return inflight;
}

/** The Settings installer finished (or removed it): every composer asks again. */
export function notifyDictationChanged(): void {
  cached = null;
  inflight = null;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

export function useDictationReady(enabled = true): boolean {
  const [ready, setReady] = useState<boolean>(cached ?? false);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const read = () => { void dictationReady().then((v) => { if (live) setReady(v); }); };
    read();
    window.addEventListener(EVENT, read);
    return () => { live = false; window.removeEventListener(EVENT, read); };
  }, [enabled]);
  return ready;
}
