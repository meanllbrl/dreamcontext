import { useEffect, useRef } from 'react';

/**
 * Slot registries that decouple SleepyPage (which owns WHERE the agent UI appears)
 * from the persistent {@link AgentSurface} (which owns the live sessions). Each is a
 * module-level singleton + listener set, read via `useSyncExternalStore` in the
 * surface and published by an anchor component SleepyPage renders.
 *
 *   - `AgentSlot`         — the rect the fixed terminal surface snaps itself over.
 *   - `AgentControlsSlot` — the top-bar anchor the bypass/+ controls portal into.
 */

// ── Terminal surface slot ───────────────────────────────────────────────────────

let slotEl: HTMLElement | null = null;
const slotListeners = new Set<() => void>();
function emitSlot() { for (const fn of slotListeners) fn(); }
function setAgentSlot(el: HTMLElement | null) {
  if (slotEl === el) return;
  slotEl = el;
  emitSlot();
}
export function subscribeSlot(fn: () => void): () => void {
  slotListeners.add(fn);
  return () => { slotListeners.delete(fn); };
}
export function getSlotEl(): HTMLElement | null { return slotEl; }

export function AgentSlot() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setAgentSlot(ref.current);
    // Only relinquish the slot if it's still OURS — during a tab transition the
    // next instance can mount (and claim the singleton) before this one unmounts;
    // a blind `setAgentSlot(null)` would then clobber the new anchor.
    return () => { if (slotEl === ref.current) setAgentSlot(null); };
  }, []);
  return <div ref={ref} className="agent-slot" aria-hidden />;
}

// ── Controls slot ───────────────────────────────────────────────────────────────
// The cross-cutting session controls (bypass default + new-session +) used to float
// over the terminal's top-right corner. SleepyPage now hosts them in its top bar,
// ACROSS FROM the Search/Ask/Agent tabs, by publishing an anchor here; the surface
// portals the live controls into it (keeping their state owned by AgentSurface).

let controlsSlotEl: HTMLElement | null = null;
const controlsSlotListeners = new Set<() => void>();
function emitControlsSlot() { for (const fn of controlsSlotListeners) fn(); }
function setAgentControlsSlot(el: HTMLElement | null) {
  if (controlsSlotEl === el) return;
  controlsSlotEl = el;
  emitControlsSlot();
}
export function subscribeControlsSlot(fn: () => void): () => void {
  controlsSlotListeners.add(fn);
  return () => { controlsSlotListeners.delete(fn); };
}
export function getControlsSlotEl(): HTMLElement | null { return controlsSlotEl; }

export function AgentControlsSlot() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setAgentControlsSlot(ref.current);
    // Only relinquish if still ours — see AgentSlot: guards against a mount/unmount
    // overlap during a tab transition nulling the new instance's anchor.
    return () => { if (controlsSlotEl === ref.current) setAgentControlsSlot(null); };
  }, []);
  return <div ref={ref} className="agent-controls-slot" />;
}
