import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { initAgentSettingsFromServer, onAgentSettings } from '../lib/agentSettings';
import {
  checksForScope,
  type AgentSettingsLite,
  type CheckScope,
  type FixErrorCode,
  type FixId,
  type FixKind,
  type InstallRunStatus,
  type ReadinessCheck,
  type ReadinessReport,
} from '../lib/onboardingTypes';

/**
 * The onboarding data layer: the machine report, single fix runs, and the "Set everything up"
 * sequencer.
 *
 * Every call goes through the PLAIN `api` client (never `useApi`): the routes are
 * vault-agnostic and these hooks run in the Launcher, which has no project, as well as in a
 * project window's agent setup panel. Nothing here decides WHAT to fix or in which order: the
 * server's `report.plan` is the one source of truth, re-read after every fix.
 */

export const READINESS_QUERY_KEY = ['onboarding-readiness'] as const;
const AGENT_SETTINGS_QUERY_KEY = ['onboarding-agent-settings'] as const;

/** How often a live run's status is read. */
const RUN_POLL_MS = 1000;
/**
 * How often the report is re-read while something is moving (a fix, or the network is down).
 * These polls ask for a FRESH probe: the server's plain memo lives 5 s, so a cached read could
 * hold "offline" or a finished install on screen for up to 8 s. The server rate-limits fresh
 * probes to one per 2 s and coalesces concurrent ones, so polling at that pace costs at most
 * one probe per window and brings recovery inside ~2 s plus one probe.
 */
const LIVE_REFETCH_MS = 2000;

export function fetchReadiness(fresh = false): Promise<ReadinessReport> {
  return api.get<ReadinessReport>(`/onboarding/readiness${fresh ? '?fresh=1' : ''}`);
}

/** The report must be re-read on its own: a fix is running somewhere, or the machine is offline. */
export function needsLivePoll(report: ReadinessReport | undefined): boolean {
  return !!report && (report.activeFixes.length > 0 || !report.online);
}

/**
 * How the report is polled after `report`: while something is moving it is re-read every
 * {@link LIVE_REFETCH_MS} AND past the server's memo (fresh); otherwise only on demand.
 */
export function readinessPollPlan(report: ReadinessReport | undefined): { fresh: boolean; intervalMs: number | false } {
  const live = needsLivePoll(report);
  return { fresh: live, intervalMs: live ? LIVE_REFETCH_MS : false };
}

/** The check that owns a fix (each check carries at most one `fix`). */
export function checkForFix(report: ReadinessReport | undefined, fix: FixId): ReadinessCheck | undefined {
  return report?.checks.find((c) => c.fix?.id === fix);
}

// ─── The report ───────────────────────────────────────────────────────────────

/**
 * The machine report, filtered to `scope` for display. Refetches on window focus (the person
 * may have finished a macOS dialog or a browser sign-in elsewhere), every 3 s while a fix is
 * active or the machine is offline, and `refresh()` asks the server to probe afresh (call it
 * after a run ends).
 */
export function useReadiness(scope: CheckScope = 'machine') {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: READINESS_QUERY_KEY,
    // While the last report says something is moving, read past the server's memo.
    queryFn: () => fetchReadiness(readinessPollPlan(queryClient.getQueryData<ReadinessReport>(READINESS_QUERY_KEY)).fresh),
    refetchOnWindowFocus: true,
    staleTime: 2000,
    refetchInterval: (q) => readinessPollPlan(q.state.data).intervalMs,
  });
  const refresh = useCallback(async (): Promise<ReadinessReport> => {
    const report = await fetchReadiness(true);
    queryClient.setQueryData(READINESS_QUERY_KEY, report);
    return report;
  }, [queryClient]);
  const report = query.data;
  const checks = useMemo(() => (report ? checksForScope(report, scope) : []), [report, scope]);
  return {
    report,
    checks,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
    refresh,
  };
}

// ─── One fix run ──────────────────────────────────────────────────────────────

