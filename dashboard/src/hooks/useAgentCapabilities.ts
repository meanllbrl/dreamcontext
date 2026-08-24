import { useQuery } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import type { Capabilities } from '../components/sleepy/agentSession';
import {
  FALLBACK_MODEL_CONFIG, type ModelConfig, type SessionStats, type UsageLimitsResponse,
} from '../lib/agentComposer';
import type { GoalLiveResponse } from '../lib/goalLive';
import type { CouncilLiveResponse } from '../lib/councilLive';

/**
 * Every query below pins its own `refetchInterval` rather than inheriting one. That's
 * load-bearing, not incidental: a backgrounded project's `QueryClient` defaults
 * `refetchInterval` to `false` (`lib/instanceQueryClient.ts`) so idle page data stops
 * polling, but session-stats/goal-live/council-live back a background chip's live badge —
 * they must keep polling while `enabled`, independent of whether the project is the
 * foreground chip. Do not drop their explicit `refetchInterval` in favor of the default.
 */

/**
 * Agent prerequisite probe (`GET /api/agent/capabilities`) — desktop gate + node-pty
 * + claude CLI presence. Shared, cached (react-query dedups with any other reader), and
 * refetched every 30s so a just-installed prerequisite flips to ready without a reload.
 * Used by the header's Sleep tracker to enable/disable "Run sleep agent".
 */
export function useAgentCapabilities() {
  const api = useApi();
  return useQuery({
    queryKey: ['agent-capabilities'],
    queryFn: () => api.get<Capabilities>('/agent/capabilities'),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
}

/**
 * The agent can be spawned in-app only when it's desktop AND the prerequisites of the
 * ACTIVE agent screen are met. The terminal needs node-pty; the Chat view is a headless
 * stream-json bridge with no PTY at all, so `embeddedTerminal` is not its prerequisite —
 * gating on it would grey out "Run sleep agent" on a machine where node-pty failed to
 * build even though chat spawns fine. Mirrors AgentSurface's own `claudeReady`, which is
 * what actually decides whether the spawn goes through.
 */
export function isSleepAgentReady(caps: Capabilities | undefined, chatView = false): boolean {
  if (!(caps?.desktop && caps.claudeCli)) return false;
  return chatView || !!caps.embeddedTerminal;
}

/**
 * Model + effort options the Claude CLI offers, plus the user's CURRENT defaults
 * (`GET /api/agent/model-config`). The options list is static per CLI version, but the
 * defaults track the user's live `/model` / `/effort` choices (persisted to
 * `~/.claude/settings.json`), so we refetch periodically and on window focus rather than
 * caching forever — otherwise the composer freezes at whatever model/effort the app booted
 * with (the old `staleTime: Infinity` bug that pinned it to opus/high). Falls back to a
 * minimal known set if the endpoint isn't reachable (e.g. non-desktop). Consumed by the
 * composer strip's model/effort pickers.
 */
export function useAgentModelConfig() {
  const api = useApi();
  return useQuery({
    queryKey: ['agent-model-config'],
    queryFn: () => api.get<ModelConfig>('/agent/model-config'),
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
    placeholderData: FALLBACK_MODEL_CONFIG,
  });
}

const EMPTY_STATS: SessionStats = { contextTokens: null, contextLimit: null, costUsd: null };

/**
 * A live agent's context-window footprint + API-rate cost estimate
 * (`GET /api/agent/session-stats?claudeId=…`), polled while the session is live so the
 * composer readout tracks the running conversation. Disabled (no polling) for a shell,
 * a dormant tab, or before a claudeId exists. Consumed per pane by {@link AgentComposerBar}.
 */
export function useAgentSessionStats(claudeId: string | undefined, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['agent-session-stats', claudeId],
    queryFn: () => api.get<SessionStats>(`/agent/session-stats?claudeId=${encodeURIComponent(claudeId!)}`),
    enabled: enabled && !!claudeId,
    refetchInterval: enabled ? 5_000 : false,
    staleTime: 4_000,
    retry: false,
    placeholderData: EMPTY_STATS,
  });
}

