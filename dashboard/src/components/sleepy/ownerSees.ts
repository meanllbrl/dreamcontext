/**
 * Does the owner see this session right now? The one rule behind the "unseen" dot (the magenta
 * flag on a drawer row, a tab and a project chip, `wantsALook`).
 *
 * A session is seen when it is drawn on screen AND the window is in front. Seen, it never raises
 * the flag and any flag it holds goes by itself; a click is not what makes it read.
 * Not seen (another tab, another project, another page, another app): the flag raises and stays.
 * "In front" is `lib/windowActivity.ts`, never `document.hasFocus()`: the desktop web view and a
 * chat's iframes make that answer wrong.
 */

/**
 * The sessions drawn on screen. `foreground` is the surface's own answer on a wide screen (each
 * pane's active tab, the Super stage's two, the Super dock).
 */
export function sessionsInView(opts: {
  /** This surface's project is the one on screen. */
  projectOnScreen: boolean;
  foreground: ReadonlySet<string>;
  /** A panel (a team conversation, a transcript) lies over the chat panes. Super stage: false. */
  panesCovered: boolean;
  /** The narrow layout shows one chat or the list: that chat's id, '' on the list; null when wide. */
  phoneChat: string | null;
}): Set<string> {
  if (!opts.projectOnScreen || opts.panesCovered) return new Set();
  if (opts.phoneChat !== null) return new Set(opts.phoneChat ? [opts.phoneChat] : []);
  return new Set(opts.foreground);
}

/** Write the answer onto each session and take the flag off what is seen. True: a flag went. */
export function applySeen(
  sessions: Iterable<{ id: string; seen: boolean; attention: boolean }>,
  inView: ReadonlySet<string>,
  inFront: boolean,
): boolean {
  let cleared = false;
  for (const s of sessions) {
    s.seen = inFront && inView.has(s.id);
    if (s.seen && s.attention) { s.attention = false; cleared = true; }
  }
  return cleared;
}
