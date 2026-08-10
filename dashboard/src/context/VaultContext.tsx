import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ApiClient } from '../api/client';

/**
 * Which project a subtree belongs to — the identity every per-instance surface reads.
 *
 * One OS window now holds several LIVE projects at once (a chip strip, not a window each),
 * so "the vault" stopped being a property of the window and became a property of a subtree.
 * Everything that used to be a module-level global — the API client's vault header, the
 * localStorage key namespace, the window events one project fires at itself — hangs off this
 * context instead, because with N instances mounted in one JS realm a module-level global is
 * shared state between unrelated projects.
 */
export interface VaultContextValue {
  /** The project name, or null in the launcher / browser build where none is pinned. */
  vault: string | null;
  /** Stable per mounted `ProjectInstance`, e.g. `inst-1`. Namespaces anything that would
   *  otherwise collide between two instances of the same component (overlay ids). */
  instanceId: string;
  /** Whether this instance is the chip the user is looking at. Hidden instances stay MOUNTED
   *  and LIVE — this only gates cosmetics and polling, never a WebSocket. */
  isActive: boolean;
  /** Replaces `window` for the events one project fires at itself (navigate, delegate, run
   *  sleep, …). On `window` every mounted instance hears them and the wrong project acts. */
  bus: EventTarget;
}

/**
 * The bus handed to consumers rendered outside any provider. A module singleton rather than
 * a fresh EventTarget per call so that an emit and a listen from two such consumers still
 * meet — off-instance surfaces (launcher, capture bar, perch, checklist window) are a single
 * logical "instance" and must keep behaving exactly as they do on `window` today.
 */
const FALLBACK_BUS: EventTarget = new EventTarget();

/**
 * What `useVault()` answers with NO provider above it — load-bearing, not a placeholder.
 *
 * `vault: null` makes `useApi()` return a client identical to the module `api`, so the
 * launcher, `CaptureBar`, `SleepyPerch` and the checklist window are byte-identical to
 * today. `isActive: true` so nothing outside a provider ever believes it is hidden and
 * quietly stops rendering or polling.
 */
export const DEFAULT_VAULT_CONTEXT: VaultContextValue = {
  vault: null,
  instanceId: '',
  isActive: true,
  bus: FALLBACK_BUS,
};

const VaultContext = createContext<VaultContextValue>(DEFAULT_VAULT_CONTEXT);

export function VaultProvider({ vault, instanceId, isActive, bus, children }: VaultContextValue & { children: ReactNode }) {
  // Memoized on the four fields, not rebuilt per render: `useApi()` derives its client from
  // `vault` and callers list that client in `useCallback` deps, so a fresh context object
  // every render would invalidate those callbacks on every parent re-render.
  const value = useMemo<VaultContextValue>(
    () => ({ vault, instanceId, isActive, bus }),
    [vault, instanceId, isActive, bus],
  );
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

/** This subtree's project identity, or {@link DEFAULT_VAULT_CONTEXT} outside a provider. */
export function useVault(): VaultContextValue {
  return useContext(VaultContext);
}

/**
 * The API client bound to THIS subtree's vault. Stable identity per vault (memoized), which
 * is what lets call sites put `api` in a `useCallback`/`useEffect` dependency array without
 * re-running on every render.
 */
export function useApi(): ApiClient {
  const { vault } = useVault();
  return useMemo(() => new ApiClient(vault), [vault]);
}

/** Fire an instance-scoped event — the bus twin of `window.dispatchEvent(new CustomEvent(…))`. */
export function emitInstance<T>(bus: EventTarget, type: string, detail?: T): void {
  bus.dispatchEvent(new CustomEvent<T | undefined>(type, { detail }));
}

/**
 * Subscribe to an instance-scoped event for as long as the component is mounted.
 *
 * `handler` is held in a ref so a caller may pass an inline closure without resubscribing on
 * every render; the subscription itself is re-established only when the bus or the event
 * type actually changes.
 */
export function useInstanceEvent<T>(type: string, handler: (detail: T) => void): void {
  const { bus } = useVault();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const listener = (event: Event) => handlerRef.current((event as CustomEvent<T>).detail);
    bus.addEventListener(type, listener);
    return () => bus.removeEventListener(type, listener);
  }, [bus, type]);
}
