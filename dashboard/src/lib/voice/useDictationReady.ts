import { useEffect, useState } from 'react';

/**
 * Is dictation (local whisper or the cloud) ready on this machine? Asked once per window
 * (`GET /api/agent/voice/dictation`), cached for every composer, and asked again when it may
 * have changed:
 *  - an install or a choice finished in THIS window (`notifyDictationChanged`);
 *  - the same happened in ANOTHER window: the notch and every project window are separate
 *    webviews of one origin, so the news rides a `storage` write, the way read aloud does;
 *  - the window came back (`focus` / `visibilitychange`).
 * The mic's "Set up dictation" step reads this (owner, 2026-11-08), so a stale "not installed"
 * would block a working mic. A failed ask is never cached: the next read asks again.
 */

/** Fired when dictation's readiness may have changed (a choice, an install, a key saved). */
export const DICTATION_CHANGED_EVENT = 'dc:dictation-changed';
const EVENT = DICTATION_CHANGED_EVENT;
/** The cross-window broadcast key (a timestamp; only the write matters). */
const STORAGE_KEY = 'dreamcontext-dictation-changed';
let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

async function ask(): Promise<boolean | null> {
  try {
    const res = await fetch('/api/agent/voice/dictation');
    if (!res.ok) return null;
    const s = await res.json() as { installed?: unknown };
    return s.installed === true;
  } catch {
    return null;
  }
}

export function dictationReady(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  inflight ??= ask().then((v) => {
    inflight = null;
    if (v === null) return false;
    cached = v;
    return v;
  });
  return inflight;
}

function forget(): void {
  cached = null;
  inflight = null;
}

/** An install finished (or was removed, or a key was saved): every composer in every window asks again. */
export function notifyDictationChanged(): void {
  forget();
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch { /* no storage: this window still hears it */ }
  window.dispatchEvent(new Event(EVENT));
}

export function useDictationReady(enabled = true): boolean {
  const [ready, setReady] = useState<boolean>(cached ?? false);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const read = () => { void dictationReady().then((v) => { if (live) setReady(v); }); };
    const again = () => { forget(); read(); };
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) again(); };
    const onVisible = () => { if (document.visibilityState === 'visible') again(); };
    read();
    window.addEventListener(EVENT, read);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      window.removeEventListener(EVENT, read);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
  return ready;
}
