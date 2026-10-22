import { buildTree, descendantsOf, flattenTree, type TeamTree, type TreeLine } from '../../../../src/lib/agents/tree.js';
import type { AgentSummary } from '../../hooks/useAgents';
import { filterRoster, type TeamRow } from './teamModel';

/**
 * THE AI TEAM AS A TREE — the page's half of the hierarchy. The tree itself (read rules, chain,
 * descendants) is `src/lib/agents/tree.ts`, the one reading the CLI and the server share; this
 * file only adds what the page draws on top of it: the roster's sections, what a folded lead
 * says about its team, and the search that keeps a match's managers in view.
 */

export type TeamPlacement = Pick<AgentSummary, 'slug' | 'reportsTo' | 'team'>;

/** The tree in the roster's own order (needs-you first, then newest activity), so siblings
 *  read in the order the flat list would put them. An agent with no row yet still counts. */
export function teamTreeOf(rows: readonly Pick<TeamRow, 'slug'>[], agents: readonly TeamPlacement[]): TeamTree {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const order = [...rows.map((r) => r.slug), ...agents.map((a) => a.slug).filter((s) => !rows.some((r) => r.slug === s))];
  return buildTree(order.map((slug) => ({
    slug,
    reportsTo: bySlug.get(slug)?.reportsTo ?? null,
    team: bySlug.get(slug)?.team ?? null,
  })));
}

/** One part of the tree list: a lead's whole team under one heading, or every agent that
 *  reports straight to the owner with nobody under it ("Reports to you"). */
export interface TreeSection {
  key: string;
  /** The team's name, the lead's name for a team with no name, or null for "Reports to you". */
  label: string | null;
  /** Agents in it, the lead included. */
  count: number;
  roots: string[];
}

/** Teams first (in the order their leads come), then the lone agents. */
export function treeSections(tree: TeamTree, titleOf: (slug: string) => string): TreeSection[] {
  const teams: TreeSection[] = [];
  const lone: string[] = [];
  for (const r of tree.roots) {
    const n = tree.nodes.get(r)!;
    if (n.children.length === 0) lone.push(r);
    else teams.push({ key: `team:${r}`, label: n.ownTeam ?? titleOf(r), count: 1 + n.descendants, roots: [r] });
  }
  if (lone.length > 0) teams.push({ key: 'you', label: null, count: lone.length, roots: lone });
  return teams;
}

/** What a folded lead says about the people under it. */
export interface TeamRollup {
  reports: number;
  needs: number;
  approval: number;
  working: number;
  paused: number;
}

export function rollupOf(tree: TeamTree, rowOf: (slug: string) => Pick<TeamRow, 'status'> | undefined, slug: string): TeamRollup {
  const out: TeamRollup = { reports: 0, needs: 0, approval: 0, working: 0, paused: 0 };
  for (const s of descendantsOf(tree, slug)) {
    out.reports += 1;
    const st = rowOf(s)?.status;
    if (st === 'needs') out.needs += 1;
    else if (st === 'approval') out.approval += 1;
    else if (st === 'working') out.working += 1;
    else if (st === 'paused') out.paused += 1;
  }
  return out;
}

/**
 * The tree lines a section shows. With a query, only the matches and the managers above them
 * (so a match is never drawn without its line to the top), every fold opened.
 */
export function visibleTreeLines(
  tree: TeamTree,
  rows: readonly TeamRow[],
  collapsed: ReadonlySet<string>,
  roots: readonly string[],
  query: string,
): TreeLine[] {
  if (!query.trim()) return flattenTree(tree, collapsed, roots);
  const keep = new Set<string>();
  for (const r of filterRoster(rows, query)) {
    let cur: string | null = r.slug;
    while (cur !== null && !keep.has(cur)) {
      keep.add(cur);
      cur = tree.nodes.get(cur)?.parent ?? null;
    }
  }
  return flattenTree(tree, new Set(), roots).filter((l) => keep.has(l.slug));
}

// ── How the list is drawn, remembered on this machine ──────────────────────────────────

export type RosterView = 'list' | 'tree';
const ROSTER_VIEW_KEY = 'dreamcontext.aiteam.rosterView';

export function readRosterView(storage: Pick<Storage, 'getItem'> | null): RosterView {
  try {
    return storage?.getItem(ROSTER_VIEW_KEY) === 'tree' ? 'tree' : 'list';
  } catch {
    return 'list';
  }
}

export function writeRosterView(storage: Pick<Storage, 'setItem'> | null, view: RosterView): void {
  try { storage?.setItem(ROSTER_VIEW_KEY, view); } catch { /* private mode: not remembered */ }
}

/** The local storage, or null where there is none (tests, a locked-down webview). */
export function pageStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
