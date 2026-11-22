import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Page } from '../components/layout/Sidebar';

/**
 * The item a page has open (navigation B, C4): a board, a task, a doc, an app. The page publishes
 * it on its instance bus; the Shell adds it to what it reports to the window, so ← → and the
 * project rail can come back to it. A published id is always one its page opens again through
 * `navigate(page, id)`.
 */
export interface OpenItem {
  page: Page;
  id: string;
  label: string | null;
}

interface Store { item: OpenItem | null; listeners: Set<() => void> }
const stores = new WeakMap<EventTarget, Store>();

function storeOf(bus: EventTarget): Store {
  let s = stores.get(bus);
  if (!s) { s = { item: null, listeners: new Set() }; stores.set(bus, s); }
  return s;
}

export function publishOpenItem(bus: EventTarget, item: OpenItem | null): void {
  const s = storeOf(bus);
  const prev = s.item;
  if (prev === item || (prev && item && prev.page === item.page && prev.id === item.id && prev.label === item.label)) return;
  s.item = item;
  for (const l of s.listeners) l();
}

export function readOpenItem(bus: EventTarget): OpenItem | null {
  return storeOf(bus).item;
}

export function useOpenItem(bus: EventTarget): OpenItem | null {
  const subscribe = useCallback((cb: () => void) => {
    const s = storeOf(bus);
    s.listeners.add(cb);
    return () => { s.listeners.delete(cb); };
  }, [bus]);
  return useSyncExternalStore(subscribe, () => storeOf(bus).item);
}

/** The pages that publish an open item (the `usePublishOpenItem` callers; a drift test reads
 *  them). Only on these can a landing be checked against the item it was asked to open. */
export const ITEM_PAGES: readonly Page[] = ['tasks', 'knowledge', 'whiteboards', 'apps'];

/** The item id a landing on `page` can be matched on: none where the page publishes no item,
 *  so a move there is judged by the page alone and never waits out its bound. */
export function matchableItem(page: Page, id: string | null | undefined): string | null {
  return id && ITEM_PAGES.includes(page) ? id : null;
}

/** A page's hook: publish `id` (with its label) while it is open, withdraw it when it closes or
 *  the page goes. Only the publisher's own item is withdrawn. */
export function usePublishOpenItem(bus: EventTarget, page: Page, id: string | null, label: string | null): void {
  useEffect(() => {
    if (!id) return undefined;
    const item: OpenItem = { page, id, label };
    publishOpenItem(bus, item);
    return () => {
      const cur = storeOf(bus).item;
      if (cur && cur.page === page && cur.id === id) publishOpenItem(bus, null);
    };
  }, [bus, page, id, label]);
}

/** An app slug as a focus id carries it (the app-link charset). */
export const APP_SLUG_FOCUS_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** Apps' plain-slug focus once its list is read: open that app, or stay on the list. */
export function appFocusAction(slug: string, listed: readonly string[]): 'open' | 'list' {
  return APP_SLUG_FOCUS_RE.test(slug) && listed.includes(slug) ? 'open' : 'list';
}
