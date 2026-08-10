/**
 * The "Claude is asking" alarm — the ONE place a session raises the user off the app.
 *
 * A question is the strongest "needs you" signal an agent produces: the turn is stopped
 * dead until you answer, so the cost of missing it is a run that sits idle for an hour.
 * The in-app signals (dock chip shake, "?" bubble, attention badge) only reach you while
 * you are looking AT dreamcontext; these three reach you when you are not:
 *
 *   1. the chime   — you're in the app but on another page
 *   2. a banner    — you're in another app, or on another PROJECT's chip
 *   3. a Dock bounce — you're in another app and banners are muted / already scrolled by
 *
 * They fire from the ask EDGE in both session engines (`pushAsk` in chatSession.ts,
 * `onSettle` in agentSession.ts) — never on a redraw, never per pending card.
 *
 * One window now holds several LIVE projects, which splits "one interruption" in two. The
 * banner and the bounce are throttled per PROJECT (`alarm.source`, the asking session's
 * vault) and gated on whether that project's chip is the one on screen — two projects asking
 * a second apart are two separate interruptions, and under a single window-wide gate the
 * second one was dropped on the floor unheard. The chime keeps ONE window-wide floor,
 * because `chime.ts` plays through a single shared AudioContext and two chimes 200 ms apart
 * are a klaxon no matter which project rang.
 */
import { playAskChime } from './chime';
import { bounceDockIcon, sendDesktopNotification } from './desktop';

/** Several agents in ONE project asking in the same breath must not stack into three banners
 *  and a Dock that never stops jumping. Scoped per source rather than per app: a different
 *  project asking is a different interruption and has its own bucket. */
const MIN_INTERVAL_MS = 1500;
const lastRaiseBySource = new Map<string, number>();

/** The chime's own floor, deliberately GLOBAL — see the module header. Kept here, next to
 *  the alarm, rather than inside `chime.ts`, which stays a dumb un-throttled voice. */
let lastChime = 0;

/** A notification body has to be scannable from the corner of your eye; past roughly this
 *  much text macOS truncates it anyway, and a wall of prose in a banner reads as spam. */
const MAX_BODY = 180;

export interface AskAlarm {
  /** Who is asking — the asking session's VAULT NAME; both engines pass their own `vault`.
   *  Load-bearing past the banner's title: it is also the throttle bucket AND the key the
   *  chip probe answers on, so a per-session tab title here would attribute the alarm to a
   *  project that does not exist and the question would never reach the user. Empty/omitted
   *  when no project is pinned (launcher, browser build) — read as "unattributable" below,
   *  never as a project named "". */
  source?: string | null;
  /** The question itself, when the surface actually has the words for it. Chat does (the
   *  AskUserQuestion payload is structured); the terminal surface only has pixels on a
   *  screen, so it passes nothing and gets the generic line. */
  detail?: string | null;
}

/** Collapse whitespace and clip to a banner-sized line. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_BODY ? flat.slice(0, MAX_BODY - 1).trimEnd() + '…' : flat;
}

/**
 * True when this window is the one the user is literally looking at right now.
 *
 * Necessary but no longer SUFFICIENT to suppress the banner — see {@link isAlarmChipOnScreen}.
 * A focused window can still be showing a different project than the one that is asking.
 *
 * The chime is never skipped on either count: within a focused window on the right project
 * you can still be on the Roadmap page with the asking session minimized to the dock, which
 * is exactly the case it exists for.
 *
 * Note this is per-WINDOW, not per-app: with a vault window in the background and the
 * launcher up front, the background window's document reports no focus and correctly gets
 * the full alarm.
 */
function isWatchingThisWindow(): boolean {
  try {
    return document.visibilityState === 'visible' && document.hasFocus();
  } catch {
    return false; // no document (test env) — err toward raising the alarm
  }
}

/**
 * Answers "is the project that raised this alarm the chip currently on screen?" — registered
 * by `WindowChrome`, the only thing that knows which of its live projects is visible.
 *
 * INJECTED, not imported. This module is framework-free and is loaded by surfaces that have
 * no chips at all (the launcher window, the plain browser build, these tests); reaching into
 * React state from here would couple the alarm to a component that may not exist.
 */
let chipActiveProbe: ((vault: string) => boolean) | null = null;

/** Register the window's "which chip is visible?" answer, or `null` to unregister it. */
export function setChipActiveProbe(probe: ((vault: string) => boolean) | null): void {
  chipActiveProbe = probe;
}

/**
 * Is the alarm's own project the one on screen?
 *
 * The banner and the bounce are for reaching someone who is ELSEWHERE — a system banner
 * sliding over the very chat that raised it is noise, and AppKit no-ops a bounce for the
 * active app anyway. Before tabs, "elsewhere" was answered entirely by window focus. It no
 * longer is: the window can be focused while the asking project sits in a BACKGROUND chip,
 * which is precisely the case the chip strip exists to surface. Left to window focus alone
 * the user would get nothing at all.
 *
 * Two fallbacks, both deliberately `true` (= "on screen", suppress as before), so this stays
 * byte-identical to the pre-tabs alarm wherever chips do not apply:
 *   - no probe registered — the launcher, the browser build, tests;
 *   - no source on the alarm — it cannot be attributed to any chip, and firing a banner over
 *     the window the user is already looking at is the noise the guard exists to prevent.
 */
function isAlarmChipOnScreen(source: string): boolean {
  if (!source) return true;
  return chipActiveProbe?.(source) ?? true;
}

/** Post the banner through the desktop shell, falling back to the browser's own
 *  Notification API for the dev/web build (where there is no Tauri to ask). */
async function postBanner(title: string, body: string): Promise<void> {
  if (await sendDesktopNotification(title, body)) return;
  try {
    // WKWebView has no `window.Notification` until the Tauri plugin injects one, so this
    // arm is genuinely browser-only — inside the shell the call above already handled it.
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'denied') return;
    if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') return;
    new Notification(title, { body, tag: 'dreamcontext-ask' });
  } catch { /* blocked / unsupported — the chime already carried the signal */ }
}

/**
 * Raise the user: chime, native banner, Dock bounce. Fire-and-forget — the transports are
 * async but no caller waits on them, and every one of them swallows its own failure, so a
 * denied notification permission or a missing audio context can never break the reducer
 * that called it.
 */
export function raiseAskAttention(alarm: AskAlarm = {}): void {
  const now = Date.now();
  const source = alarm.source?.trim() ?? '';
  const lastForSource = lastRaiseBySource.get(source) ?? 0;
  if (now - lastForSource < MIN_INTERVAL_MS) return;
  lastRaiseBySource.set(source, now);

  // The one gate that stays window-wide: N projects asking at once is still one voice.
  if (now - lastChime >= MIN_INTERVAL_MS) {
    lastChime = now;
    playAskChime();
  }

  if (isWatchingThisWindow() && isAlarmChipOnScreen(source)) return;

  void bounceDockIcon();
  const detail = alarm.detail?.trim();
  void postBanner(
    source ? `Claude is asking · ${oneLine(source)}` : 'Claude is asking',
    detail ? oneLine(detail) : 'A question is waiting for your answer.',
  );
}
