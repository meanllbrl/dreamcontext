import { useEffect, useState } from 'react';
import { isMacPhoneSurface } from '../../../lib/phoneSurface';

/**
 * The phone's view of Mac mode: `GET /api/handsfree/phone` (the laptop's battery and whether it
 * may sleep again), polled only on the phone surface. Mounting the chip also registers the
 * hands-free service worker there (offline page, notifications).
 */

export interface PhoneState {
  battery: { percent: number | null; charging: boolean };
  sleepAllowed: boolean;
}

const ROUTE = '/api/handsfree/phone';
const POLL_MS = 30_000;

let state: PhoneState | null = null;
const listeners = new Set<(s: PhoneState | null) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let swRegistered = false;

function emit(next: PhoneState | null): void {
  state = next;
  for (const l of listeners) l(next);
}

/** Register the hands-free service worker once (the phone surface only); retries with backoff
 *  because a tunnel can drop a request. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (swRegistered || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  swRegistered = true;
  for (let i = 0; i < 4; i++) {
    try {
      return await navigator.serviceWorker.register('/handsfree-sw.js', { scope: '/' });
    } catch {
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  swRegistered = false;
  return null;
}

async function poll(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await fetch(ROUTE, { cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 200 && res.headers.get('X-Dreamcontext-Surface') === 'mac') {
      const body = await res.json() as { mode?: string; battery?: { percent?: unknown; charging?: unknown }; sleepAllowed?: unknown };
      if (body?.mode === 'mac') {
        const percent = typeof body.battery?.percent === 'number' ? body.battery.percent : null;
        emit({ battery: { percent, charging: body.battery?.charging !== false }, sleepAllowed: body.sleepAllowed === true });
      }
    }
    // A 401 (signed out) or a transient failure keeps the last known state.
  } catch {
    /* the tunnel dropped it; the next poll retries */
  } finally {
    inFlight = false;
  }
}

function schedule(): void {
  if (timer || listeners.size === 0) return;
  timer = setTimeout(async () => {
    timer = null;
    await poll();
    schedule();
  }, POLL_MS);
}

function onVisible(): void {
  if (document.visibilityState !== 'visible') return;
  void poll().then(() => {
    if (timer) clearTimeout(timer);
    timer = null;
    schedule();
  });
}

function start(): void {
  void registerServiceWorker();
  document.addEventListener('visibilitychange', onVisible);
  void poll().then(schedule);
}

function stop(): void {
  document.removeEventListener('visibilitychange', onVisible);
  if (timer) clearTimeout(timer);
  timer = null;
}

/** The phone's chip state; always null off the phone surface (nothing is polled there). */
export function usePhoneState(): PhoneState | null {
  const [s, setS] = useState<PhoneState | null>(state);
  useEffect(() => {
    if (!isMacPhoneSurface()) return undefined;
    listeners.add(setS);
    if (listeners.size === 1) start();
    else setS(state);
    return () => {
      listeners.delete(setS);
      if (listeners.size === 0) stop();
    };
  }, []);
  return s;
}
