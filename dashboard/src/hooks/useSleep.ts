import { useQuery } from '@tanstack/react-query';
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

export interface SleepState {
  debt: number;
  last_sleep: string | null;
  last_sleep_summary: string | null;
  sleep_started_at: string | null;
  sessions_since_last_sleep?: number;
  sessions: SessionRecord[];
  bookmarks?: Bookmark[];
  dashboard_changes: DashboardChange[];
}

export type { Bookmark, SessionRecord, DashboardChange };

// Debt thresholds — MUST mirror the canonical source of truth in
// src/lib/sleep-consolidation.ts (DEBT_DROWSY / DEBT_SLEEPY / DEBT_MUST_SLEEP).
// The backend rescaled ×2 on 2026-06-29 (Alert 0–7 · Drowsy 8–13 · Sleepy 14–19 ·
// Must Sleep 20+); these were left on the old 4/7/10 scale and are now realigned.
export const DEBT_DROWSY = 8;
export const DEBT_SLEEPY = 14;
export const DEBT_MUST_SLEEP = 20;

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

export function useSleep() {
  return useQuery({
    queryKey: ['sleep'],
    queryFn: () => api.get<SleepState>('/sleep'),
  });
}