/** Nothing found — see `usageLimits`: an absent cap draws no bar, never an empty one. */
const NO_USAGE_LIMITS: UsageLimitsResponse = { limits: [], fetchedAtMs: null };

/**
 * The ACCOUNT's 5-hour and weekly caps (`GET /api/agent/usage-limits`), for the composer's
 * usage popover.
 *
 * Deliberately NOT folded into `useAgentSessionStats`, and the difference is the whole
 * design: session-stats is per-conversation and polls every 5s, while these numbers belong
 * to the account, are shared by every pane in every project, and only move as fast as Claude
 * Code refreshes its own cache. Keying by `claudeId` at the 5s cadence would re-read the same
 * file N times a tick for N open panes and learn nothing new.
 *
 * The query key carries no id for exactly that reason: every pane's popover subscribes to ONE
 * cache entry, so concurrent fetches dedupe and the 60s timer is shared rather than
 * per-observer. Falls back to an empty list, which the popover renders as no bars at all.
 */
export function useUsageLimits(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['agent-usage-limits'],
    queryFn: () => api.get<UsageLimitsResponse>('/agent/usage-limits'),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 55_000,
    retry: false,
    placeholderData: NO_USAGE_LIMITS,
  });
}

// ─── The pinned shelf's two reads ────────────────────────────────────────────────────
//
// Both shapes are MIRRORED from the server (`src/server/routes/agent-shelf.ts` for
// TaskProgress, `src/lib/session-facts.ts` for SessionFacts) — the same convention
// `SessionStats` and `UsageLimitsResponse` already follow in `lib/agentComposer.ts`. Change
// one side, change the other; the route's own unit tests pin the server half.

/** Why a run's progress could not simply be reported. Every non-`ok` state carries a
 *  `notice`: the row degrades loudly, never into a blank or a NaN. */
export type TaskProgressState = 'ok' | 'unknown-slug' | 'no-criteria' | 'all-done' | 'unreadable';

/** ONE acceptance criterion. The list is the panel's whole content: a header reading `8/20`
 *  above two rows was the defect (owner, 2026-08-24). */
export interface ProgressCriterion {
  done: boolean;
  text: string;
  /** The `### ` milestone heading this criterion sits under, or null when ungrouped. */
  group: string | null;
}

export interface TaskProgress {
  slug: string;
  state: TaskProgressState;
  /** 0-100 for `ok`/`all-done`; NULL for every degenerate state. */
  percent: number | null;
  done: number;
  total: number;
  /** The first unticked criterion — what is in flight. */
  now: string | null;
  /** The newest task-changelog bullet — what was just done. */
  last: string | null;
  /** EVERY criterion, in document order — `criteria.length === total`. Empty when degenerate. */
  criteria: ProgressCriterion[];
  /** How many criteria the route dropped at its cap. Rendered, never swallowed. */
  truncated: number;
  /** The task file's mtime in ms. The since-last-write clock is derived from this — it is the
   *  one liveness signal that moves whether or not the percent does, so a run that has stalled
   *  looks different from one that is working. */
  updatedAt: number;
  notice: string | null;
}

export interface SessionFacts {
  branch: string | null;
  worktree: boolean;
  mainRoot: string | null;
  /** The worktree's own directory name, when `worktree` is true. With several open at once,
   *  WHICH one is the question the bare marker could not answer. */
  worktreeName: string | null;
  worktreeAllowed: boolean;
  /** False when git is unavailable or this is not a work tree — the shelf then shows no
   *  branch chip at all rather than an empty one. */
  isRepo: boolean;
}

const UNKNOWN_SESSION_FACTS: SessionFacts = {
  branch: null, worktree: false, mainRoot: null, worktreeName: null,
  worktreeAllowed: false, isRepo: false,
};

