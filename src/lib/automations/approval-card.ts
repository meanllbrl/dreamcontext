import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkApproval } from './registry.js';
import { placement } from '../agents/active.js';
import { dispatcherPlistPath } from './launchd.js';
import { cadenceLabel, readAutomationCache } from './store.js';
import { upcomingFire } from './schedule.js';
import { storeServers } from '../mcp-store.js';
import type { AutomationCache, AutomationManifest, ReviewMode } from './types.js';

/**
 * The owner's approval CARD for an automation an agent or the Super Agent set up (owner
 * 2026-11-01: "onay sohbette kart olarak gelsin"). An automation such a session creates is not
 * approved by creating it (`createNeedsOwner`); before this card, the only door was the AI Team
 * page, so the owner learnt it was not running only when the Super Agent told him.
 *
 * The card is DERIVED, never authored: the agent names the slug in a `dream-view` block and the
 * app asks the server for these facts, so what the owner approves is what the manifest says,
 * not what the agent wrote about it. CLI and server read the same function.
 *
 * Honest about capability, not intent: a scheduled run is spawned with `bypassPermissions`
 * (runner.ts `buildClaudeArgs`), or inside its home board's envelope. On Codex it runs in
 * Codex's sandbox (`auto`: the project and linked repos, no network); on Antigravity, which has
 * no OS sandbox, it has Claude's reach behind the write gate (headless-envelope.ts). Whether its prompt only
 * reads is the prompt's claim, so the card says what the run CAN do and shows the prompt's
 * opening words beside it; the owner judges the two together.
 */

/** The `dream-view` type the card is drawn from. */
export const APPROVAL_CARD_TYPE = 'automation';

/** How much of the prompt (or job) the card quotes. */
export const DOES_MAX_CHARS = 280;

/** The scaffold `create` writes when no prompt was given: nothing to quote. */
const PROMPT_PLACEHOLDER_RE = /^\(What should this automation do\?/;

export interface ApprovalCardFacts {
  slug: string;
  title: string;
  /** The agent it runs as, when that is not the automation itself. */
  agentTitle: string | null;
  /** The opening words of what the run is told to do ('' when nothing is written yet). */
  does: string;
  /** `cadenceLabel`: the same words `list`, `show` and the AI Team card use. */
  cadence: string;
  mode: 'sched' | 'call';
  /** No schedule kind ends on a date: it runs until it is turned off or removed. */
  until: 'until-turned-off' | 'only-when-called';
  /** `computer`: every tool on this Mac, without asking (Claude, and Antigravity, which has no
   *  OS sandbox); `project`: Codex's sandbox, the project and its linked repos with no network;
   *  `board`: only its home board. */
  reach: 'computer' | 'project' | 'board';
  /** The tool the run goes out on. */
  tool: 'claude' | 'codex' | 'antigravity';
  board: string | null;
  /** The MCP servers the run is handed (none on a board). */
  mcp: string[];
  /** Whether a human verdict stands between the run's OUTPUT and its publishing. It gates the
   *  output document, never the tools: a run under review can still change files. */
  review: ReviewMode;
  approved: boolean;
  approvalReason: string | null;
  enabled: boolean;
  nextFireAt: string | null;
}

/** The first meaningful lines of a prompt: no headings, no comments, no placeholder. */
export function doesLine(text: string): string {
  const lines = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    // A heading names a section; the words under it say what the run does.
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, '').trim())
    .filter((l) => l && !PROMPT_PLACEHOLDER_RE.test(l));
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > DOES_MAX_CHARS ? `${joined.slice(0, DOES_MAX_CHARS - 1).trimEnd()}…` : joined;
}

/**
 * Every surface's "next run" (cards, the routines list, the CLI): a fire still owed (time passed,
 * the dispatcher not there yet, or the run in flight) before the next one on the clock
 * (`upcomingFire`). Reads this machine's run cache and approval; both failing reads fall back
 * to the clock.
 */
