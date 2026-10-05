import { useEffect, useState } from 'react';

/**
 * The phone's view of the hands-free cloud: `GET /api/handsfree/phone`, which only the cloud
 * answers (404 on the laptop, so everything here stays invisible there). One shared poller for
 * CloudChip and QuiesceOverlay. Polling is NOT an owner action on the cloud (D14): it never
 * keeps the machine awake.
 */

export type PhonePhase = 'going' | 'active' | 'quiescing' | 'sealed';

export interface PhoneState {
  phase: PhonePhase;
  /** ISO time the cloud plans to put itself to sleep, or null. */
  stopAt: string | null;
}

const ROUTE = '/api/handsfree/phone';
const SKIP = { 'X-Tunnel-Skip-AntiPhishing-Page': 'true' };
const SLOW_MS = 30_000;
const FAST_MS = 5_000;
const PHASES: readonly PhonePhase[] = ['going', 'active', 'quiescing', 'sealed'];

let state: PhoneState | null = null;
const listeners = new Set<(s: PhoneState | null) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let swRegistered = false;

function emit(next: PhoneState | null): void {
  state = next;
  for (const l of listeners) l(next);
}

/** Register the offline worker once the cloud has answered 200 (never on the laptop). The
 *  forwarder drops requests at times (W0), so registration retries with backoff. */
async function registerServiceWorker(): Promise<void> {
  if (swRegistered || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  swRegistered = true;
  for (let i = 0; i < 4; i++) {
    try {
      await navigator.serviceWorker.register('/handsfree-sw.js', { scope: '/' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  swRegistered = false;
}

let watching = false;
/**
 * Cloud only (installed after the phone route answered 200): any API answer of 423
 * cloud_quiescing or 503 cloud_sealed, from whichever caller, re-checks the phase at once
 * instead of waiting for the next poll. The response itself is handed back untouched.
 */
function watchApiAnswers(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  const original = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args);
    if ((res.status === 423 || res.status === 503) && res.headers.get('X-Dreamcontext-Cloud')) {
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
      if (!url.includes(ROUTE)) setTimeout(recheckPhoneState, 0);
    }
    return res;
  };
}

async function poll(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await fetch(ROUTE, { cache: 'no-store', credentials: 'same-origin', headers: SKIP });
    if (res.status === 200) {
      const body = await res.json() as Partial<PhoneState>;
      if (body && PHASES.includes(body.phase as PhonePhase)) {
        emit({ phase: body.phase as PhonePhase, stopAt: typeof body.stopAt === 'string' ? body.stopAt : null });
        void registerServiceWorker();
        watchApiAnswers();
      }
    } else if (res.status === 503 && res.headers.get('X-Dreamcontext-Cloud')) {
      // The cloud gate answers 503 cloud_sealed to every API call once sealed.
      const body = await res.json().catch(() => null) as { error?: string } | null;
      if (body?.error === 'cloud_sealed') emit({ phase: 'sealed', stopAt: null });
    } else if (res.status === 404 || !res.headers.get('X-Dreamcontext-Cloud')) {
      // The laptop (no such route), or not our server answering: nothing to show.
      if (state === null) stopPolling();
    }
    // A 401 (signed out) or a transient failure keeps the last known state.
  } catch {
    /* the forwarder dropped it; the next poll retries */
  } finally {
    inFlight = false;
  }
}

function schedule(): void {
  if (stopped || timer || listeners.size === 0) return;
  const delay = state?.phase === 'quiescing' || state?.phase === 'going' ? FAST_MS : SLOW_MS;
  timer = setTimeout(async () => {
    timer = null;
    await poll();
    schedule();
  }, delay);
}

let stopped = false;
function stopPolling(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

function onVisible(): void {
  if (stopped || document.visibilityState !== 'visible') return;
  void poll().then(() => {
    if (timer) clearTimeout(timer);
    timer = null;
    schedule();
  });
}

/** Ask the cloud again now (e.g. after a 423/503 answer was seen elsewhere). */
export function recheckPhoneState(): void {
  if (!stopped) onVisible();
}

function start(): void {
  if (stopped) return;
  document.addEventListener('visibilitychange', onVisible);
  void poll().then(schedule);
}

function stop(): void {
  document.removeEventListener('visibilitychange', onVisible);
  if (timer) clearTimeout(timer);
  timer = null;
}

export function usePhoneState(): PhoneState | null {
  const [s, setS] = useState<PhoneState | null>(state);
  useEffect(() => {
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