/**
 * A pinned run's progress, DERIVED FROM DISK (`GET /api/agent/task-progress?slug=…`).
 *
 * Polled at 4s while a progress row is on the shelf, because the whole promise of that row is
 * that it tracks the task file as the run edits it — a frozen number would be the agent prose
 * it replaced, only harder to distrust. `slug` is null whenever no run owns the row, which
 * disables the query outright: an idle shelf costs nothing.
 */
export function useTaskProgress(slug: string | null, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['agent-task-progress', slug],
    queryFn: () => api.get<TaskProgress>(`/agent/task-progress?slug=${encodeURIComponent(slug!)}`),
    enabled: enabled && !!slug,
    refetchInterval: enabled && slug ? 4_000 : false,
    staleTime: 3_000,
    retry: false,
  });
}

/**
 * Which branch/worktree THIS SESSION is working in (`GET /api/agent/session-facts`), for the
 * shelf's resting tag line.
 *
 * 15s, not 4s: a branch changes when a human switches it, or when the agent enters a worktree
 * — both orders of magnitude slower than a task file changes during a run.
 *
 * ── The query key carries the session id, and that is a REVERSAL ──────────────────────
 * It used to carry nothing, on the reasoning that "these facts belong to the CHECKOUT, so
 * every pane in this project subscribes to one cache entry". The premise was wrong: a session
 * does not stay in the checkout it was spawned in. `EnterWorktree` moves it, Develop mode's
 * briefing invites it to, and one shared cache entry cannot describe two panes in two
 * worktrees — it just shows both of them whichever answer arrived last. The dedupe that
 * bought is not worth a fact that is wrong; the server still memoises its `git` calls (12s,
 * under this poll) so concurrent panes on the SAME checkout still cost one fork.
 *
 * A null `sessionId` still asks — the server answers for the project root, which is the
 * pre-move behaviour and the right answer for a pane that has not moved.
 */
export function useSessionFacts(enabled: boolean, sessionId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['agent-session-facts', sessionId ?? ''],
    queryFn: () => api.get<SessionFacts>(
      sessionId ? `/agent/session-facts?session=${encodeURIComponent(sessionId)}` : '/agent/session-facts'),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
    staleTime: 12_000,
    retry: false,
    placeholderData: UNKNOWN_SESSION_FACTS,
  });
}

const GOAL_LIVE_INACTIVE: GoalLiveResponse = { active: false };

/**
 * The vault's goal-skill live run state for THIS pane (`GET /api/agent/goal-live`),
 * polled while a live agent backs the pane. The server scopes by session: a stamped
 * run that belongs to another conversation returns `{active:false}` here, so the
 * panel only ever renders above the orchestrator's own composer. Cheap poll — the
 * server just reads one small JSON file.
 */
export function useAgentGoalLive(claudeId: string | undefined, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['agent-goal-live', claudeId],
    queryFn: () => api.get<GoalLiveResponse>(`/agent/goal-live?claudeId=${encodeURIComponent(claudeId!)}`),
    enabled: enabled && !!claudeId,
    refetchInterval: enabled ? 2_000 : false,
    staleTime: 1_500,
    retry: false,
    placeholderData: GOAL_LIVE_INACTIVE,
  });
}

const COUNCIL_LIVE_INACTIVE: CouncilLiveResponse = { active: false };

/**
 * The vault's council debate live state for THIS pane (`GET /api/agent/council-live`),
 * polled while a live agent backs the pane. Same session scoping as goal-live: a run
 * stamped for another conversation returns `{active:false}` here, so the chamber
 * panel only renders above the orchestrator's own composer. Shared query key → the
 * panel and the dock badge dedupe into one poll per conversation.
 */
export function useAgentCouncilLive(claudeId: string | undefined, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['agent-council-live', claudeId],
    queryFn: () => api.get<CouncilLiveResponse>(`/agent/council-live?claudeId=${encodeURIComponent(claudeId!)}`),
    enabled: enabled && !!claudeId,
    refetchInterval: enabled ? 2_000 : false,
    staleTime: 1_500,
    retry: false,
    placeholderData: COUNCIL_LIVE_INACTIVE,
  });
}