/** Why a fix could not even start. `network` is a request that never got an answer. */
export interface FixStartError {
  code: FixErrorCode | 'network' | 'unknown';
  status: number;
  message: string;
  /** 409 `blocked`: the checks that must be fixed first. */
  blockedBy?: string[];
  /** 422 `manual_only`: the command a person can run instead. */
  manual?: string;
}

/**
 * `abandoned`: the component that started or followed the run went away before it settled.
 * The run may still be going on the server; nothing here follows it any more, and no caller
 * may read this as a settle (the sequencer stops on it).
 */
export type FixPhase = 'starting' | 'running' | 'done' | 'error' | 'abandoned';

export interface FixRunState {
  fix: FixId;
  runId: string | null;
  phase: FixPhase;
  /** The last status read from `/api/agent/install/status`. */
  status: InstallRunStatus | null;
  /** Set when the run could not start (phase `error`, no `runId`). */
  startError?: FixStartError;
}

type StartResult = { ok: true; runId: string } | { ok: false; error: FixStartError; runId?: string };

/**
 * `POST /api/onboarding/fix`. A plain `fetch` rather than `api.post`, because the refusals carry
 * fields the generic client drops: a 409 `in_progress` names the run already going (we attach
 * to it instead of failing), a 409 `blocked` names what comes first, a 422 the manual command.
 */
async function postFix(fix: FixId): Promise<StartResult> {
  let res: Response;
  try {
    res = await fetch('/api/onboarding/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fix }),
    });
  } catch (err) {
    return { ok: false, error: { code: 'network', status: 0, message: err instanceof Error ? err.message : String(err) } };
  }
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON answer */ }
  if (res.ok && typeof body.runId === 'string') return { ok: true, runId: body.runId };
  const code = typeof body.error === 'string' ? (body.error as FixErrorCode) : 'unknown';
  const error: FixStartError = {
    code,
    status: res.status,
    message: typeof body.message === 'string' ? body.message : `Request failed: ${res.status}`,
    ...(Array.isArray(body.blockedBy) ? { blockedBy: body.blockedBy.filter((x): x is string => typeof x === 'string') } : {}),
    ...(typeof body.manual === 'string' ? { manual: body.manual } : {}),
  };
  return { ok: false, error, ...(typeof body.runId === 'string' ? { runId: body.runId } : {}) };
}

export function fetchRunStatus(runId: string): Promise<InstallRunStatus> {
  return api.get<InstallRunStatus>(`/agent/install/status?id=${encodeURIComponent(runId)}`);
}

export interface StartOptions {
  /**
   * Resolve as soon as the run is waiting on a macOS window (`awaiting: 'system-dialog'`)
   * instead of at its end. Polling carries on in the background. The Git install uses this so
   * the developer-tools download never holds up the rest of the plan.
   */
  settleOnBackgroundWait?: boolean;
}

/**
 * Start, follow and cancel fix runs, one state per fix. Shared by the checklist rows and the
 * sequencer, so a row started by hand and the same row reached by "Set everything up" are the
 * same run. When a run ends the report is re-probed.
 */
