import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import { pollMs } from '../lib/windowActivity';

/** Mirrors the cloud-recall types in src/lib/recall-cloud-config.ts. */
export type CloudTier = 'cloud-index' | 'cloud';
export type RecallTier = 'local' | CloudTier;
export type RerankModel = 'voyageai/rerank-2.5' | 'voyageai/rerank-2.5-lite';

export interface CloudRecallPlan {
  toEmbed: number;
  total: number;
  estTokens: number;
  estUsd: number;
}

/**
 * `GET /api/recall/cloud/status`. The key is a boolean plus where it lives — there is no route by
 * which the key itself travels back to the page. `disclosure` is the text the CLI shows too; its
 * `version` is what a consent must quote.
 */
export interface CloudRecallStatus {
  key: boolean;
  keySource: 'file' | 'env' | null;
  keyOrigin: 'manual' | 'voice-copy' | 'env-copy' | null;
  voiceKeyAvailable: boolean;
  tier: RecallTier;
  consent: 'none' | 'valid' | 're-consent-required';
  consentedAt: string | null;
  consentSurface: 'cli-tty' | 'dashboard' | null;
  rerankModel: RerankModel | null;
  defaultRerankModel: RerankModel | null;
  spend: {
    maxIndexUsd: number;
    maxQueriesPerDay: number;
    vaultLifetimeUsd: number;
    todayQueries: number;
  };
  churnGuard: boolean;
  indexReady: boolean;
  indexCoverage: { coveredDocs: number; eligibleTotal: number } | null;
  plan: CloudRecallPlan | null;
  disclosure: { version: number; lines: Record<CloudTier, string[]> } | null;
}

export type CloudIndexState = 'not_built' | 'building' | 'ready' | 'error';

/** `GET /api/recall/cloud/index/status`. `error` is a machine code, never a message. */
export interface CloudIndexStatus {
  state: CloudIndexState;
  progress: number;
  done: number;
  total: number;
  spentUsd: number;
  error: string | null;
  coverage: { coveredDocs: number; eligibleTotal: number } | null;
}

export interface EnableCloudRecall {
  tier: CloudTier;
  rerankModel: RerankModel | null;
  disclosureVersion: number;
}

const STATUS_KEY = ['recall-cloud-status'] as const;
const INDEX_KEY = ['recall-cloud-index-status'] as const;

/** The card's status. Never retried: a 403 means "not the dashboard on this computer" and is final. */
export function useCloudRecallStatus() {
  const api = useApi();
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => api.get<CloudRecallStatus>('/recall/cloud/status'),
    retry: false,
  });
}

/** This vault's cloud index build, polled every 1.5 s only while one is running. */
export function useCloudIndexStatus(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: INDEX_KEY,
    queryFn: () => api.get<CloudIndexStatus>('/recall/cloud/index/status'),
    enabled,
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === 'building' ? pollMs(1_500) : false),
  });
}

/** Every mutation answers with the fresh status, which seeds the cache so the card never lags a click. */
function useStatusMutation<V>(path: string, body: (v: V) => unknown) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: V) => api.post<CloudRecallStatus & { ok: boolean }>(path, body(v)),
    onSuccess: (data) => queryClient.setQueryData(STATUS_KEY, data),
  });
}

/** Store a pasted key. The key is sent once and held nowhere on the page afterwards. */
export function useSetCloudKey() {
  return useStatusMutation<string>('/recall/cloud/key', (key) => ({ key }));
}

/** Copy the Voice key into recall. The caller asks in an in-app confirm first. */
export function useCopyVoiceKey() {
  return useStatusMutation<void>('/recall/cloud/key/copy-voice', () => ({ confirmed: true }));
}

/** Grant consent for this vault. Only ever called after the person pressed the button under the disclosure. */
export function useEnableCloudRecall() {
  return useStatusMutation<EnableCloudRecall>('/recall/cloud/enable', (v) => ({
    tier: v.tier,
    rerankModel: v.tier === 'cloud' ? v.rerankModel : null,
    consent: true,
    disclosureVersion: v.disclosureVersion,
  }));
}

export function useDisableCloudRecall() {
  return useStatusMutation<void>('/recall/cloud/disable', () => ({}));
}

/** Build (or update) this vault's cloud index; a press while one runs joins it. */
export function useBuildCloudIndex() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CloudIndexStatus & { ok: boolean }>('/recall/cloud/index', {}),
    onSuccess: (data) => queryClient.setQueryData(INDEX_KEY, data),
  });
}

export const CLOUD_RECALL_QUERY_KEYS = { status: STATUS_KEY, index: INDEX_KEY } as const;
