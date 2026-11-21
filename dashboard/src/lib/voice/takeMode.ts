/**
 * What a finished dictation take does: `send` (default, the message goes out as it always did)
 * or `paste` (the words land in the composer at the caret and wait for the owner to fix and send
 * them). Owner, 2026-11-22: "mikrofonu bıraktıktan sonra direkt göndermesin, kompozere yapıştırsın".
 *
 * Same shape as `readAloud.ts`: localStorage so the choice survives a reload, an in-module
 * listener set for every composer of this window (Chat, Super, notch), the `storage` event for
 * the other windows. No storage degrades to an in-memory value that starts at `send`.
 */

export type TakeMode = 'send' | 'paste';

const KEY = 'dreamcontext-take-mode';

let memory: TakeMode = 'send';
const listeners = new Set<(m: TakeMode) => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function parse(v: string | null): TakeMode {
  return v === 'paste' ? 'paste' : 'send';
}

export function takeMode(): TakeMode {
  const s = storage();
  if (!s) return memory;
  try {
    return parse(s.getItem(KEY));
  } catch {
    return memory;
  }
}

export function setTakeMode(mode: TakeMode): void {
  memory = mode;
  try {
    storage()?.setItem(KEY, mode);
  } catch { /* the in-memory value still holds for this window */ }
  for (const fn of [...listeners]) fn(mode);
}

export function onTakeMode(fn: (m: TakeMode) => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    memory = parse(e.newValue);
    fn(memory);
  };
  const w = typeof window === 'undefined' ? null : window;
  w?.addEventListener?.('storage', onStorage as EventListener);
  return () => {
    listeners.delete(fn);
    w?.removeEventListener?.('storage', onStorage as EventListener);
  };
}
