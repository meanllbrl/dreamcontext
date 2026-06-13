import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';

// ─── Types (duplicated client-side — can't import from src/lib) ───────────────

export type DigestEntryKind = 'decision' | 'changelog' | 'knowledge' | 'conflict-note';

export interface DigestOrigin {
  vault: string;
  entryId: string;
  sourceTimestamp: string | null;
}

export interface DigestEntry {
  version: number;
  id: string;
  origin: DigestOrigin;
  kind: DigestEntryKind;
  title: string;
  summary: string;
  recallScore: number;
  links: string[];
}

export interface QuarantinedEntry {
  file: string;
  version: number;
}

interface InboxResponse {
  pending: DigestEntry[];
  consumed: DigestEntry[];
  quarantined: QuarantinedEntry[];
}

export interface PeerDelta {
  vault: string;
  consented: boolean;
  stale: boolean;
  entries: Array<{ title: string; kind: DigestEntryKind; recallScore: number }>;
}

interface SyncPreviewResponse {
  dryRun: true;
  deltas: PeerDelta[];
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** Pending + consumed federation inbox entries (read-only). */
export function useFederationInbox() {
  return useQuery({
    queryKey: ['federation', 'inbox'],
    queryFn: () => api.get<InboxResponse>('/federation/inbox'),
  });
}

/**
 * Preview the outbound sync deltas. The server route is DRY-RUN BY CONSTRUCTION
 * (POST /api/federation/sync computes + returns deltas, writes NOTHING) — this
 * mutation never mutates server state.
 */
export function useSyncPreview() {
  return useMutation({
    mutationFn: () => api.post<SyncPreviewResponse>('/federation/sync', {}),
  });
}
