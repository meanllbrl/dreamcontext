import { useEffect, useState } from 'react';
import { isMacPhoneSurface } from '../../../lib/phoneSurface';
import { MAC_THERMAL_STATES, type MacThermal } from '../macContract';

/**
 * The phone's view of Mac mode: `GET /api/handsfree/phone` (the laptop's battery, whether it
 * may sleep again, and whether it is slowing heavy work to cool down), polled only on the phone surface. Mounting the chip also registers the
 * hands-free service worker there (offline page, notifications).
 *
 * Beside the Mac's state the store keeps whether the LAST poll reached the Mac at all: the
 * header's badge pulses only while it did (a pulse on a dropped link would be a lie), and says
 * it is reaching the Mac again until the next answer.
 */

export interface PhoneState {
  battery: { percent: number | null; charging: boolean };
  sleepAllowed: boolean;
  thermal: MacThermal;
}

/** A `GET /api/handsfree/phone` body → the chip's state; null when it is not a Mac payload.
 *  Every field is type-checked: an older server (no `thermal`) reads as not slowing anything. */
export function parsePhonePayload(body: unknown): PhoneState | null {
  const b = body as { mode?: string; battery?: { percent?: unknown; charging?: unknown }; sleepAllowed?: unknown; thermal?: { state?: unknown; slowed?: unknown } } | null;
  if (b?.mode !== 'mac') return null;
  const percent = typeof b.battery?.percent === 'number' ? b.battery.percent : null;
  const ts = b.thermal?.state;
  const slowed = b.thermal?.slowed;
  return {
    battery: { percent, charging: b.battery?.charging !== false },
    sleepAllowed: b.sleepAllowed === true,
    thermal: {
      state: typeof ts === 'string' && (MAC_THERMAL_STATES as readonly string[]).includes(ts) ? ts as MacThermal['state'] : null,
      slowed: typeof slowed === 'number' && Number.isInteger(slowed) && slowed > 0 ? slowed : 0,
    },
  };
}

const ROUTE = '/api/handsfree/phone';
const POLL_MS = 30_000;

/** What the phone knows: the Mac's last state, and whether the last poll reached it. */
export interface PhoneLink {
  state: PhoneState | null;
  reachable: boolean;
}

/**
 * Pure: the link after one poll. A Mac answer (200 with the surface header) is reachable with
 * its state; a dropped request or the tunnel's own error page (no answer from the Mac) is NOT
 * reachable and keeps the last state; a 401 (signed out: the page is on its way to /login) and
 * any other answer of the Mac's keep the link as it was.
 */
export function nextLink(prev: PhoneLink, poll: { status: number | null; fromMac: boolean; state: PhoneState | null }): PhoneLink {
  if (poll.status === 200 && poll.fromMac) return poll.state ? { state: poll.state, reachable: true } : { ...prev, reachable: true };
  if (poll.status === null || !poll.fromMac) return { ...prev, reachable: false };
  return prev;
}

let link: PhoneLink = { state: null, reachable: false };
const listeners = new Set<(l: PhoneLink) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let swRegistered = false;

function emit(next: PhoneLink): void {
  if (next.state === link.state && next.reachable === link.reachable) return;
  link = next;
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
    const fromMac = res.headers.get('X-Dreamcontext-Surface') === 'mac';
    const state = res.status === 200 && fromMac ? parsePhonePayload(await res.json()) : null;
    // A 401 (signed out) keeps the last known state; the tunnel's own error page does not reach the Mac.
    emit(nextLink(link, { status: res.status, fromMac, state }));
  } catch {
    /* the tunnel dropped it; the next poll retries */
    emit(nextLink(link, { status: null, fromMac: false, state: null }));
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

/** The phone's link to the Mac; never polled, and never reachable, off the phone surface. */
export function usePhoneLink(): PhoneLink {
  const [l, setL] = useState<PhoneLink>(link);
  useEffect(() => {
    if (!isMacPhoneSurface()) return undefined;
    listeners.add(setL);
    if (listeners.size === 1) start();
    else setL(link);
    return () => {
      listeners.delete(setL);
      if (listeners.size === 0) stop();
    };
  }, []);
  return l;
}

/** The phone's chip state; always null off the phone surface (nothing is polled there). */
export function usePhoneState(): PhoneState | null {
  return usePhoneLink().state;
}
