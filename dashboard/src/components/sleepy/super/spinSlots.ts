import { useEffect, useSyncExternalStore } from 'react';

/**
 * At most {@link MAX_SPINNING} working tiles turn their border ring at once (owner 2026-10-21;
 * task "durum animasyonları WindowServer'ı yormaz": every turning ring is composited on every
 * stepped frame). A tile past the cap shows the ring closed, still green, still WORKING. First
 * come, first served; a slot frees when its tile stops working or unmounts. Window-local state,
 * no timer, no request.
 */
export const MAX_SPINNING = 4;

let order: string[] = [];
/** Claims per id: the same chat drawn twice (a stage tile and an open panel) holds ONE slot,
 *  freed only when its last copy lets go (frontend review Minor 1). */
const claims = new Map<string, number>();
const listeners = new Set<() => void>();
const emit = () => { for (const fn of [...listeners]) fn(); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Tests only. */
export function _spinOrder(): readonly string[] { return order; }
export function _resetSpinSlots(): void { order = []; claims.clear(); emit(); }

export function claimSpin(id: string): void {
  claims.set(id, (claims.get(id) ?? 0) + 1);
  if (order.includes(id)) return;
  order = [...order, id];
  emit();
}
export function releaseSpin(id: string): void {
  const left = (claims.get(id) ?? 0) - 1;
  if (left > 0) { claims.set(id, left); return; }
  claims.delete(id);
  if (!order.includes(id)) return;
  order = order.filter((x) => x !== id);
  emit();
}
export function spinAllowed(id: string): boolean {
  const i = order.indexOf(id);
  return i >= 0 && i < MAX_SPINNING;
}

/** A tile asks for a slot while `working`; returns whether its ring may turn. */
export function useSpinSlot(id: string, working: boolean): boolean {
  useEffect(() => {
    if (!working || !id) return undefined;
    claimSpin(id);
    return () => releaseSpin(id);
  }, [id, working]);
  const read = () => working && spinAllowed(id);
  return useSyncExternalStore(subscribe, read, read);
}
