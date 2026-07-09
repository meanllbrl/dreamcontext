import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Thin react-query layer over `/api/linked-repos/*` (src/server/routes/
 * linked-repos.ts). Each hook maps 1:1 to a route — no business logic here.
 * Mirrors useBrainStatus.ts.
 */

export interface LinkedRepo {
  name: string;
  /** Canonical GitHub URL (the registry key + display value). */
  gitRemoteUrl: string;
  present: boolean;
  path: string | null;
}

const LINKED_REPOS_KEY = ['linked-repos'] as const;

/** Present/missing status for every linked repo — reads local files only, no net/git. */
export function useLinkedRepos() {
  return useQuery({
    queryKey: LINKED_REPOS_KEY,
    queryFn: () => api.get<{ repos: LinkedRepo[] }>('/linked-repos'),
    select: (d) => d.repos,
  });
}

export interface LinkRepoArgs {
  name: string;
  path: string;
  /** Explicit GitHub URL — required when the local repo has no origin. */
  url?: string;
}

/** Bind a local checkout of a linked repo (records name+URL shared, path machine-local). */
export function useLinkRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: LinkRepoArgs) => api.post<{ ok: boolean; repos: LinkedRepo[] }>('/linked-repos/link', args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LINKED_REPOS_KEY }),
  });
}

/** Clone a MISSING linked repo. `confirmed` is the trust gate (the URL is team-writable). */
export function useCloneLinkedRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ ok: boolean; path: string; repos: LinkedRepo[] }>('/linked-repos/clone', { name, confirmed: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LINKED_REPOS_KEY }),
  });
}

/** Unlink a repo — removes the shared config entry; keeps the machine-local path. */
export function useUnlinkRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<{ ok: boolean; repos: LinkedRepo[] }>('/linked-repos/unlink', { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LINKED_REPOS_KEY }),
  });
}
