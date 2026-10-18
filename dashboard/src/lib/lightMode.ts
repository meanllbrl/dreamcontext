/**
 * Light mode — the app's "go easy on this Mac" switch (owner decision 2, 2026-10-17).
 *
 * Settings → Performance → Light mode: Auto / On / Off. Auto turns it on for a Mac with ≤ 8 GB
 * of memory or one running on battery. When it is on:
 *   - every endless animation is removed (each indicator shows its resting style) and every
 *     `backdrop-filter` is off — both through `data-light` on <html> (styles/global.css);
 *   - terminals render on DOM (components/sleepy/webglBudget.ts);
 *   - every poll runs at half the rate (`pollMs` ×2, lib/windowActivity.ts).
 *
 * The EFFECTIVE value is computed here, on the client, from the setting (which every window
 * hears through `onAgentSettings`, other windows' writes included) plus the machine's facts
 * (`GET /api/app/machine`) — no server round trip decides it. Until the facts arrive, or when
 * the route fails, Auto knows nothing about the machine and stays off.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { agentSettingsReady, onAgentSettings, type LightModeSetting } from './agentSettings';
import { getWindowActivity, pollMs, setLightPollFactor } from './windowActivity';

/** What `GET /api/app/machine` answers. `onBattery` is null where the power source is unknown. */
export interface MachineFacts {
  totalMemGb: number | null;
  onBattery: boolean | null;
}

/** Why light mode is on: the setting pins it, or Auto saw low memory / battery power. */
export type LightModeReason = 'setting' | 'ram' | 'battery';

export interface LightModeState {
  on: boolean;
  reason: LightModeReason | null;
  setting: LightModeSetting;
}

/** Auto's memory line: an "8 GB" Mac reports a little under 8 GiB, so the line sits at 8.5. */
export const LOW_MEMORY_GB = 8.5;
const MACHINE_POLL_MS = 60_000;
/** How long boot waits for the machine facts before Auto answers without them. */
const FACTS_WAIT_MS = 1_500;

/** The rule, pure: the setting first, then Auto's two machine facts. */
export function computeLightMode(setting: LightModeSetting, facts: MachineFacts | null): { on: boolean; reason: LightModeReason | null } {
  if (setting === 'on') return { on: true, reason: 'setting' };
  if (setting === 'off') return { on: false, reason: null };
  if (!facts) return { on: false, reason: null };
  if (typeof facts.totalMemGb === 'number' && facts.totalMemGb > 0 && facts.totalMemGb <= LOW_MEMORY_GB) {
    return { on: true, reason: 'ram' };
  }
  if (facts.onBattery === true) return { on: true, reason: 'battery' };
  return { on: false, reason: null };
}

let setting: LightModeSetting = 'auto';
let facts: MachineFacts | null = null;
let current: LightModeState = { on: false, reason: null, setting: 'auto' };
const listeners = new Set<(s: LightModeState) => void>();
let started = false;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let offSettings: (() => void) | null = null;
let readyResolve: (on: boolean) => void = () => {};
/** Resolves (to the effective value) once the setting is known and the first machine read
 *  settled, or after a short wait — nothing that depends on it waits for ever. */
export let lightModeReady: Promise<boolean> = new Promise((r) => { readyResolve = r; });

export function isLightMode(): boolean {
  return current.on;
}

export function getLightMode(): LightModeState {
  return current;
}

export function onLightMode(cb: (s: LightModeState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function subscribeStore(cb: () => void): () => void {
  return onLightMode(() => cb());
}

/** React view of {@link getLightMode}. */
export function useLightMode(): LightModeState {
  return useSyncExternalStore(subscribeStore, getLightMode, getLightMode);
}

function recompute(): void {
  const r = computeLightMode(setting, facts);
  const next: LightModeState = { on: r.on, reason: r.reason, setting };
  setLightPollFactor(next.on);
  try { document.documentElement.dataset.light = next.on ? 'true' : 'false'; } catch { /* no document (Node) */ }
  if (next.on === current.on && next.reason === current.reason && next.setting === current.setting) return;
  current = next;
  for (const l of [...listeners]) {
    try { l(next); } catch (err) { console.warn('[light-mode] listener failed:', err); }
  }
}

export interface LightModeDeps {
  fetchMachine: () => Promise<MachineFacts>;
  ready: Promise<{ lightMode: LightModeSetting }>;
}

const defaultDeps = (): LightModeDeps => ({
  fetchMachine: () => api.get<MachineFacts>('/app/machine'),
  ready: agentSettingsReady,
});

/**
 * Start following the setting and the machine. Idempotent. Call once at App boot, after
 * `initAgentSettingsFromServer()` has been kicked off.
 */
export function initLightMode(depsIn?: Partial<LightModeDeps>): Promise<boolean> {
  if (started) return lightModeReady;
  started = true;
  const deps = { ...defaultDeps(), ...depsIn };
  recompute();

  const readFacts = async (): Promise<void> => {
    try {
      const f = await deps.fetchMachine();
      facts = {
        totalMemGb: typeof f?.totalMemGb === 'number' ? f.totalMemGb : null,
        onBattery: typeof f?.onBattery === 'boolean' ? f.onBattery : null,
      };
    } catch { /* the route failed: keep what we knew (nothing, at boot) */ }
    recompute();
  };

  // The machine is re-read every minute while the window is seen (battery ↔ AC); a hidden
  // window makes no request.
  const loop = () => {
    if (!started) return;
    loopTimer = setTimeout(() => {
      loopTimer = null;
      if (!getWindowActivity().hidden) void readFacts().finally(loop);
      else loop();
    }, pollMs(MACHINE_POLL_MS));
  };

  const settingKnown = deps.ready.then((cfg) => {
    setting = cfg?.lightMode === 'on' || cfg?.lightMode === 'off' ? cfg.lightMode : 'auto';
    recompute();
  }, () => { recompute(); });
  try {
    offSettings = onAgentSettings((cfg) => {
      const next = cfg.lightMode === 'on' || cfg.lightMode === 'off' ? cfg.lightMode : 'auto';
      if (next !== setting) { setting = next; recompute(); }
    });
  } catch { /* no window (Node) */ }

  const firstFacts = readFacts();
  const factsOrTimeout = Promise.race([firstFacts, new Promise<void>((r) => setTimeout(r, FACTS_WAIT_MS))]);
  void Promise.all([settingKnown, factsOrTimeout]).then(() => {
    readyResolve(current.on);
    loop();
  });
  return lightModeReady;
}

/** Tests only. */
export function resetLightModeForTests(): void {
  if (loopTimer !== null) clearTimeout(loopTimer);
  loopTimer = null;
  offSettings?.();
  offSettings = null;
  setting = 'auto';
  facts = null;
  current = { on: false, reason: null, setting: 'auto' };
  listeners.clear();
  started = false;
  lightModeReady = new Promise((r) => { readyResolve = r; });
  setLightPollFactor(false);
}
