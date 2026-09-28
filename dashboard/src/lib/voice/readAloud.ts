/**
 * Whether assistant replies are read aloud. OPT-IN: off until the owner turns it on from the
 * composer, and the choice survives a reload.
 *
 * WHY NOT `voicePrefs().speech`. That one is a server setting (Settings → Voice) and answers
 * "may this machine speak at all". This one is the composer's own switch, flipped many times
 * a day, and answers "do I want to hear replies right now". Speech happens only when BOTH are
 * on; see {@link readAloudEnabled}'s callers in the speech path.
 *
 * WHY localStorage AND NOT React state. Several surfaces show the same switch at once (the
 * notch, a popped-out window, a chat pane), and the speech queue that must obey it is a plain
 * class. A synchronous getter serves the queue; the in-module listener set serves every
 * composer in this window; the `storage` event carries the change to every OTHER window of
 * the same origin. No storage (SSR, tests, a locked-down webview) degrades to an in-memory
 * value that starts off.
 */

const KEY = 'dreamcontext-read-aloud';

let memory = false;
const listeners = new Set<(on: boolean) => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The current choice. Synchronous by design: the speech queue reads it per sentence. */
export function readAloudEnabled(): boolean {
  const s = storage();
  if (!s) return memory;
  try {
    return s.getItem(KEY) === '1';
  } catch {
    return memory;
  }
}

/** Change the choice and tell every listener in this window. Other windows hear it through
 *  the `storage` event, which the browser fires only in the windows that did NOT write. */
export function setReadAloud(on: boolean): void {
  memory = on;
  const s = storage();
  try {
    s?.setItem(KEY, on ? '1' : '0');
  } catch { /* quota or a locked store: the in-memory value still holds for this window */ }
  for (const fn of [...listeners]) fn(on);
}

/** Subscribe to changes from this window and from every other one. Returns the unsubscribe. */
export function onReadAloud(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    memory = e.newValue === '1';
    fn(memory);
  };
  const w = typeof window === 'undefined' ? null : window;
  w?.addEventListener?.('storage', onStorage as EventListener);
  return () => {
    listeners.delete(fn);
    w?.removeEventListener?.('storage', onStorage as EventListener);
  };
}
