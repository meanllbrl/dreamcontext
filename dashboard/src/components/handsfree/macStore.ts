import { useEffect, useState } from 'react';
import { api, RequestError } from '../../api/client';
import { isDesktop } from '../../lib/desktop';
import { MAC_MODE_ENDED_EVENT, type MacDevice, type MacStatus } from './macContract';

/**
 * Mac mode's desktop state: one shared poller over `GET /api/handsfree/mac/status` (5 s while on,
 * 30 s otherwise), desktop app only. The sheet, the chrome chip and the settings card all read it.
 */

let state: MacStatus | null = null;
const listeners = new Set<(s: MacStatus | null) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Did this reading end a run? On or stopping before, off now; a start that failed is not one. */
export function macModeEnded(prev: MacStatus | null, next: MacStatus | null): boolean {
  return (prev?.phase === 'on' || prev?.phase === 'stopping') && next?.phase === 'off';
}

function emit(next: MacStatus | null): void {
  const ended = macModeEnded(state, next);
  state = next;
  for (const l of listeners) l(next);
  // Whoever pressed Return (this sheet, another window, the CLI): this window sees it here.
  if (ended) window.dispatchEvent(new Event(MAC_MODE_ENDED_EVENT));
}

export async function refreshMacStatus(): Promise<MacStatus | null> {
  try {
    const s = await api.get<MacStatus>('/handsfree/mac/status');
    emit(s);
    return s;
  } catch {
    return state;
  }
}

function schedule(): void {
  if (timer || listeners.size === 0) return;
  timer = setTimeout(async () => {
    timer = null;
    await refreshMacStatus();
    schedule();
  }, state?.phase === 'on' || state?.phase === 'starting' ? 5_000 : 30_000);
}

export function useMacStatus(): MacStatus | null {
  const [s, setS] = useState<MacStatus | null>(state);
  useEffect(() => {
    if (!isDesktop()) return;
    listeners.add(setS);
    if (listeners.size === 1) void refreshMacStatus().then(schedule);
    else setS(state);
    return () => {
      listeners.delete(setS);
      if (listeners.size === 0 && timer) { clearTimeout(timer); timer = null; }
    };
  }, []);
  return s;
}

export type MacOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** POST/DELETE a Mac route; the status is refreshed after every action. */
export async function macAction<T>(method: 'post' | 'delete', path: string, body: Record<string, unknown> = {}): Promise<MacOutcome<T>> {
  try {
    const value = method === 'post' ? await api.post<T>(`/handsfree/mac/${path}`, body) : await api.del<T>(`/handsfree/mac/${path}`);
    void refreshMacStatus();
    return { ok: true, value };
  } catch (err) {
    void refreshMacStatus();
    if (err instanceof RequestError) return { ok: false, code: err.code || String(err.status), message: err.message };
    return { ok: false, code: 'network', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function macDevices(): Promise<MacDevice[]> {
  try { return (await api.get<{ devices: MacDevice[] }>('/handsfree/mac/devices')).devices; } catch { return []; }
}
