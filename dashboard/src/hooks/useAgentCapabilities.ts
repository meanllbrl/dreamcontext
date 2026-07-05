import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Capabilities } from '../components/sleepy/agentSession';
import { FALLBACK_MODEL_CONFIG, type ModelConfig, type SessionStats } from '../lib/agentComposer';

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
 * Model + effort options the Claude CLI actually offers, plus the user's defaults
 * (`GET /api/agent/model-config`). Static per CLI version, so cached hard; falls back to a
 * minimal known set if the endpoint isn't reachable (e.g. non-desktop). Consumed by the
 * composer strip's model/effort pickers.
 */
export function useAgentModelConfig() {
  return useQuery({
    queryKey: ['agent-model-config'],
    queryFn: () => api.get<ModelConfig>('/agent/model-config'),
    staleTime: Infinity,
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
