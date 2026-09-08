/**
 * WHICH COMPOSER OWNS THE PUSH-TO-TALK CHORD — because more than one is always listening.
 *
 * The binding is deliberately window-level: the whole point of the mode is that the owner's
 * hands are nowhere near the textarea. What was missed is that a chat pane NEVER UNMOUNTS
 * while its session lives. `AgentSurface` portals every live chat session's `<ChatPane>` into
 * its own detached container "unconditionally (not gated on minimized/expanded)", and parks
 * the container in a `display: none` garage when it is not on screen. So every J.A.R.V.I.S
 * session in the window — minimized, in a background tab, or behind a collapsed overlay —
 * had its own `window` keydown listener, and one press started a take in ALL of them at once:
 * N microphones open, N transcripts racing, and the take landing in a conversation the owner
 * was not looking at. With a second project window open it happened there too, which is how
 * the owner found it ("farklı projede bile mikrofonu açıyor").
 *
 * The guard is ownership rather than removal, so the useful half survives: exactly one
 * registered composer answers a press, chosen at the moment of the press rather than
 * remembered, because the winner changes with every tab switch.
 *
 * THE ORDER IS THE POINT — where the owner is looking beats where they last were:
 *   1. The composer whose subtree holds the FOCUSED element. Typing in a box and pressing the
 *      chord means that box, whatever else is on screen.
 *   2. The only VISIBLE composer, when there is exactly one. The common case: one chat, hands
 *      off the keyboard entirely.
 *   3. The visible composer the owner touched most recently — split panes, focus in neither.
 *   4. Nobody. A press with no visible chat does NOTHING, which is the entire fix for a chord
 *      that used to open the microphone from a settings page.
 */

/** A registered composer: the element that stands for its pane. */
type Holder = { el: () => HTMLElement | null };

const holders = new Set<Holder>();
/** The most recently focused holder, for the split-pane tie-break. The HOLDER rather than
 *  its element, so unregistering a pane forgets it and no detached node is kept alive. */
let lastTouched: Holder | null = null;
let watching = false;

/** Is this element on screen? A garaged pane is inside `display: none`, so it is not.
 *  `checkVisibility` where the engine has it (WebKit 17.4+, and the app's webview is WebKit),
 *  `offsetParent` as the fallback — which the pane layout already relies on elsewhere. */
function visible(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  const check = (el as { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === 'function') return check.call(el);
  return el.offsetParent !== null;
}

function onFocusIn(e: FocusEvent): void {
  const target = e.target as Node | null;
  if (!target) return;
  for (const h of holders) {
    const el = h.el();
    if (el && el.contains(target)) { lastTouched = h; return; }
  }
}

/**
 * Register a composer as a candidate for the chord. Returns the un-register.
 *
 * The listener is installed once for the whole window and removed with the last holder — a
 * per-composer `focusin` listener would be the same multiplication this module exists to end.
 */
export function registerPushToTalk(el: () => HTMLElement | null): () => void {
  const holder: Holder = { el };
  holders.add(holder);
  if (!watching) {
    window.addEventListener('focusin', onFocusIn, true);
    watching = true;
  }
  return () => {
    holders.delete(holder);
    if (lastTouched === holder) lastTouched = null;
    if (holders.size === 0 && watching) {
      window.removeEventListener('focusin', onFocusIn, true);
      watching = false;
    }
  };
}

/** The element that should answer the chord right now, or null for "nobody should". */
export function pushToTalkOwner(): HTMLElement | null {
  const live: HTMLElement[] = [];
  for (const h of holders) {
    const el = h.el();
    if (visible(el)) live.push(el);
  }
  if (live.length === 0) return null;
  const focused = document.activeElement;
  if (focused) {
    const owning = live.find((el) => el.contains(focused));
    if (owning) return owning;
  }
  if (live.length === 1) return live[0];
  const touched = lastTouched?.el() ?? null;
  return touched && live.includes(touched) ? touched : null;
}

/** Should the composer rooted at `el` handle this press? */
export function ownsPushToTalk(el: HTMLElement | null): boolean {
  if (!el) return false;
  // A window that is not the focused one gets no key events anyway; the check costs nothing
  // and closes the synthetic-event case.
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
  return pushToTalkOwner() === el;
}

/** Test seam: forget every registration. Not called by the app. */
export function resetPushToTalkScope(): void {
  holders.clear();
  lastTouched = null;
  if (watching) {
    window.removeEventListener('focusin', onFocusIn, true);
    watching = false;
  }
}
