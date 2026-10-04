/**
 * "Which project is the owner looking at right now?" — told to the server by the window that
 * has focus (`POST /api/assistant/presence`).
 *
 * The notch inbox reads it to decide whether a chat that just finished is news (owner,
 * 2026-10-04: "show that if we are not in that window"), and the Assistant's live context reads
 * it to know what the owner is doing. A window reports its VISIBLE project while it is focused
 * and visible, `null` when it loses either, and re-reports every HEARTBEAT_MS while focused,
 * because the server stops believing a report after a minute (a window that dies while focused
 * must not hide finishes for ever).
 */
import { isDesktop } from './desktop';
import { thisWindowLabel } from './windowRegistry';

export const PRESENCE_HEARTBEAT_MS = 20_000;

async function send(vault: string | null): Promise<void> {
  const label = await thisWindowLabel();
  if (!label) return;
  try {
    await fetch('/api/assistant/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, vault }),
    });
  } catch { /* the next focus change or heartbeat says it again */ }
}

/** Is this window the one in front of the owner? */
function inFront(): boolean {
  try {
    return document.visibilityState === 'visible' && document.hasFocus();
  } catch {
    return false;
  }
}

/**
 * Keep the server told about this window while it lives. `current()` answers which project
 * the window shows right now (null for none). Returns the disposer; the caller calls `poke()`
 * whenever the visible project changes.
 */
export function trackPresence(current: () => string | null): { poke: () => void; dispose: () => void } {
  if (!isDesktop()) return { poke: () => {}, dispose: () => {} };
  let last: string | null | undefined;
  const report = (force = false) => {
    const now = inFront() ? current() : null;
    if (!force && now === last) return;
    last = now;
    void send(now);
  };
  const onFocus = () => report();
  const onBlur = () => report();
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onFocus);
  const beat = window.setInterval(() => { if (last) report(true); }, PRESENCE_HEARTBEAT_MS);
  report(true);
  return {
    poke: () => report(),
    dispose: () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onFocus);
      window.clearInterval(beat);
      if (last) void send(null);
    },
  };
}
