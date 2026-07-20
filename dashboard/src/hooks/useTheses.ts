import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Theses (proactive learning layer) — dashboard hooks. Mirrors useObjectives.ts
 * idioms (queryKey/queryFn/retry:0/invalidateQueries-on-success). Wire shapes
 * verified against src/server/routes/theses.ts + src/lib/theses/types.ts —
 * `ThesisView` here mirrors the server's `ThesisView` (ThesisManifest minus
 * path/body, plus the derived confidenceBreakdown).
 */

export const THESIS_STATUSES = ['draft', 'open', 'validated', 'invalidated', 'retired'] as const;
export type ThesisStatus = (typeof THESIS_STATUSES)[number];

export const THESIS_KINDS = ['observational', 'experimental'] as const;
export type ThesisKind = (typeof THESIS_KINDS)[number];

export const EVIDENCE_VERDICTS = ['supports', 'contradicts', 'no-signal'] as const;
export type EvidenceVerdict = (typeof EVIDENCE_VERDICTS)[number];

export const EVIDENCE_SOURCES = ['insight', 'task', 'objective', 'changelog', 'external'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const PREDICTION_STANDINGS = ['untested', 'supported', 'contradicted'] as const;
export type PredictionStanding = (typeof PREDICTION_STANDINGS)[number];

export type ThesisLinkKind = 'insight' | 'objective' | 'task';

export interface Prediction {
  id: string;
  text: string;
  standing: PredictionStanding;
}

/** One discrete, cited observation on a thesis's evidence ledger — chronological, oldest-first. */
export interface EvidenceEvent {
  date: string;
  cycle: number | null;
  source: EvidenceSource;
  ref: string | null;
  verdict: EvidenceVerdict;
  note: string;
  quantitative: boolean;
}

/** One entry in the bounded, per-cycle understanding changelog (body-embedded, LIFO). */
export interface ChangelogEntry {
  cycle: number | null;
  condensed: boolean;
  when: string;
  text: string;
}

/** ws/wc/supports/contradicts/noSignal — powers the "how is this computed?" popover. */
export interface ConfidenceBreakdown {
  confidence: number;
  ws: number;
  wc: number;
  supports: number;
  contradicts: number;
  noSignal: number;
}

/** A thesis as the API renders it — ThesisManifest minus path/body, plus confidenceBreakdown. */
export interface ThesisView {
  slug: string;
  claim: string;
  status: ThesisStatus;
  kind: ThesisKind;
  /** DERIVED from the evidence ledger — never asserted. */
  confidence: number;
  created_by: 'user' | 'sleep-learn';
  predictions: Prediction[];
  evidence: EvidenceEvent[];
  insights: string[];
  objectives: string[];
  related_tasks: string[];
  related_workflows: string[];
  blocked_on_instrumentation: boolean;
  blocked_metric: string | null;
  cycles_checked: number;
  checked_at: string | null;
  promoted_to: string | null;
  created_at: string;
  updated_at: string;
  changelog: ChangelogEntry[];
  confidenceBreakdown: ConfidenceBreakdown;
}

export interface ThesisCandidate {
  claim: string;
  kind: ThesisKind;
  predictions: string[];
}

export interface ThesisCandidates {
  note: string;
  items: ThesisCandidate[];
}

/** GET /api/theses response — the layer's enabled flag rides alongside the list. */
export interface ThesesListResult {
  enabled: boolean;
  theses: ThesisView[];
  candidates: ThesisCandidates | null;
}

/** GET /api/theses/:slug response. */
export interface ThesisShowResult {
  thesis: ThesisView;
  confidence: ConfidenceBreakdown;
  changelog: ChangelogEntry[];
}

export interface CreateThesisInput {
  claim: string;
  kind?: ThesisKind;
  predictions?: string[];
  insights?: string[];
  objectives?: string[];
  related_tasks?: string[];
  open?: boolean;
  created_by?: 'user' | 'sleep-learn';
}

export interface AddEvidenceInput {
  verdict: EvidenceVerdict;
  source: EvidenceSource;
  ref?: string | null;
  note?: string;
  cycle?: number | null;
  quantitative?: boolean;
}

export interface SetStatusInput {
  status: ThesisStatus;
  citations?: number[];
  predictionStandings?: Record<string, PredictionStanding>;
  force?: boolean;
}

/**
 * List every thesis + the layer's enabled flag + staged meeting-note candidates.
 * Works regardless of `learning.enabled` (the flag is surfaced, not enforced) —
 * mirrors the server's "still readable, just hinted" disabled-layer behavior.
 */
export function useTheses() {
  return useQuery({
    queryKey: ['theses'],
    queryFn: () => api.get<ThesesListResult>('/theses'),
    retry: 0,
  });
}

/** One thesis — full manifest + confidence breakdown + parsed changelog. */
export function useThesis(slug: string | null) {
  return useQuery({
    queryKey: ['theses', slug],
    queryFn: () => api.get<ThesisShowResult>(`/theses/${slug}`),
    enabled: slug !== null,
    retry: 0,
  });
}

export function useCreateThesis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateThesisInput) => api.post<{ thesis: ThesisView }>('/theses', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['theses'] });
    },
  });
}

export function useAddEvidence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, input }: { slug: string; input: AddEvidenceInput }) =>
      api.post<{ thesis: ThesisView }>(`/theses/${slug}/evidence`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['theses'] });
    },
  });
}

export function useAddPrediction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, text }: { slug: string; text: string }) =>
      api.post<{ thesis: ThesisView }>(`/theses/${slug}/predictions`, { text }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['theses'] });
    },
  });
}

export function useSetStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, input }: { slug: string; input: SetStatusInput }) =>
      api.post<{ thesis: ThesisView }>(`/theses/${slug}/status`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['theses'] });
    },
  });
}

/** Link a thesis to an insight/objective/task (target must already exist). */
export function useLinkThesis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, kind, target }: { slug: string; kind: ThesisLinkKind; target: string }) =>
      api.post<{ thesis: ThesisView }>(`/theses/${slug}/links`, { kind, slug: target }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['theses'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap'] });
    },
  });
}

export function useUnlinkThesis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, kind, target }: { slug: string; kind: ThesisLinkKind; target: string }) =>
      api.del<{ thesis: ThesisView }>(`/theses/${slug}/links/${kind}/${target}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['theses'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap'] });
    },
  });
}

/** Append a per-cycle understanding-changelog entry (LIFO, store-capped). */
export function useAppendChangelog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, text, cycle, condensed }: { slug: string; text: string; cycle?: number | null; condensed?: boolean }) =>
      api.post<{ thesis: ThesisView }>(`/theses/${slug}/changelog`, { text, cycle, condensed }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['theses'] });
    },
  });
}

/** Record the knowledge doc a validated/invalidated thesis promoted into; optionally retires it. */
export function usePromoteThesis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, knowledgePath, retire }: { slug: string; knowledgePath: string; retire?: boolean }) =>
      api.post<{ thesis: ThesisView }>(`/theses/${slug}/promote`, { knowledgePath, retire }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['theses'] });
    },
  });
}

/** The one-command switch: POST /api/learning/enable or /disable. */
export function useSetLearningEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.post<{ enabled: boolean }>(enabled ? '/learning/enable' : '/learning/disable', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['theses'] });
    },
  });
}
