import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/** One entry from core/CHANGELOG.json (newest-first). */
export interface ChangelogEntry {
  date: string;
  type: string;
  scope?: string;
  description: string;
  breaking?: boolean;
  summary: string;
  references?: string[];
}

interface ChangelogResponse {
  entries: ChangelogEntry[];
}

/** Project ship-narrative changelog — written during the RemSleep cycle. */
export function useChangelog() {
  return useQuery({
    queryKey: ['changelog'],
    queryFn: () => api.get<ChangelogResponse>('/changelog'),
  });
}