export function useFixRuns() {
  const queryClient = useQueryClient();
  const [runs, setRuns] = useState<Partial<Record<FixId, FixRunState>>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const put = useCallback((state: FixRunState) => {
    if (mounted.current) setRuns((prev) => ({ ...prev, [state.fix]: state }));
  }, []);

  /** Fresh probe into the shared report cache; a failed read falls back to a refetch. */
  const refreshReport = useCallback(async () => {
    try {
      queryClient.setQueryData(READINESS_QUERY_KEY, await fetchReadiness(true));
    } catch {
      void queryClient.invalidateQueries({ queryKey: READINESS_QUERY_KEY });
    }
  }, [queryClient]);
  const afterEnd = refreshReport;

  const follow = useCallback(
    (fix: FixId, runId: string, opts: StartOptions): Promise<FixRunState> =>
      new Promise((resolve) => {
        let settled = false;
        const settle = (s: FixRunState) => { if (!settled) { settled = true; resolve(s); } };
        const tick = async (): Promise<void> => {
          if (!mounted.current) {
            settle({ fix, runId, phase: 'abandoned', status: null });
            return;
          }
          let status: InstallRunStatus;
          try {
            status = await fetchRunStatus(runId);
          } catch {
            window.setTimeout(() => void tick(), RUN_POLL_MS);
            return;
          }
          if (status.state === 'running') {
            const state: FixRunState = { fix, runId, phase: 'running', status };
            put(state);
            if (opts.settleOnBackgroundWait && status.awaiting === 'system-dialog') settle(state);
            window.setTimeout(() => void tick(), RUN_POLL_MS);
            return;
          }
          // `unknown`: the run expired from the server's store before we read its end.
          const state: FixRunState = { fix, runId, phase: status.state === 'done' ? 'done' : 'error', status };
          put(state);
          await afterEnd();
          settle(state);
        };
        void tick();
      }),
    [put, afterEnd],
  );

  const start = useCallback(
    async (fix: FixId, opts: StartOptions = {}): Promise<FixRunState> => {
      put({ fix, runId: null, phase: 'starting', status: null });
      const res = await postFix(fix);
      if (!mounted.current) return { fix, runId: res.ok ? res.runId : null, phase: 'abandoned', status: null };
      const runId = res.ok ? res.runId : res.error.code === 'in_progress' ? res.runId ?? null : null;
      if (!runId) {
        const failed: FixRunState = { fix, runId: null, phase: 'error', status: null, startError: (res as { error: FixStartError }).error };
        put(failed);
        return failed;
      }
      put({ fix, runId, phase: 'running', status: null });
      // The server now counts this fix in `activeFixes`; re-read so every surface reading the
      // report (the Project step's "Git will be set up…" line, the live poll) sees it at once,
      // not after the memo expires. Not awaited: following the run must not wait on a probe.
      void refreshReport();
      return follow(fix, runId, opts);
    },
    [put, follow, refreshReport],
  );

  const cancel = useCallback(async (fix: FixId): Promise<void> => {
    const runId = runs[fix]?.runId;
    if (!runId) return;
    try {
      await api.post<{ ok: true; canceled: boolean }>('/onboarding/fix/cancel', { runId });
    } catch { /* the run's own poll reports where it ended */ }
  }, [runs]);

  return { runs, start, cancel };
}

export type FixRuns = ReturnType<typeof useFixRuns>;

// ─── "Set everything up" ──────────────────────────────────────────────────────

/**
 * Walk the server's `report.plan`, one fix at a time, re-reading the report after each one.
 *
 * - A `system-dialog` fix (the Git install) settles as soon as macOS shows its window and keeps
 *   going in the background; it never blocks the rest.
 * - Browser and device-code fixes run strictly one at a time (one waiting card on screen).
 * - Each fix is tried at most once per pass: a failure is shown on its row, not retried in a loop.
 * - A non-required check can be skipped; skipping the one being waited on cancels its run.
 * - A fix this surface cannot run (`runnable: false`) is left to its row's manual line.
 */
export function useSetEverythingUp(fixRuns: FixRuns, refresh: () => Promise<ReadinessReport>) {
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<FixId | null>(null);
  const [skipped, setSkipped] = useState<ReadonlySet<FixId>>(new Set());
  const skippedRef = useRef<Set<FixId>>(new Set());
  const stopRef = useRef(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const { start, cancel } = fixRuns;

  // Leaving the screen ("Skip for now", closing the Launcher) ends the pass: without this the
  // loop would keep starting installs and sign-ins on the server with no row, card or Cancel.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRef.current = true;
    };
  }, []);

  const run = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    stopRef.current = false;
    setRunning(true);
    try {
      await runPlanSequence({
        refresh,
        start,
        shouldStop: () => stopRef.current,
        skipped: () => skippedRef.current,
        onCurrent: (fix) => { if (mountedRef.current) setCurrent(fix); },
      });
    } catch {
      /* the report could not be read (server gone, offline): rows show their own state */
    } finally {
      if (mountedRef.current) {
        setCurrent(null);
        setRunning(false);
      }
      busyRef.current = false;
    }
  }, [refresh, start]);

  const stop = useCallback(() => { stopRef.current = true; }, []);

  /** Skip a non-required check's fix for this session. Required checks cannot be skipped. */
  const skip = useCallback((fix: FixId, report: ReadinessReport | undefined) => {
    if (checkForFix(report, fix)?.tier === 'required') return;
    skippedRef.current = new Set(skippedRef.current).add(fix);
    setSkipped(skippedRef.current);
    void cancel(fix);
  }, [cancel]);

  return { run, stop, skip, running, current, skipped };
}

