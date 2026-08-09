/**
 * The "Claude is asking" alarm — the ONE place a session raises the user off the app.
 *
 * A question is the strongest "needs you" signal an agent produces: the turn is stopped
 * dead until you answer, so the cost of missing it is a run that sits idle for an hour.
 * The in-app signals (dock chip shake, "?" bubble, attention badge) only reach you while
 * you are looking AT dreamcontext; these three reach you when you are not:
 *
 *   1. the chime   — you're in the app but on another page
 *   2. a banner    — you're in another app entirely
 *   3. a Dock bounce — you're in another app and banners are muted / already scrolled by
 *
 * They fire together, through one throttle, because they are one interruption. Called from
 * the ask EDGE in both session engines (`pushAsk` in chatSession.ts, `onSettle` in
 * agentSession.ts) — never on a redraw, never per pending card.
 */
import { playAskChime } from './chime';
import { bounceDockIcon, sendDesktopNotification } from './desktop';

/** Several agents asking in the same breath must not stack into a klaxon — or into three
 *  banners and a Dock that never stops jumping. One gate for the whole alarm. */
const MIN_INTERVAL_MS = 1500;
let lastRaise = 0;

/** A notification body has to be scannable from the corner of your eye; past roughly this
 *  much text macOS truncates it anyway, and a wall of prose in a banner reads as spam. */
const MAX_BODY = 180;

export interface AskAlarm {
  /** Who is asking — a session tab title, falling back to the vault name. Omitted when the
   *  caller has neither (the banner then just says dreamcontext is asking). */
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
 * The banner and the bounce are for reaching someone who is ELSEWHERE, so they are skipped
 * in that case — a system banner sliding over the very chat that raised it is noise, and
 * AppKit no-ops a bounce for the active app regardless. The chime is not skipped: within a
 * focused window you can still be on the Roadmap page with the asking session minimized to
 * the dock, which is exactly the case it exists for.
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
  if (now - lastRaise < MIN_INTERVAL_MS) return;
  lastRaise = now;

  playAskChime();
  if (isWatchingThisWindow()) return;

  void bounceDockIcon();
  const source = alarm.source?.trim();
  const detail = alarm.detail?.trim();
  void postBanner(
    source ? `Claude is asking · ${oneLine(source)}` : 'Claude is asking',
    detail ? oneLine(detail) : 'A question is waiting for your answer.',
  );
}
