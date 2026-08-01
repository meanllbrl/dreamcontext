import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

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
}

export type { Bookmark, SessionRecord, DashboardChange };

// Debt thresholds — MUST mirror the canonical source of truth in
// src/lib/sleep-consolidation.ts (DEBT_DROWSY / DEBT_SLEEPY / DEBT_MUST_SLEEP).
// This is a hand-copied mirror because the dashboard is a separate Vite package
// with no import path into the CLI's src/; tests/unit/dashboard-sleep-thresholds
// .test.ts parses this file and fails the build if it drifts from the backend
// again (it silently did, twice: through the 2026-06-29 ×2 rescale and again
// through the 2026-07-29 weighted-scorer rescale that landed these values).
//
// Alert 0–23 · Drowsy 24–39 · Sleepy 40–59 · Must Sleep 60+.
export const DEBT_DROWSY = 24;
export const DEBT_SLEEPY = 40;
export const DEBT_MUST_SLEEP = 60;

/** Debt value at which the bar reads "full" — a consolidation is required. */
export const SLEEP_DEBT_MAX = DEBT_MUST_SLEEP;

export function getSleepLevel(debt: number): string {
  if (debt < DEBT_DROWSY) return 'Alert';
  if (debt < DEBT_SLEEPY) return 'Drowsy';
  if (debt < DEBT_MUST_SLEEP) return 'Sleepy';
  return 'Must Sleep';
}

export function getSleepLevelKey(debt: number): string {
  if (debt < DEBT_DROWSY) return 'alert';
  if (debt < DEBT_SLEEPY) return 'drowsy';
  if (debt < DEBT_MUST_SLEEP) return 'sleepy';
  return 'must_sleep';
}

/**
 * Map sleep debt onto the Sleepy mascot's three moods, so the companion's face
 * mirrors how rested the project's memory is: wide awake while debt is low, lids
 * dropping as it climbs, fully asleep once a consolidation is overdue.
 */
export function getSleepMood(debt: number): 'idle' | 'sleepy' | 'sleeps' {
  if (debt < DEBT_SLEEPY) return 'idle';
  if (debt < DEBT_MUST_SLEEP) return 'sleepy';
  return 'sleeps';
}

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
  return useMutation({
    mutationFn: (patch: { recall_mode?: RecallMode; debt?: number }) =>
      api.patch<SleepState>('/sleep', patch),
    onSuccess: (data) => queryClient.setQueryData(['sleep'], data),
  });
}
