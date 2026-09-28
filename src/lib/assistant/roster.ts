import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listVaults } from '../vaults.js';
import { buildPeerSummary } from '../federation-peer-summary.js';
import { listConnections } from '../connections.js';
import { listChats, activityOf, type ChatEntry } from './chat-registry.js';
import { wrapUntrusted } from './autonomy.js';

/**
 * The ROSTER in the assistant's briefing: every registered project, what it is, what is
 * happening in it, how it is connected, and which chats are live.
 *
 * Every per-vault string is PROJECT-DERIVED (task titles, tags, "what it is" are strings any
 * vault's agent can write), so each is wrapped in `<untrusted-project-output>` and a session
 * whose roster carries any of them starts TAINTED (see autonomy.ts).
 *
 * Capped at {@link ROSTER_CAP}: the roster rides in the system prompt of every turn. Active
 * vaults (a live chat or an active task) get the full block; the rest compress to one line.
 */

export const ROSTER_CAP = 6000;

export interface RosterVault {
  name: string;
  path: string;
  missing: boolean;
  whatItIs: string;
  activeTask: string;
  topTags: string[];
  connections: string[];
  live: { working: number; stale: number; asking: number; idle: number };
}

export interface Roster {
  vaults: RosterVault[];
  /** True when any vault carries a non-empty project-derived field. */
  carriesProjectText: boolean;
}

/** Counted by ACTIVITY (`activityOf`), the same truth as the notch rollup: `working` is a turn
 *  genuinely in flight, a silent one is `stale`. A chat still `starting` has no turn yet, so
 *  it counts as idle here (the roster has no starting bucket, and "working" would be a lie). */
function rollup(chats: ChatEntry[], vault: string, now = Date.now()): RosterVault['live'] {
  const live = { working: 0, stale: 0, asking: 0, idle: 0 };
  for (const c of chats) {
    if (c.vault !== vault) continue;
    const a = activityOf(c, now);
    if (a === 'gone') continue;
    live[a === 'starting' ? 'idle' : a] += 1;
  }
  return live;
}

export function collectRoster(home?: string): Roster {
  const chats = listChats();
  const vaults: RosterVault[] = listVaults(home).map((v) => {
    const root = join(v.path, '_dream_context');
    const missing = !existsSync(root);
    let whatItIs = '';
    let activeTask = '';
    let topTags: string[] = [];
    let connections: string[] = [];
    if (!missing) {
      try {
        const s = buildPeerSummary(root, v.name);
        whatItIs = s.whatItIs;
        activeTask = s.activeTask;
        topTags = s.topTags;
      } catch { /* a broken vault still gets its name line */ }
      try {
        connections = listConnections(root).map((c) => `${c.vault} (${c.direction})`);
      } catch { /* no connections file */ }
    }
    return { name: v.name, path: v.path, missing, whatItIs, activeTask, topTags, connections, live: rollup(chats, v.name) };
  });
  const carriesProjectText = vaults.some((v) => v.whatItIs || v.activeTask || v.topTags.length > 0);
  return { vaults, carriesProjectText };
}

function liveText(l: RosterVault['live']): string {
  const parts = [
    l.working && `${l.working} working`,
    l.stale && `${l.stale} stale (no sign of life for minutes, may be stuck)`,
    l.asking && `${l.asking} asking`,
    l.idle && `${l.idle} idle`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no live chats';
}

/** Render the roster as briefing text, within {@link ROSTER_CAP}. */
export function renderRoster(roster: Roster, cap: number = ROSTER_CAP): string {
  if (roster.vaults.length === 0) {
    return '## Projects\n\nNo projects are registered yet. To add one: `dreamcontext vaults add <path>` for an existing dreamcontext project, or `dreamcontext init` inside a folder to create one.';
  }
  const active = (v: RosterVault) => v.live.working + v.live.stale + v.live.asking + v.live.idle > 0 || !!v.activeTask;
  const full = (v: RosterVault) => [
    `### ${v.name}${v.missing ? ' (folder missing)' : ''}`,
    `- path: ${v.path}`,
    v.whatItIs && `- what it is: ${wrapUntrusted(v.name, v.whatItIs)}`,
    v.activeTask && `- active task: ${wrapUntrusted(v.name, v.activeTask)}`,
    v.topTags.length > 0 && `- tags: ${wrapUntrusted(v.name, v.topTags.join(', '))}`,
    v.connections.length > 0 && `- connected to: ${v.connections.join(', ')}`,
    `- live: ${liveText(v.live)}`,
  ].filter(Boolean).join('\n');
  const line = (v: RosterVault) => `- **${v.name}** — ${v.path}${v.missing ? ' (folder missing)' : ''} · ${liveText(v.live)}`;

  const head = `## Projects (${roster.vaults.length})\n`;
  const blocks: string[] = [];
  let used = head.length;
  const sorted = [...roster.vaults].sort((a, b) => Number(active(b)) - Number(active(a)));
  // Room is always kept for the closing "…and N more" line, so the cap holds with it.
  const TAIL = 90;
  for (const v of sorted) {
    const candidate = active(v) ? full(v) : line(v);
    const fallback = line(v);
    const pick = used + candidate.length + 1 + TAIL <= cap ? candidate : fallback;
    if (used + pick.length + 1 + TAIL > cap) {
      blocks.push(`- …and ${sorted.length - blocks.length} more (run \`dreamcontext assistant projects\`)`);
      break;
    }
    blocks.push(pick);
    used += pick.length + 1;
  }
  return head + blocks.join('\n');
}
