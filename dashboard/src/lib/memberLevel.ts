import type { AgentAutonomy } from '../hooks/useAgents';

/**
 * The level a member shows and is edited at (owner 2026-11-18: no member runs in Ask). Free stays
 * Free; anything else, an old stored `ask` or no level, is Balanced. Mirrors `memberLevel` in
 * src/lib/automations/types.ts, which every spawn path reads through.
 */
export function memberLevel(level: string | null | undefined): AgentAutonomy {
  return level === 'free' ? 'free' : 'balanced';
}
