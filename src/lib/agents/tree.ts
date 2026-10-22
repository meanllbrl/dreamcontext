/**
 * THE TEAM TREE — who an agent reports to, read from two optional frontmatter keys:
 *
 *  - `reports_to: <agent-slug>` — one manager (a tree, never a matrix). Absent ⇒ the agent
 *    reports straight to the owner (a root).
 *  - `team: <label>` — meaningful only on a LEAD (an agent someone reports to); its whole
 *    subtree inherits it, the nearest lead's label winning. There is no team entity: the lead
 *    is the single source of truth.
 *
 * Both are UNHASHED: they shape how the team is drawn and grant nothing, so writing them never
 * re-blocks an approved agent (pattern: a-new-field-in-a-consent-hash). When delegation or
 * escalation ever follows this tree, they must enter the hash through a consent migration.
 *
 * Pure, no I/O: the store validates writes with it, the CLI prints it, and the dashboard (which
 * imports this file directly) draws both the roster tree and the org chart from it, so there is
 * ONE reading of the tree.
 *
 * READ RULES (a file can say anything; the reading never loses an agent):
 *  - a `reports_to` naming nobody here (a deleted agent, a private agent that never arrived on
 *    this machine, itself) ⇒ a root, flagged `missingManager`;
 *  - a cycle ⇒ broken at its member with the smallest slug, which becomes a root flagged
 *    `cycle`; everyone else in it keeps their manager.
 */

/** What the tree reads of one agent. */
export interface TreeMember {
  slug: string;
  reportsTo: string | null;
  team: string | null;
}

export interface TreeNode {
  slug: string;
  /** The manager as drawn: null for a root (including a broken or dangling link). */
  parent: string | null;
  /** 0 for a root. */
  depth: number;
  /** Direct reports, in the order the members were given. */
  children: string[];
  /** Every agent below it, at any depth. */
  descendants: number;
  /** Its own label, read only when it is a lead (has a report). */
  ownTeam: string | null;
  /** The label it sits under: its own as a lead, else the nearest lead ancestor's. */
  team: string | null;
  /** The lead whose label `team` is (itself when it owns it). */
  teamLead: string | null;
  /** `reports_to` names an agent that is not here (nor itself). */
  missingManager: string | null;
  /** It was cut out of a reporting cycle to become a root. */
  cycle: boolean;
}

export interface TeamTree {
  /** Roots, in the order the members were given. */
  roots: string[];
  nodes: Map<string, TreeNode>;
}

/** The longest label a team may carry. */
export const TEAM_LABEL_MAX = 40;

/** A team label as stored, or null for none. Trims; refuses control characters and anything
 *  longer than {@link TEAM_LABEL_MAX}. Throws a plain Error the caller wraps. */
export function normalizeTeamLabel(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = v.trim();
  if (!s || s.toLowerCase() === 'none') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error('A team name is one line of plain text.');
  if ([...s].length > TEAM_LABEL_MAX) throw new Error(`A team name is at most ${TEAM_LABEL_MAX} characters.`);
  return s;
}

/** A label as READ: lenient, never throws; anything unusable reads as none. */
export function readTeamLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    return normalizeTeamLabel(v);
  } catch {
    return null;
  }
}

/**
 * The tree, from members in display order (siblings and roots keep that order). Every member
 * appears exactly once; duplicates of a slug after the first are ignored.
 */
