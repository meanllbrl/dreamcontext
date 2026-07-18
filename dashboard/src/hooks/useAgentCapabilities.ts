import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Capabilities } from '../components/sleepy/agentSession';
import { FALLBACK_MODEL_CONFIG, type ModelConfig, type SessionStats } from '../lib/agentComposer';
import type { GoalLiveResponse } from '../lib/goalLive';

/**
 * Agent prerequisite probe (`GET /api/agent/capabilities`) — desktop gate + node-pty
 * + claude CLI presence. Shared, cached (react-query dedups with any other reader), and
 * refetched every 30s so a just-installed prerequisite flips to ready without a reload.
 * Used by the header's Sleep tracker to enable/disable "Run sleep agent".
 */
export function useAgentCapabilities() {
  return useQuery({
    queryKey: ['agent-capabilities'],
    queryFn: () => api.get<Capabilities>('/agent/capabilities'),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** The agent can be spawned in-app only when it's desktop AND both prerequisites are met. */
export function isSleepAgentReady(caps: Capabilities | undefined): boolean {
  return !!(caps?.desktop && caps.embeddedTerminal && caps.claudeCli);
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

const GOAL_LIVE_INACTIVE: GoalLiveResponse = { active: false };

/**
 * The vault's goal-skill live run state for THIS pane (`GET /api/agent/goal-live`),
 * polled while a live agent backs the pane. The server scopes by session: a stamped
 * run that belongs to another conversation returns `{active:false}` here, so the
 * panel only ever renders above the orchestrator's own composer. Cheap poll — the
 * server just reads one small JSON file.
 */
export function useAgentGoalLive(claudeId: string | undefined, enabled: boolean) {
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
