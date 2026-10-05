import { useSyncExternalStore } from 'react';
import { api, RequestError } from '../../api/client';
import { isDesktop } from '../../lib/desktop';
import type { HandsfreeJob, HandsfreeStatus } from './handsfreeTypes';

/**
 * ONE poller per window for the laptop's hands-free state, shared by the chrome button, the
 * banner, the Settings card and every mounted agent surface (one window holds several project
 * instances; N pollers would each hit GitHub's REST through `status`).
 *
 * Status (`GET /api/handsfree/status`, which reads the machine's state from GitHub): read when
 * the first subscriber arrives, on window focus, after every action, and every
 * {@link AWAY_POLL_MS} only while the laptop is NOT home. Home and idle, it is never polled.
 *
 * Job (`GET /api/handsfree/jobs/current`, local only): polled every {@link JOB_POLL_MS} while a
 * job runs, so a go/return started before a reload (or from the CLI's twin, the dashboard) is
 * re-adopted on the next read.
 *
 * Every subscription has a death: the last unsubscribe clears both timers and the focus
 * listener, and a status that answers 403/404 stops polling.
 *
 * NEVER on the cloud: these are laptop routes (desktop app + loopback). On the phone's cloud
 * page `/api/handsfree/status` is a transfer route, and a device cookie sent there is a
 * credential mismatch. The page knows synchronously which side it is on: only the desktop app
 * carries the Tauri bridge, and the phone never does. Off the desktop app the store answers
 * `unavailable` and sends nothing, not even a first request.
 */

const AWAY_POLL_MS = 10_000;
const JOB_POLL_MS = 1_000;

export interface HandsfreeSnapshot {
  status: HandsfreeStatus | null;
  /** The routes are not served here (not the desktop app, or the cloud): render nothing. */
  unavailable: boolean;
  job: HandsfreeJob | null;
  error: string | null;
}

let snapshot: HandsfreeSnapshot = { status: null, unavailable: false, job: null, error: null };
const listeners = new Set<() => void>();
let statusTimer: number | null = null;
let jobTimer: number | null = null;
let inflight: Promise<void> | null = null;

/** Are the laptop's hands-free routes served to this page? Injectable for tests. */
let servedHere: () => boolean = isDesktop;
export function setHandsfreeHostProbeForTests(probe: (() => boolean) | null): void {
  servedHere = probe ?? isDesktop;
  snapshot = { status: null, unavailable: false, job: null, error: null };
}

function emit(next: Partial<HandsfreeSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const l of listeners) l();
}

function clearTimer(t: number | null): null {
  if (t !== null) window.clearTimeout(t);
  return null;
}

async function readStatus(): Promise<void> {
  try {
    const status = await api.get<HandsfreeStatus>('/handsfree/status');
    emit({ status, unavailable: false, error: null, job: status.job ?? null });
  } catch (err) {
    if (err instanceof RequestError && (err.status === 403 || err.status === 404)) emit({ unavailable: true, error: null });
    else emit({ error: err instanceof Error ? err.message : String(err) });
  }
  scheduleStatus();
  scheduleJob();
}

/** Re-read the status now (deduped while one read is in flight). */
export function refreshHandsfreeStatus(): Promise<void> {
  if (!servedHere()) {
    if (!snapshot.unavailable) emit({ unavailable: true });
    return Promise.resolve();
  }
  inflight ??= readStatus().finally(() => { inflight = null; });
  return inflight;
}

function scheduleStatus(): void {
  statusTimer = clearTimer(statusTimer);
  if (!listeners.size || snapshot.unavailable) return;
  const phase = snapshot.status?.phase;
  if (phase && phase !== 'home') statusTimer = window.setTimeout(() => { void refreshHandsfreeStatus(); }, AWAY_POLL_MS);
}

async function readJob(): Promise<void> {
  const before = snapshot.job;
  try {
    const { job } = await api.get<{ job: HandsfreeJob | null }>('/handsfree/jobs/current');
    emit({ job });
    // A job just finished: the phase moved (go → away, return → home); read it once.
    if (before?.status === 'running' && job && job.status !== 'running') void refreshHandsfreeStatus();
  } catch { /* the next status read retries */ }
  scheduleJob();
}

function scheduleJob(): void {
  jobTimer = clearTimer(jobTimer);
  if (!listeners.size || snapshot.unavailable) return;
  if (snapshot.job?.status === 'running') jobTimer = window.setTimeout(() => { void readJob(); }, JOB_POLL_MS);
}

/** An action just answered with a job (202) or a busy one (409): adopt it and start polling. */
export function adoptHandsfreeJob(job: HandsfreeJob | null): void {
  if (!servedHere()) return;
  if (job) emit({ job });
  void readJob();
}

const onFocus = () => { void refreshHandsfreeStatus(); };

/** Exported for tests; components use {@link useHandsfree}. */
export function subscribeHandsfree(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener('focus', onFocus);
    void refreshHandsfreeStatus();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('focus', onFocus);
      statusTimer = clearTimer(statusTimer);
      jobTimer = clearTimer(jobTimer);
    }
  };
}

export function handsfreeSnapshot(): HandsfreeSnapshot {
  return snapshot;
}

export function useHandsfree(): HandsfreeSnapshot {
  return useSyncExternalStore(subscribeHandsfree, () => snapshot);
}

// ---------------------------------------------------------------- window-wide UI events

/**
 * The chrome hosts the sheet (beside the button) and the receipt (beside the banner); the
 * Settings card and the banner open them through these events. One window, one module realm,
 * so a module EventTarget reaches every host in it and nothing outside it.
 */
const bus = new EventTarget();
export const OPEN_SHEET = 'hf:open-sheet';
export const OPEN_RECEIPT = 'hf:open-receipt';
export const FOCUS_BANNER = 'hf:focus-banner';

export function openHandsfreeSheet(view: 'auto' | 'link' = 'auto'): void {
  bus.dispatchEvent(new CustomEvent(OPEN_SHEET, { detail: view }));
}
export function openHandsfreeReceipt(tripId: string): void {
  bus.dispatchEvent(new CustomEvent(OPEN_RECEIPT, { detail: tripId }));
}
export function focusHandsfreeBanner(): void {
  bus.dispatchEvent(new CustomEvent(FOCUS_BANNER));
}
export function onHandsfreeEvent<T>(type: string, fn: (detail: T) => void): () => void {
  const l = (e: Event) => fn((e as CustomEvent<T>).detail);
  bus.addEventListener(type, l);
  return () => bus.removeEventListener(type, l);
}
