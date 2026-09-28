/**
 * THE FRAME THE NOTCH SEAT MUST HAVE, and who is allowed to set it.
 *
 * The owner's recording (2026-09-27): after every Space switch the collapsed notch came back
 * a moment later at the OPEN panel's 460x400 — an empty black box with the pill floating in
 * its middle — and the next switch put it back, with no click and no hotkey. The window's real
 * frame and the notch's state had parted ways. Three rules keep them together:
 * - latest wins: every seat change claims a new generation, and a call that wakes up (every
 *   native call is an await) after a newer one stops, so a collapse can never land under a
 *   late expand;
 * - the frame is re-asserted: `wanted` is the notch seat's frame (null when popped out — a
 *   window is the owner's to size), and `healSeat` puts the window back on it whenever it
 *   resized, moved, or simply drifted (see the guard in `Notch`);
 * - an animation is not drift: while a frame change is in flight (`withFlight`) every frame
 *   the window passes through is on purpose, so the heal steps aside, and runs ONE check once
 *   the last flight has ended.
 *
 * The window is reached through an injected facade so the guard is testable without Tauri.
 */

export interface SeatFrame { width: number; height: number; x?: number; y?: number }

export interface SeatWindow {
  isVisible(): Promise<boolean>;
  /** The window's current frame, logical px. */
  frame(): Promise<{ x: number; y: number; width: number; height: number }>;
  /** Put the window on `f` at once (a correction, never animated). */
  apply(f: SeatFrame): Promise<void>;
}

/** A flight older than this is treated as ended — the Rust deadline makes it unreachable, but the guard must never die. */
const STALE_FLIGHT_MS = 2000;

let seatGen = 0;
let wanted: SeatFrame | null = null;
let facade: SeatWindow | null = null;
let nextFlight = 0;
const flights = new Map<number, number>();

/** The window the guard reads and heals (null = nothing to guard, e.g. the browser preview). */
export function setSeatWindow(w: SeatWindow | null): void {
  facade = w;
}

/** A new seat change: every older one stops at its next await. `want` is the notch frame to hold, or null. */
export function claimSeat(want: SeatFrame | null = null): number {
  wanted = want;
  return ++seatGen;
}

/** True while `gen` is still the latest seat change. */
export function isCurrentSeat(gen: number): boolean {
  return gen === seatGen;
}

/** Hold `f` as the notch frame for seat change `gen`; false (and nothing held) when it was superseded. */
export function wantSeat(gen: number, f: SeatFrame | null): boolean {
  if (gen !== seatGen) return false;
  wanted = f;
  return true;
}

/** True while a frame change is in flight (a flight older than 2s no longer counts). */
export function flying(now: number = Date.now()): boolean {
  for (const started of flights.values()) if (now - started < STALE_FLIGHT_MS) return true;
  return false;
}

/**
 * Run a frame change as a flight. The flight ends however `fn` ends — resolved, rejected or
 * thrown — and when it was the last one, the guard checks the frame once.
 */
export async function withFlight<T>(fn: () => Promise<T>): Promise<T> {
  const id = ++nextFlight;
  flights.set(id, Date.now());
  try {
    return await fn();
  } finally {
    flights.delete(id);
    if (!flying()) void healSeat();
  }
}

/**
 * Put the notch back on `wanted` if the window is not there. Returns true when it had to.
 * A seat change or a frame animation in flight owns the frame, so a heal that sees one steps aside.
 */
export async function healSeat(): Promise<boolean> {
  const f = wanted;
  const win = facade;
  if (!f || !win || flying()) return false;
  const gen = seatGen;
  try {
    if (!(await win.isVisible())) return false;
    const at = await win.frame();
    if (gen !== seatGen || f !== wanted || flying()) return false;
    const off = (a: number, b: number) => Math.abs(a - b) > 2;
    const drifted = off(at.width, f.width) || off(at.height, f.height)
      || (f.x !== undefined && f.y !== undefined && (off(at.x, f.x) || off(at.y, f.y)));
    if (!drifted) return false;
    await win.apply(f);
    return true;
  } catch {
    return false;
  }
}

/** Tests only: forget every generation, flight and window. */
export function resetSeatGuard(): void {
  seatGen = 0;
  wanted = null;
  facade = null;
  flights.clear();
}
