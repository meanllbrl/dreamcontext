import { useCallback, useSyncExternalStore } from 'react';
import type { Page } from '../components/layout/Sidebar';
import { pageContextBlock, type PageContextRef } from './superTypes';

export type { PageContextRef };

/**
 * The page a project shows right now, as the Super dock sends it with a message (owner
 * 2026-10-25): the Shell publishes the page, and the page itself what is open in it (the tasks
 * view and its filter count, the open board, the open insight). One store per project
 * instance (keyed by its bus), so one project's page never reaches another's chip.
 */
export type PageContext =
  | { page: 'tasks'; view?: string; filters?: number }
  | { page: 'whiteboards'; board?: string }
  | { page: 'lab'; insight?: string }
  | { page: Exclude<Page, 'tasks' | 'whiteboards' | 'lab'> };

type Patch = Partial<Omit<PageContextRef, 'page'>> & { page: Page };

interface Store {
  page: Page | null;
  /** What each publisher said, by its own key; only the patches for the shown page count. */
  patches: Map<string, Patch>;
  snapshot: PageContext | null;
  listeners: Set<() => void>;
}

const stores = new WeakMap<EventTarget, Store>();

function storeOf(bus: EventTarget): Store {
  let s = stores.get(bus);
  if (!s) {
    s = { page: null, patches: new Map(), snapshot: null, listeners: new Set() };
    stores.set(bus, s);
  }
  return s;
}

function recompute(s: Store): void {
  let next: PageContext | null = null;
  if (s.page) {
    const out: Record<string, unknown> = { page: s.page };
    for (const p of s.patches.values()) {
      if (p.page !== s.page) continue;
      for (const [k, v] of Object.entries(p)) if (k !== 'page' && v !== undefined) out[k] = v;
    }
    next = out as PageContext;
  }
  if (JSON.stringify(next) === JSON.stringify(s.snapshot)) return;
  s.snapshot = next;
  for (const l of s.listeners) l();
}

/** The Shell: which page is open (null when it unmounts). */
export function publishPage(bus: EventTarget, page: Page | null): void {
  const s = storeOf(bus);
  s.page = page;
  recompute(s);
}

/** A page's own detail under a publisher key; null withdraws it (the publisher's effect cleanup). */
export function publishPageDetail(bus: EventTarget, key: string, patch: Patch | null): void {
  const s = storeOf(bus);
  if (patch) s.patches.set(key, patch);
  else s.patches.delete(key);
  recompute(s);
}

export function readPageContext(bus: EventTarget): PageContext | null {
  return storeOf(bus).snapshot;
}

export function usePageContext(bus: EventTarget): PageContext | null {
  // Stable per bus: a new subscribe each render would unsubscribe and resubscribe every time.
  const subscribe = useCallback((cb: () => void) => {
    const s = storeOf(bus);
    s.listeners.add(cb);
    return () => { s.listeners.delete(cb); };
  }, [bus]);
  return useSyncExternalStore(subscribe, () => storeOf(bus).snapshot);
}

/** The wire block for a page context ('' for none). */
export function pageBlockOf(ctx: PageContext | null): string {
  return ctx ? pageContextBlock(ctx as PageContextRef) : '';
}

/** A stable key for "the page changed" (the chip comes back on the next page change). */
export function pageKeyOf(ctx: PageContext | null): string {
  return pageBlockOf(ctx);
}

/** What the chip and the sent strip read: the page's name, then the open item ("Tasks · Current
 *  Version", "Whiteboard · launch-plan"). `labelOf` is the sidebar's name for a page. */
export function pageChipName(ref: PageContextRef, labelOf: (page: string) => string): string {
  const item = ref.view ?? ref.board ?? ref.insight;
  const name = labelOf(ref.page) || ref.page;
  return item ? `${name} · ${item}` : name;
}
