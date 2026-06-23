import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface Version {
  id: string;
  version: string;
  date: string;
  summary: string;
  status: 'planning' | 'released';
  breaking: boolean;
  features: string[];
  tasks: string[];
}

interface ReleasesResponse {
  entries: Version[];
}

interface ReleaseResponse {
  release: Version;
}

export function useVersions() {
  return useQuery({
    queryKey: ['releases'],
    queryFn: () => api.get<ReleasesResponse>('/releases'),
    select: (data) => data.entries.map(e => ({
      ...e,
      status: e.status ?? 'released',
    })),
  });
}

export function usePlanningVersions() {
  return useQuery({
    queryKey: ['releases'],
    queryFn: () => api.get<ReleasesResponse>('/releases'),
    select: (data) => data.entries
      .map(e => ({ ...e, status: (e.status ?? 'released') as Version['status'] }))
      .filter(e => e.status === 'planning'),
  });
}

export function useCreateVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { version: string; summary?: string }) =>
      api.post<ReleaseResponse>('/releases', { ...input, status: 'planning' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
  });
}

export function useUpdateVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ version, updates }: { version: string; updates: { status?: string; summary?: string } }) =>
      api.patch<ReleaseResponse>(`/releases/${encodeURIComponent(version)}`, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
  });
}

interface ActiveVersionResponse {
  active: string | null;
}

/** The active planning version ("current sprint"), or null if none is set. */
export function useActiveVersion() {
  return useQuery({
    queryKey: ['releases', 'active'],
    queryFn: () => api.get<ActiveVersionResponse>('/releases/active'),
    select: (data) => data.active,
  });
}

/**
 * Set or clear the active planning version. Passing a version that has no
 * RELEASES.json entry lazily creates a planning entry server-side; passing null
 * clears the active version. Invalidating ['releases'] also refreshes
 * ['releases','active'] (prefix match).
 */
export function useSetActiveVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: string | null) =>
      api.put<ActiveVersionResponse>('/releases/active', { version }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
  });
}

/**
 * Mark a version "completed" (released). If the version already exists in
 * RELEASES.json it is promoted via PATCH; an unregistered sprint name is created
 * directly as released. The release date defaults to today server-side.
 */
export function useCompleteVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ version, exists }: { version: string; exists: boolean }) =>
      exists
        ? api.patch<ReleaseResponse>(`/releases/${encodeURIComponent(version)}`, { status: 'released' })
        : api.post<ReleaseResponse>('/releases', { version, status: 'released' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
  });
}