export interface PlanSequenceDeps {
  /** Fresh report; the plan is re-read before every step. */
  refresh: () => Promise<ReadinessReport>;
  start: (fix: FixId, opts: StartOptions) => Promise<FixRunState>;
  /** Checked before every step and after every await; true ends the pass at once. */
  shouldStop: () => boolean;
  skipped: () => ReadonlySet<FixId>;
  onCurrent?: (fix: FixId | null) => void;
}

/**
 * One "Set everything up" pass, free of React so it can be tested and reused (the agent-scope
 * checklist can drive its own pass through it with its own `shouldStop`).
 *
 * Ends `stopped` when `shouldStop()` turns true after any await, or when a run comes back
 * `abandoned` (its component unmounted); never starts another fix after either.
 */
export async function runPlanSequence(deps: PlanSequenceDeps): Promise<'done' | 'stopped'> {
  const attempted = new Set<FixId>();
  try {
    for (;;) {
      if (deps.shouldStop()) return 'stopped';
      const report = await deps.refresh();
      if (deps.shouldStop()) return 'stopped';
      const fix = nextPlannedFix(report, attempted, deps.skipped());
      if (!fix) return 'done';
      attempted.add(fix);
      const plan = checkForFix(report, fix)?.fix;
      if (plan && !plan.runnable) continue;
      deps.onCurrent?.(fix);
      const result = await deps.start(fix, { settleOnBackgroundWait: plan?.kind === 'system-dialog' });
      if (result.phase === 'abandoned' || deps.shouldStop()) return 'stopped';
    }
  } finally {
    deps.onCurrent?.(null);
  }
}

/** The first plan entry not yet tried this pass, not skipped, and not already running. */
export function nextPlannedFix(
  report: ReadinessReport,
  attempted: ReadonlySet<FixId>,
  skipped: ReadonlySet<FixId>,
): FixId | null {
  return report.plan.find((f) => !attempted.has(f) && !skipped.has(f) && !report.activeFixes.includes(f)) ?? null;
}

/** The fix kind of a plan entry, for callers that render a step before it starts. */
export function fixKindOf(report: ReadinessReport | undefined, fix: FixId): FixKind | undefined {
  return checkForFix(report, fix)?.fix?.kind;
}

// ─── Agent settings (the hand-off's gate) ────────────────────────────────────

/**
 * The two Settings → Agents fields the hand-off gate needs (`agentCanSpawn`), read the same way
 * the agent surface reads them (`initAgentSettingsFromServer` + `coerceAgentSettings`, so the
 * defaults agree), and kept live when any window changes them.
 */
export function useAgentSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: AGENT_SETTINGS_QUERY_KEY,
    queryFn: async (): Promise<AgentSettingsLite> => {
      const cfg = await initAgentSettingsFromServer();
      return { enabled: cfg.enabled, chatView: cfg.chatView };
    },
    staleTime: Infinity,
  });
  useEffect(
    () => onAgentSettings((cfg) => {
      queryClient.setQueryData<AgentSettingsLite>(AGENT_SETTINGS_QUERY_KEY, { enabled: cfg.enabled, chatView: cfg.chatView });
    }),
    [queryClient],
  );
  return { settings: query.data, isLoading: query.isLoading };
}
