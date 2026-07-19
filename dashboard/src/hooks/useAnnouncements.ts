import { useCallback, useEffect, useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  type Announcement,
  ANNOUNCEMENTS_SEEN_STORAGE_KEY,
  parseAnnouncements,
  unreadAnnouncements,
  readSeenIds,
  markAllSeen,
} from '../lib/announcements';

/** Fired whenever markAllRead() runs, so every mounted useAnnouncementInbox()
 *  (Sidebar badge, popup, page) re-reads localStorage and drops in sync — a
 *  plain state setter in one component would never reach the others. */
const ANNOUNCEMENTS_READ_EVENT = 'dreamcontext-announcements-read';

/**
 * Query the hand-authored announcements feed.
 *
 * Raw `fetch`, not `api.get` — `api.get` hard-prefixes `/api`, but this file
 * is a static build asset served at the SPA root (dashboard/public/announcements.json).
 * The static server sends `Cache-Control: immutable, max-age=1y` for non-HTML
 * files, so the request is cache-busted with the build's own version; a new
 * build ships a new query string and the browser is forced to refetch.
 * `staleTime: Infinity` + `refetchInterval: false` override the app-wide 15s
 * poll (App.tsx) — this is a static asset, not live server state.
 */
export function useAnnouncements(): UseQueryResult<Announcement[], Error> {
  return useQuery({
    queryKey: ['announcements'],
    queryFn: async () => {
      try {
        const res = await fetch(`/announcements.json?v=${__DC_VERSION__}`);
        if (!res.ok) return [];
        const raw: unknown = await res.json();
        return parseAnnouncements(raw);
      } catch {
        return [];
      }
    },
    staleTime: Infinity,
    refetchInterval: false,
  });
}

/**
 * Fetch a single announcement board's raw `.excalidraw.md` text so
 * ExcalidrawPreview can render it. Same static-asset contract as
 * useAnnouncements: raw `fetch` (not `api.get`), cache-busted by the build
 * version, and never live-polled. Returns '' (not an error) on any failure so
 * the caller renders a graceful empty state rather than throwing.
 */
export function useAnnouncementBoard(board: string): UseQueryResult<string, Error> {
  return useQuery({
    queryKey: ['announcement-board', board],
    queryFn: async () => {
      try {
        const res = await fetch(`/announcements/${board}?v=${__DC_VERSION__}`);
        if (!res.ok) return '';
        return await res.text();
      } catch {
        return '';
      }
    },
    enabled: !!board,
    staleTime: Infinity,
    refetchInterval: false,
  });
}

export interface AnnouncementInbox {
  all: Announcement[];
  unread: Announcement[];
  loading: boolean;
  markAllRead: () => void;
}

/**
 * The read/unread view over the announcements feed, shared by the Sidebar
 * badge, the on-load popup, and the Announcements page. Each caller mounts
 * its own instance of this hook, so `markAllRead` broadcasts a custom event
 * (same-window) and relies on the `storage` event (cross-window) to keep
 * every instance's seen-id state in sync — see App.tsx's SleepyHotkeyRegistrar
 * for the same cross-window `storage` pattern.
 */
export function useAnnouncementInbox(): AnnouncementInbox {
  const { data, isLoading } = useAnnouncements();
  const all = data ?? [];
  const [seenIds, setSeenIds] = useState<string[]>(() => readSeenIds());

  useEffect(() => {
    const resync = () => setSeenIds(readSeenIds());
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === ANNOUNCEMENTS_SEEN_STORAGE_KEY) resync();
    };
    window.addEventListener(ANNOUNCEMENTS_READ_EVENT, resync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(ANNOUNCEMENTS_READ_EVENT, resync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const markAllRead = useCallback(() => {
    setSeenIds(markAllSeen(all));
    window.dispatchEvent(new CustomEvent(ANNOUNCEMENTS_READ_EVENT));
  }, [all]);

  return {
    all,
    unread: unreadAnnouncements(all, seenIds),
    loading: isLoading,
    markAllRead,
  };
}
