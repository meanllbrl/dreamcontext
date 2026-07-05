import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Capabilities } from '../components/sleepy/agentSession';

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
