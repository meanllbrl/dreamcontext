import { getRunTarget } from '../automations/store.js';
import { memberCallState } from '../agents/team-roster.js';
import { DEFAULT_AGENT_AUTONOMY } from '../automations/types.js';
import { levelPermissionArgs } from '../agents/permission.js';
import { HEADLESS_ENVELOPES } from '../t3-bridge/headless-envelope.js';

/**
 * A member Super's children never run wider than the member (security r8-2). The member's own chat
 * level as a Claude permission mode, and what a bridge tool can do within it.
 */

/** Permission modes, narrowest first. */
export const MODE_RANK: Record<string, number> = { plan: 0, default: 1, auto: 2, bypassPermissions: 3 };

/**
 * One member's own chat level (its Super's mode); a member gone, off, unapproved or not the
 * owner's leaves `default`, the narrowest: a level nobody approved never widens a child.
 */
export function memberLevelMode(contextRoot: string, slug: string): string {
  try {
    if (memberCallState(contextRoot, slug).state !== 'ready') return 'default';
    const target = getRunTarget(contextRoot, slug, 'agent');
    if (target) return levelPermissionArgs(target.autonomy ?? DEFAULT_AGENT_AUTONOMY, 'chat')[1] ?? 'default';
  } catch { /* gone */ }
  return 'default';
}

/** The narrowest of a pane mode and every named member's level (none named: the pane mode). */
export function narrowestMode(paneMode: string, contextRoot: string, slugs: readonly string[]): string {
  let mode = paneMode;
  for (const slug of slugs) {
    const level = memberLevelMode(contextRoot, slug);
    if ((MODE_RANK[level] ?? 1) < (MODE_RANK[mode] ?? 3)) mode = level;
  }
  return mode;
}

/**
 * The bridge mode a member's child may run with on `tool` at Claude mode `mode`, or null when the
 * tool has no mode that narrow (it is refused, never run wider). Codex: `default` (read-only,
 * approvals declined) for ask, else its super-child row (`auto`: workspace-write, approvals
 * declined). Antigravity: its only unattended row (`write`) equals bypass, so only a Free member's
 * child may run there.
 */
export function crewBridgeMode(tool: string, mode: string): string | null {
  const row = HEADLESS_ENVELOPES['super-child'];
  if (tool === 'codex') return (MODE_RANK[mode] ?? 1) <= MODE_RANK.default ? 'default' : (row.codex ?? 'default');
  if (tool === 'antigravity') return mode === 'bypassPermissions' ? (row.codex ?? 'default') : null;
  return null;
}

/** Why `tool` cannot run a member's child at `mode`, or null when it can. */
export function crewToolRefusal(tool: string | undefined, mode: string): string | null {
  if (!tool || tool === 'claude') return null;
  if (crewBridgeMode(tool, mode) !== null) return null;
  return `${tool === 'antigravity' ? 'Antigravity' : tool} has no mode as narrow as this member's level (it would run its children wider than the member): run this child on Claude or Codex`;
}