export function nextFireIso(
  m: AutomationManifest,
  now: Date = new Date(),
  where: { projectRoot: string; home?: string } | null = null,
): string | null {
  if (m.mode === 'call' || !m.enabled || m.schedule === null) return null;
  let lastFireAt: string | null = null;
  let approved = false;
  if (where) {
    try { lastFireAt = readAutomationCache(join(where.projectRoot, '_dream_context'), m.slug)?.lastFireAt ?? null; } catch { lastFireAt = null; }
    // Owed only where it runs: the tick skips a routine whose agent lives on another machine
    // (`runs-elsewhere`), and this machine's cache never learns that machine ran it.
    try {
      const contextRoot = join(where.projectRoot, '_dream_context');
      approved = checkApproval(where.projectRoot, m, where.home, 'run').approved
        && placement(contextRoot, m.agent || m.slug, m.owner ?? null, where.home, now).here;
    } catch { approved = false; }
  }
  return upcomingFire(m.schedule, lastFireAt, now, m.catchupHours, m.mode, approved)?.toISOString() ?? null;
}

export function approvalCardFacts(
  projectRoot: string,
  m: AutomationManifest,
  opts: { now?: Date; home?: string; mcp?: (projectRoot: string) => string[] } = {},
): ApprovalCardFacts {
  const approval = checkApproval(projectRoot, m, opts.home, 'run');
  const onBoard = !!m.whiteboard;
  const mcpOf = opts.mcp ?? ((root: string) => {
    try { return [...storeServers(root, opts.home).keys()].sort(); } catch { return []; }
  });
  const bound = !!m.agent && m.agent !== m.slug;
  return {
    slug: m.slug,
    title: m.title,
    agentTitle: bound ? (m.agentTitle || m.agent) : null,
    // A job bound to an agent says what THIS automation asks; the agent's own prompt is who it is.
    does: doesLine(bound && m.job.trim() ? m.job : m.prompt),
    cadence: cadenceLabel(m),
    mode: m.mode,
    until: m.mode === 'call' ? 'only-when-called' : 'until-turned-off',
    reach: onBoard ? 'board' : m.tool === 'codex' ? 'project' : 'computer',
    tool: m.tool ?? 'claude',
    board: m.whiteboard ?? null,
    mcp: onBoard ? [] : mcpOf(projectRoot),
    review: m.review,
    approved: approval.approved,
    approvalReason: approval.approved ? null : approval.reason,
    enabled: m.enabled,
    nextFireAt: nextFireIso(m, opts.now, { projectRoot, home: opts.home }),
  };
}

/** The block an agent writes to put the card in the owner's chat. One line of JSON. */
export function approvalCardBlock(slug: string): string {
  return ['```dream-view', JSON.stringify({ type: APPROVAL_CARD_TYPE, slug }), '```'].join('\n');
}

/** The prefix every approval refusal of the runner starts with (`runner.ts`). */
const APPROVAL_BLOCK_RE = /^not approved \(/;

/**
 * A run REFUSED for want of approval, read after the owner approved: history, not the current
 * state. `show` and the AI Team card printed it as the error of an approved automation
 * (owner 2026-11-01). True only while nothing has run since: the next attempt replaces it.
 */
export function staleApprovalBlock(cache: Pick<AutomationCache, 'status' | 'error'> | null, approvedNow: boolean): boolean {
  return !!cache && approvedNow && cache.status === 'blocked' && typeof cache.error === 'string' && APPROVAL_BLOCK_RE.test(cache.error);
}

/**
 * Is there a scheduler on this Mac to fire an approved automation? macOS only: the launchd
 * dispatcher's plist. Elsewhere unknown, so not reported missing (a line that says "will not
 * fire" must be true).
 */
export function schedulerInstalled(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin') return true;
  try { return existsSync(dispatcherPlistPath()); } catch { return true; }
}
