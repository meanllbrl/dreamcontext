/**
 * "Which project is the owner looking at right now?" — told to the server by the window that
 * has focus (`POST /api/assistant/presence`).
 *
 * The notch inbox reads it to decide whether a chat that just finished is news (owner,
 * 2026-10-04: "show that if we are not in that window"), and the Assistant's live context reads
 * it to know what the owner is doing. Since 2026-10-18 it also names the chat the owner is
 * FOCUSED on (lib/focusedChat.ts): only that one is on his screen, every other chat is still news
 * (briefly, since he is in the app). A window reports its VISIBLE project while it is focused
 * and visible, `null` when it loses either, and re-reports every HEARTBEAT_MS while focused,
 * because the server stops believing a report after a minute (a window that dies while focused
 * must not hide finishes for ever).
 */
import { isDesktop } from './desktop';
import { thisWindowLabel } from './windowRegistry';
import { getWindowActivity, onWindowActivity } from './windowActivity';

export const PRESENCE_HEARTBEAT_MS = 20_000;

/** What a focused window shows: its project, and the chat focused in it (none: null). */
export interface Looking { vault: string; sessionId: string | null }

async function send(now: Looking | null): Promise<void> {
  const label = await thisWindowLabel();
  if (!label) return;
  try {
    await fetch('/api/assistant/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, vault: now?.vault ?? null, sessionId: now?.sessionId ?? null }),
    });
  } catch { /* the next focus change or heartbeat says it again */ }
}

/**
 * Keep the server told about this window while it lives. `current()` answers which project
 * the window shows right now and which chat in it has the focus (null for none). Returns the
 * disposer; the caller calls `poke()` whenever either changes.
 *
 * "In front" is windowActivity's `focused`: visible AND the shell's own focus (the NSWindow is
 * key) once it has answered, the page's `hasFocus()` only until then. The page's answer alone
 * was wrong in the desktop app: a window brought forward from the notch could be key while its
 * page believed it was unfocused, so it never reported at all (see
 * desktop/src-tauri/src/page_focus.rs).
 */
export function trackPresence(current: () => Looking | null): { poke: () => void; dispose: () => void } {
  if (!isDesktop()) return { poke: () => {}, dispose: () => {} };
  let last: string | null | undefined;
  const report = (force = false) => {
    const now = getWindowActivity().focused ? current() : null;
    const key = now ? `${now.vault}\u0000${now.sessionId ?? ''}` : null;
    if (!force && key === last) return;
    last = key;
    void send(now);
  };
  const off = onWindowActivity(() => report());
  const beat = window.setInterval(() => { if (last) report(true); }, PRESENCE_HEARTBEAT_MS);
  report(true);
  return {
    poke: () => report(),
    dispose: () => {
      off();
      window.clearInterval(beat);
      if (last) void send(null);
    },
  };
}
