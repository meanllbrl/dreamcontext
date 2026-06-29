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

export function getSleepLevel(debt: number): string {
  if (debt <= 3) return 'Alert';
  if (debt <= 6) return 'Drowsy';
  if (debt <= 9) return 'Sleepy';
  return 'Must Sleep';
}

export function getSleepLevelKey(debt: number): string {
  if (debt <= 3) return 'alert';
  if (debt <= 6) return 'drowsy';
  if (debt <= 9) return 'sleepy';
  return 'must_sleep';
}

/**
 * Map sleep debt onto the Sleepy mascot's three moods, so the companion's face
 * mirrors how rested the project's memory is: wide awake while debt is low, lids
 * dropping as it climbs, fully asleep once a consolidation is overdue.
 */
export function getSleepMood(debt: number): 'idle' | 'sleepy' | 'sleeps' {
  if (debt <= 6) return 'idle';
  if (debt <= 9) return 'sleepy';
  return 'sleeps';
}

export function useSleep() {
  return useQuery({
    queryKey: ['sleep'],
    queryFn: () => api.get<SleepState>('/sleep'),
  });
}
