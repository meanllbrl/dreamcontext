import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';

/**
 * useAutoSleep — this machine's background-consolidation switch and its job.
 *
 * MACHINE-LOCAL, unlike everything else in Settings › Sleep: it lives in
 * `.brain-local.json`, never `.config.json`. A synced "yes, sleep for me" would
 * start unattended headless cycles on every teammate's laptop.
 */

export type AutoSleepTrigger = 'must-sleep' | 'sleepy';
export type AutoSleepJobStatus = 'running' | 'ok' | 'failed' | 'timeout' | 'cancelled' | 'aborted';

export interface AutoSleepJob {
  pid: number;
  pgid: number;
  startedAt: string;
  status: AutoSleepJobStatus;
  heartbeatAt?: string;
  summary?: string | null;
  error?: string | null;
  finishedAt?: string | null;
}

export interface AutoSleepState {
  enabled: boolean;
  trigger: AutoSleepTrigger;
  approvedAt: string | null;
  /**
   * Enabled, but PAUSED: the settings changed since they were approved. Reported
   * separately from `enabled` because the two look identical from the toggle
   * alone, and "it says ON but nothing runs" is the worst state to be quiet about.
   */
  consentStale: boolean;
  job: AutoSleepJob | null;
  /** The recorded job's pid is actually alive right now. */
  jobLive: boolean;
}

/** Poll while a job could be running — the automation-job card cadence. */
const POLL_MS = 10_000;

export function useAutoSleep() {
  const api = useApi();
  return useQuery({
    queryKey: ['sleep-auto'],
    queryFn: () => api.get<AutoSleepState>('/sleep/auto'),
    refetchInterval: (query) => (query.state.data?.jobLive ? POLL_MS : false),
  });
}

export function useSetAutoSleep() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { enabled: boolean; trigger?: AutoSleepTrigger }) =>
      api.put<AutoSleepState>('/sleep/auto', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sleep-auto'] });
      // Turning it on silences every sleep directive, so the tracker's own view
      // of "should I offer a sleep?" changes with it.
      qc.invalidateQueries({ queryKey: ['sleep'] });
    },
  });
}

export function useCancelAutoSleep() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ cancelled: boolean }>('/sleep/auto/cancel', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sleep-auto'] }),
  });
}
