/**
 * Light mode's rule and its boot (AC12, task "the desktop app stays light on an 8GB MacBook
 * Air"): Auto = on for ≤ 8 GB or on battery, with injected machine facts (including an unknown
 * power source and a failed `/api/app/machine`); a saved On survives a relaunch before any
 * terminal opens; a setting changed in ANOTHER window applies here at once (storage event).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeLightMode, initLightMode, isLightMode, getLightMode, lightModeReady as _r, resetLightModeForTests, LOW_MEMORY_GB,
} from '../../dashboard/src/lib/lightMode.js';
import * as lm from '../../dashboard/src/lib/lightMode.js';
import { pollMs, resetWindowActivityForTests } from '../../dashboard/src/lib/windowActivity.js';
import { resetAgentSettingsForTests } from '../../dashboard/src/lib/agentSettings.js';

void _r;
const g = globalThis as unknown as { window?: unknown; document?: unknown; localStorage?: unknown };
let realWindow: unknown;
let realDocument: unknown;
let realStorage: unknown;
let dataset: Record<string, string>;

beforeEach(() => {
  realWindow = g.window; realDocument = g.document; realStorage = g.localStorage;
  g.window = new EventTarget();
  dataset = {};
  g.document = { documentElement: { dataset } };
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  resetWindowActivityForTests();
  resetAgentSettingsForTests();
  resetLightModeForTests();
});
afterEach(() => {
  resetLightModeForTests();
  vi.useRealTimers();
  if (realWindow === undefined) delete g.window; else g.window = realWindow;
  if (realDocument === undefined) delete g.document; else g.document = realDocument;
  if (realStorage === undefined) delete g.localStorage; else g.localStorage = realStorage;
});

describe('computeLightMode', () => {
  it('On / Off pin it whatever the machine says', () => {
    expect(computeLightMode('on', { totalMemGb: 64, onBattery: false })).toEqual({ on: true, reason: 'setting' });
    expect(computeLightMode('off', { totalMemGb: 8, onBattery: true })).toEqual({ on: false, reason: null });
  });

  it('Auto: ≤ 8 GB → on (low memory), on battery → on (battery), 16 GB on AC → off', () => {
    expect(computeLightMode('auto', { totalMemGb: 8, onBattery: false })).toEqual({ on: true, reason: 'ram' });
    expect(computeLightMode('auto', { totalMemGb: LOW_MEMORY_GB, onBattery: false })).toEqual({ on: true, reason: 'ram' });
    expect(computeLightMode('auto', { totalMemGb: 16, onBattery: true })).toEqual({ on: true, reason: 'battery' });
    expect(computeLightMode('auto', { totalMemGb: 16, onBattery: false })).toEqual({ on: false, reason: null });
  });

  it('Auto with an unknown power source (onBattery: null) uses memory alone', () => {
    expect(computeLightMode('auto', { totalMemGb: 16, onBattery: null })).toEqual({ on: false, reason: null });
    expect(computeLightMode('auto', { totalMemGb: 8, onBattery: null })).toEqual({ on: true, reason: 'ram' });
  });

  it('Auto with no machine facts (the route failed or has not answered) is off', () => {
    expect(computeLightMode('auto', null)).toEqual({ on: false, reason: null });
    expect(computeLightMode('auto', { totalMemGb: null, onBattery: null })).toEqual({ on: false, reason: null });
  });
});

describe('initLightMode', () => {
  it('a failed /api/app/machine leaves Auto off and still resolves lightModeReady', async () => {
    await initLightMode({ ready: Promise.resolve({ lightMode: 'auto' }), fetchMachine: () => Promise.reject(new Error('down')) });
    await expect(lm.lightModeReady).resolves.toBe(false);
    expect(isLightMode()).toBe(false);
    expect(dataset.light).toBe('false');
  });

  it('Auto on an 8 GB Mac: on, with its reason, and every poll ×2', async () => {
    await initLightMode({ ready: Promise.resolve({ lightMode: 'auto' }), fetchMachine: async () => ({ totalMemGb: 8, onBattery: false }) });
    expect(await lm.lightModeReady).toBe(true);
    expect(getLightMode()).toEqual({ on: true, reason: 'ram', setting: 'auto' });
    expect(dataset.light).toBe('true');
    expect(pollMs(15_000)).toBe(30_000);
  });

  it('relaunch with On saved: on as soon as the settings are read, before lightModeReady lets a terminal open', async () => {
    let order: string[] = [];
    const ready = initLightMode({
      ready: Promise.resolve({ lightMode: 'on' }),
      fetchMachine: async () => ({ totalMemGb: 16, onBattery: false }),
    }).then((on) => { order.push(`ready:${on}`); });
    await ready;
    expect(order).toEqual(['ready:true']);
    expect(isLightMode()).toBe(true);
    order = [];
  });

  it('Off on an 8 GB Mac stays off after a relaunch', async () => {
    await initLightMode({ ready: Promise.resolve({ lightMode: 'off' }), fetchMachine: async () => ({ totalMemGb: 8, onBattery: true }) });
    expect(await lm.lightModeReady).toBe(false);
    expect(isLightMode()).toBe(false);
  });

  it('a hanging machine route does not hold lightModeReady for ever', async () => {
    vi.useFakeTimers();
    void initLightMode({ ready: Promise.resolve({ lightMode: 'auto' }), fetchMachine: () => new Promise(() => {}) });
    let done = false;
    void lm.lightModeReady.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1_600);
    expect(done).toBe(true);
  });

  it('a setting changed in ANOTHER window applies here at once (storage event)', async () => {
    await initLightMode({ ready: Promise.resolve({ lightMode: 'off' }), fetchMachine: async () => ({ totalMemGb: 16, onBattery: false }) });
    expect(isLightMode()).toBe(false);
    (g.localStorage as Storage).setItem('agent:settings:v1', JSON.stringify({ lightMode: 'on' }));
    const ev = new Event('storage') as Event & { key: string };
    Object.defineProperty(ev, 'key', { value: 'agent:settings:v1' });
    (g.window as EventTarget).dispatchEvent(ev);
    expect(isLightMode()).toBe(true);
    expect(dataset.light).toBe('true');
  });
});