export function buildTree(members: readonly TreeMember[]): TeamTree {
  const bySlug = new Map<string, TreeMember>();
  for (const m of members) if (!bySlug.has(m.slug)) bySlug.set(m.slug, m);
  const order = [...bySlug.keys()];

  // 1. The manager each member asks for, when it exists here and is not itself.
  const parent = new Map<string, string | null>();
  const missing = new Map<string, string | null>();
  for (const slug of order) {
    const want = bySlug.get(slug)!.reportsTo;
    if (want && want !== slug && bySlug.has(want)) {
      parent.set(slug, want);
      missing.set(slug, null);
    } else {
      parent.set(slug, null);
      missing.set(slug, want && want !== slug ? want : null);
    }
  }

  // 2. Break every cycle at its smallest slug. Walk up from each member; a slug met twice on
  //    one walk closes a cycle.
  const cut = new Set<string>();
  const settled = new Set<string>();
  for (const start of order) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | null = start;
    while (cur !== null && !settled.has(cur)) {
      if (onPath.has(cur)) {
        const loop = path.slice(path.indexOf(cur));
        const breakAt = [...loop].sort()[0];
        parent.set(breakAt, null);
        cut.add(breakAt);
        break;
      }
      onPath.add(cur);
      path.push(cur);
      cur = parent.get(cur) ?? null;
    }
    for (const p of path) settled.add(p);
  }

  // 3. Children, roots and depth.
  const nodes = new Map<string, TreeNode>();
  for (const slug of order) {
    nodes.set(slug, {
      slug,
      parent: parent.get(slug) ?? null,
      depth: 0,
      children: [],
      descendants: 0,
      ownTeam: null,
      team: null,
      teamLead: null,
      missingManager: missing.get(slug) ?? null,
      cycle: cut.has(slug),
    });
  }
  const roots: string[] = [];
  for (const slug of order) {
    const p = nodes.get(slug)!.parent;
    if (p === null) roots.push(slug);
    else nodes.get(p)!.children.push(slug);
  }

  // 4. Depth-first from the roots: depth, inherited team, descendant counts.
  const visit = (slug: string, depth: number, inherited: { team: string; lead: string } | null): number => {
    const n = nodes.get(slug)!;
    n.depth = depth;
    n.ownTeam = n.children.length > 0 ? readTeamLabel(bySlug.get(slug)!.team) : null;
    const here = n.ownTeam ? { team: n.ownTeam, lead: slug } : inherited;
    n.team = here?.team ?? null;
    n.teamLead = here?.lead ?? null;
    let count = 0;
    for (const c of n.children) count += 1 + visit(c, depth + 1, here);
    n.descendants = count;
    return count;
  };
  for (const r of roots) visit(r, 0, null);

  return { roots, nodes };
}

/** The chain from the top of the tree down to `slug`, both ends included; [] when unknown. */
export function chainOf(tree: TeamTree, slug: string): string[] {
  const out: string[] = [];
  let cur: string | null = slug;
  while (cur !== null) {
    const n = tree.nodes.get(cur);
    if (!n) break;
    out.unshift(cur);
    cur = n.parent;
  }
  return out;
}

/** Every slug below `slug`, depth-first in sibling order. */
export function descendantsOf(tree: TeamTree, slug: string): string[] {
  const out: string[] = [];
  const walk = (s: string) => {
    for (const c of tree.nodes.get(s)?.children ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(slug);
  return out;
}

/** The agents beside `slug`: its manager's other reports (other roots for a root are NOT
 *  peers: everyone reporting to the owner is not one team). */
export function peersOf(tree: TeamTree, slug: string): string[] {
  const p = tree.nodes.get(slug)?.parent;
  if (!p) return [];
  return (tree.nodes.get(p)?.children ?? []).filter((s) => s !== slug);
}

/**
 * Would `slug` reporting to `manager` close a cycle (or report to itself)? Read against the
 * tree AS WRITTEN (the raw `reports_to` values), so a write can never create a loop the
 * reader would have to break.
 */
export function wouldCycle(members: readonly TreeMember[], slug: string, manager: string): boolean {
  if (slug === manager) return true;
  const raw = new Map(members.map((m) => [m.slug, m.reportsTo]));
  const seen = new Set<string>();
  let cur: string | null = manager;
  while (cur !== null && !seen.has(cur)) {
    if (cur === slug) return true;
    seen.add(cur);
    cur = raw.get(cur) ?? null;
  }
  return false;
}

/** One line of the tree drawn as an indented list. */
export interface TreeLine {
  slug: string;
  depth: number;
  /** For each ancestor level 1..depth-1: does that level's vertical guide continue past here? */
  guides: boolean[];
  /** The last of its siblings (its elbow closes the guide). */
  last: boolean;
  hasChildren: boolean;
  collapsed: boolean;
}

/**
 * The tree flattened for an indented list, depth-first in sibling order, skipping what sits
 * under a collapsed node. `from` limits it to some roots (a section of the list).
 */
export function flattenTree(tree: TeamTree, collapsed: ReadonlySet<string>, from: readonly string[] = tree.roots): TreeLine[] {
  const out: TreeLine[] = [];
  const walk = (slug: string, guides: boolean[], last: boolean) => {
    const n = tree.nodes.get(slug);
    if (!n) return;
    const isCollapsed = collapsed.has(slug) && n.children.length > 0;
    out.push({ slug, depth: guides.length, guides: guides.slice(1), last, hasChildren: n.children.length > 0, collapsed: isCollapsed });
    if (isCollapsed) return;
    n.children.forEach((c, i) => walk(c, [...guides, !last], i === n.children.length - 1));
  };
  from.forEach((r, i) => walk(r, [], i === from.length - 1));
  return out;
}
