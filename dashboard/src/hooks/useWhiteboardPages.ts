import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import type { PageKind } from '../lib/whiteboardWidgets';

/** One page a board can point at: `GET /api/whiteboards/pages` (src/lib/whiteboards/pages.ts). */
export interface WhiteboardPageHit {
  /** What goes in a page widget's `ref`: a knowledge slug or a project-relative path. */
  ref: string;
  kind: PageKind;
  source: 'knowledge' | 'file';
  title: string;
  /** Project-relative path of the file. */
  path: string;
}

export interface WhiteboardPagesResponse {
  pages: WhiteboardPageHit[];
  truncated: boolean;
}

const DEBOUNCE_MS = 150;

/**
 * Search the project's pages (knowledge + .md / .pdf / .html files) for the board's page
 * picker. The query is debounced, and the previous results stay up while the next ones load,
 * so the list does not flash empty on every keystroke.
 */
export function useWhiteboardPages(query: string, opts: { limit?: number; kind?: PageKind } = {}) {
  const api = useApi();
  const [q, setQ] = useState(query.trim());
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);
  const { limit = 60, kind } = opts;
  return useQuery({
    queryKey: ['whiteboard-pages', q, limit, kind ?? ''],
    queryFn: () => {
      const params = new URLSearchParams({ q, limit: String(limit) });
      if (kind) params.set('kind', kind);
      return api.get<WhiteboardPagesResponse>(`/whiteboards/pages?${params.toString()}`);
    },
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}
