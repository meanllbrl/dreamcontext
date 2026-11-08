/**
 * The microphone permission, seen from the page (`desktop/src-tauri/src/mic_permission.rs`).
 *
 * macOS asks for the microphone only the first time something opens it, and the composer used
 * to hide its mic until local dictation was installed, so a Mac that had never recorded never
 * saw the prompt (owner, 2026-11-08). The composer's mic menu now reads this state up front and
 * offers "Allow microphone access" as a step.
 *
 * An older `.app` has no such commands (the shell and the dashboard update on different
 * cadences): that reads as `unknown`, which offers no step and lets the first take ask, the way
 * it always did. A browser has no microphone path at all.
 */

import { useEffect, useState } from 'react';
import { isDesktop } from '../desktop';

export type MicPermission = 'granted' | 'prompt' | 'denied' | 'restricted' | 'unknown';

/** Fired when the permission may have changed (the prompt answered, the app refocused). */
export const MIC_PERMISSION_EVENT = 'dc:mic-permission';

async function invoke<T>(cmd: string): Promise<T> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(cmd);
}

const KNOWN = new Set<MicPermission>(['granted', 'prompt', 'denied', 'restricted']);

export async function readMicPermission(): Promise<MicPermission> {
  if (!isDesktop()) return 'unknown';
  try {
    const v = await invoke<string>('mic_permission');
    return KNOWN.has(v as MicPermission) ? (v as MicPermission) : 'unknown';
  } catch {
    return 'unknown';
  }
}

function changed(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MIC_PERMISSION_EVENT));
}

/**
 * The step's action. Never asked yet: the macOS prompt. Refused (or locked by a profile): the
 * prompt cannot come back, so System Settings › Microphone opens instead. Returns the state
 * after the attempt.
 */
export async function grantMicPermission(current: MicPermission): Promise<MicPermission> {
  if (!isDesktop()) return current;
  try {
    if (current === 'prompt') {
      await invoke<boolean>('mic_permission_request');
    } else {
      await invoke<void>('mic_open_settings');
    }
  } catch { /* an older shell: nothing to do but read again */ }
  const next = await readMicPermission();
  changed();
  return next;
}

export function onMicPermission(fn: () => void): () => void {
  window.addEventListener(MIC_PERMISSION_EVENT, fn);
  // Coming back from System Settings is a focus: read again then.
  window.addEventListener('focus', fn);
  return () => {
    window.removeEventListener(MIC_PERMISSION_EVENT, fn);
    window.removeEventListener('focus', fn);
  };
}

/** The permission, kept live for a composer: read on mount, after the step, and on refocus. */
export function useMicPermission(enabled: boolean): MicPermission {
  const [state, setState] = useState<MicPermission>('unknown');
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const read = () => { void readMicPermission().then((v) => { if (live) setState(v); }); };
    read();
    const off = onMicPermission(read);
    return () => { live = false; off(); };
  }, [enabled]);
  return state;
}
