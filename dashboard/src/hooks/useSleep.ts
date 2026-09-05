import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import type { SleepThresholds as SleepThresholdsPayload } from './sleepLevels';

interface SessionRecord {
  session_id: string;
  transcript_path: string | null;
  stopped_at: string | null;
  last_assistant_message: string | null;
  change_count: number | null;
  tool_count: number | null;
  score: number | null;
}

interface FieldChange {
  field: string;
  from: string | number | boolean | string[] | null;
  to: string | number | boolean | string[] | null;
}

interface DashboardChange {
  timestamp: string;
  entity: string;
  action: string;
  target: string;
  field?: string;
  fields?: FieldChange[];
  summary: string;
}

interface Bookmark {
  id: string;
  text: string;
  salience: number;
  session_id: string | null;
  created_at: string;
}

/** Mirrors `recall_mode` in `_dream_context/state/.sleep.json` (default 'haiku'). */
export type RecallMode = 'haiku' | 'raw' | 'hybrid' | 'off';

export interface SleepState {
  /** The exact persisted ledger — the sum of finalized session scores. */
  debt: number;
  /**
   * persisted + provisional. Sessions whose transcript Claude Code has not
   * flushed yet score `null` and add nothing to `debt`, so the raw ledger
   * under-reads real work for hours. The server derives this the same way the
   * CLI's consolidation directives do — display and level on it, not on `debt`.
   * Optional so an older server (or a cached response) degrades to `debt`.
   */
  effective_debt?: number;
  /** The estimated slice of `effective_debt` from sessions awaiting analysis. */
  provisional_debt?: number;
  /** How many sessions that estimate covers. */
  pending_sessions?: number;
  last_sleep: string | null;
  last_sleep_summary: string | null;
  sleep_started_at: string | null;
  sessions_since_last_sleep?: number;
  sessions: SessionRecord[];
  bookmarks?: Bookmark[];
  dashboard_changes: DashboardChange[];
  recall_mode?: RecallMode;
  /** The brain's RESOLVED debt ladder from the server. Optional so an older
   *  server (or a cached response) degrades to the shipped defaults. */
  thresholds?: SleepThresholdsPayload;
}

export type { Bookmark, SessionRecord, DashboardChange };

// Debt thresholds and the level ladder live in `./sleepLevels` — a pure module
// with no React/network imports, so the drift test can import and exercise it
// (including the DYNAMIC path) instead of parsing it as text. Re-exported here
// because every existing consumer imports them from this hook.
export {
  DEFAULT_DEBT_DROWSY,
  DEFAULT_DEBT_SLEEPY,
  DEFAULT_DEBT_MUST_SLEEP,
  DEFAULT_SLEEP_THRESHOLDS,
  sleepThresholds,
  sleepDebtMax,
  getSleepLevel,
  getSleepLevelKey,
  getSleepMood,
  sleepRangeLabels,
} from './sleepLevels';
export type { SleepThresholds } from './sleepLevels';

/**
 * The debt value every surface should SHOW and level on: the server's effective
 * debt (persisted + provisional) when present, falling back to the raw ledger.
 * Reading `sleep.debt` directly makes the UI under-read whenever a session's
 * transcript hasn't flushed yet, while the terminal already warns.
 */
export function displayDebt(sleep: Pick<SleepState, 'debt' | 'effective_debt'>): number {
  return Math.max(0, sleep.effective_debt ?? sleep.debt);
}

export function useSleep() {
  const api = useApi();
  return useQuery({
    queryKey: ['sleep'],
    queryFn: () => api.get<SleepState>('/sleep'),
  });
}

/**
 * The vault's effective recall mode (default 'haiku'), shared by the search
 * surfaces so they can reflect it — notably: when it's 'hybrid', search runs
 * BM25+dense locally and the Haiku "Intelligent" toggle is redundant (hidden).
 */
export function useRecallMode(): RecallMode {
  const { data } = useSleep();
  return data?.recall_mode ?? 'haiku';
}

/** PATCH /api/sleep — partial update (recall_mode, manual debt). Returns the fresh state. */
export function useUpdateSleep() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (patch: { recall_mode?: RecallMode; debt?: number }) =>
      api.patch<SleepState>('/sleep', patch),
    onSuccess: (data) => queryClient.setQueryData(['sleep'], data),
  });
}
