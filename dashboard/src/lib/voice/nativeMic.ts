/**
 * The desktop shell's microphone (`desktop/src-tauri/src/mic.rs`), seen from the page.
 *
 * In the desktop app a take is recorded by Rust, not by WebKit. The hotkey opens it at the
 * press, before this page has even heard of the key, so the owner's first words are on tape
 * however long the notch takes to open; the samples arrive on CoreAudio's real-time thread,
 * so a busy page cannot drop them; and they are the raw device, the same signal Handy hands
 * whisper. `useVoiceCapture.ts` falls back to its WebKit path when this is unavailable: in a
 * browser, or under an older `.app` that has no `mic_take_*` commands (the shell and the
 * dashboard update on different cadences).
 */

import { isDesktop } from '../desktop';

export interface NativeTake {
  /** Device sample rate. */
  rate: number;
  /** Mono samples from the moment the take opened (the hotkey press, for a hotkey take). */
  samples: Float32Array;
  /** ms from the take opening to the stream playing / to the first sample; null = never. */
  openedMs: number | null;
  firstSampleMs: number | null;
  /** ms from the take opening to its end. */
  wallMs: number;
}

const NOT_YET = 0xffffffff;

/** Unknown until the first call answers; false once the shell said it has no such command. */
let supported: boolean | null = null;

/** How many `mic_take_begin` calls this page has sent. A begin that answers after its deadline
 *  cancels its take only if it is still the LAST one sent: the shell hands the SAME id to every
 *  claim of an open take, so a later press may already own it (found in review, 2026-11-13). */
let beginsSent = 0;

export function nativeMicAvailable(): boolean {
  return isDesktop() && supported !== false;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(cmd, args);
}

/** An older shell answers "command … not found"; an ACL refusal says "not allowed". Either way
 *  this shell cannot record natively, and asking again on every take would only add latency. */
function unsupported(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return /not found|not allowed|unknown command/i.test(msg);
}

/**
 * Learn, without touching any take, whether this shell records natively. Cancelling an id that
 * cannot exist is a no-op that still proves the command is there. Called when a composer
 * mounts, so the first press already knows which path it is on: the WebKit path must build
 * its AudioContext synchronously inside the press, so the choice cannot wait for an answer.
 */
export async function probeNativeMic(): Promise<boolean> {
  if (!isDesktop()) return false;
  if (supported !== null) return supported;
  try {
    await invoke('mic_take_cancel', { id: Number.MAX_SAFE_INTEGER });
    supported = true;
  } catch (err) {
    supported = !unsupported(err);
  }
  return supported;
}

/**
 * How long a shell call may take before the take is given up. Opening is a thread spawn and
 * ending is a join plus the samples, so both are normally milliseconds; a call that never
 * answers (a CoreAudio device that vanished mid-close) would otherwise hold the composer's
 * busy guard for good, and every later press would be refused without a word until a restart.
 */
export const BEGIN_DEADLINE_MS = 5_000;
export const END_DEADLINE_MS = 20_000;

/**
 * `p`, or a rejection after `ms`. A value that lands after the deadline is handed to `late`
 * (so a take opened too late is cancelled rather than left recording with nobody holding it).
 */
export function withDeadline<T>(p: Promise<T>, ms: number, late?: (v: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new Error('the microphone did not answer'));
    }, ms);
    p.then((v) => {
      if (done) { late?.(v); return; }
      done = true;
      clearTimeout(timer);
      resolve(v);
    }, (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** May a begin that answered late cancel the take it got? Only when no begin was sent after it:
 *  a later one was queued behind it in the shell and has claimed that same take. Pure. */
export function lateBeginMayCancel(mine: number, sent: number): boolean {
  return mine === sent;
}

/** True once the shell has proven it records natively. */
export function nativeMicReady(): boolean {
  return isDesktop() && supported === true;
}

/** Claim the take the hotkey opened, or open one. Null when this shell cannot record natively
 *  (the caller falls back to WebKit); throws on a real failure to open the microphone. */
export async function beginNativeTake(): Promise<{ id: number; sinceMs: number } | null> {
  if (!nativeMicAvailable()) return null;
  try {
    const mine = ++beginsSent;
    const r = await withDeadline(
      invoke<{ id: number; sinceMs: number }>('mic_take_begin'),
      BEGIN_DEADLINE_MS,
      (late) => { if (lateBeginMayCancel(mine, beginsSent)) void invoke('mic_take_cancel', { id: late.id }).catch(() => {}); },
    );
    supported = true;
    return r;
  } catch (err) {
    if (unsupported(err)) { supported = false; return null; }
    throw err;
  }
}

/** Decode `mic_take_end`'s body: four little-endian u32s, then f32 samples. Pure, for tests. */
export function decodeNativeTake(buf: ArrayBuffer): NativeTake {
  const view = new DataView(buf);
  const u32 = (at: number) => view.getUint32(at, true);
  const opened = u32(4);
  const first = u32(8);
  // Copied out rather than viewed: the body's offset may not be 4-aligned in every engine.
  const samples = new Float32Array((buf.byteLength - 16) / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(16 + i * 4, true);
  return {
    rate: u32(0),
    samples,
    openedMs: opened === NOT_YET ? null : opened,
    firstSampleMs: first === NOT_YET ? null : first,
    wallMs: u32(12),
  };
}

export async function endNativeTake(id: number): Promise<NativeTake> {
  const body = await withDeadline(invoke<ArrayBuffer | number[]>('mic_take_end', { id }), END_DEADLINE_MS);
  const buf = body instanceof ArrayBuffer ? body : new Uint8Array(body).buffer;
  return decodeNativeTake(buf);
}

/** Drop a take by id, or (no id) the hotkey take nobody claimed. Never throws. */
export async function cancelNativeTake(id?: number): Promise<void> {
  if (!nativeMicAvailable()) return;
  try { await invoke('mic_take_cancel', { id: id ?? null }); } catch { /* nothing open */ }
}

/** The default input's name as macOS gives it, for "no sound reached the app from …". Null
 *  when unknown, including under an older shell that has no `mic_input_name`. */
export async function nativeInputName(): Promise<string | null> {
  if (!nativeMicAvailable()) return null;
  try {
    const name = await withDeadline(invoke<string | null>('mic_input_name'), BEGIN_DEADLINE_MS);
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/** The live level (RMS) while a native take is open. Returns the unsubscribe. */
export async function onNativeLevel(fn: (level: number) => void): Promise<() => void> {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen<number>('mic://level', (e) => {
      if (typeof e.payload === 'number') fn(e.payload);
    });
  } catch {
    return () => {};
  }
}
