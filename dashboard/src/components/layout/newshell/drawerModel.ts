/**
 * The new shell's chat drawer, as data (W2-A). Pure: `WindowChrome` hands it what the window
 * knows (the picker order, the mounted instances' rollups and drawer facts, the fan-out reads of
 * expanded projects that are not mounted) and `ChatDrawer` draws exactly the rows this returns.
 *
 * Under each expanded project, in order: the Super Agent row (always, D6), the AI Team members
 * that have work (LISTED statuses only, D7), and one row per named chat window with its own ring
 * and count (W3, D8). A collapsed project's row carries the sum of its windows.
 */
import type { ProjectRollup } from '../../sleepy/agentStatus';
import type { TeamRow, TeamStatus } from '../../aiteam/teamModel';
import type { AddTabResult } from '../WindowChrome';
import type { DrawerWindowFact } from '../../../lib/drawerIntents';

/** Team members the drawer lists by name: the ones with work. Everyone else is on AI Team. */
export const LISTED_TEAM: ReadonlySet<TeamStatus> = new Set<TeamStatus>(['working', 'needs', 'approval']);

/** At most this many unmounted projects are polled; the rest are read once on expand (D7). */
export const DRAWER_POLL_CAP = 8;
/** The fan-out and the hidden-instance facts both refresh at this cadence while visible. */
export const DRAWER_POLL_MS = 15_000;
/** A queued intent nobody consumed within this long is dropped (D5). */
export const DRAWER_INTENT_TTL_MS = 30_000;

export interface DrawerTeamRow {
  slug: string;
  title: string;
  hasPhoto: boolean;
  status: TeamStatus;
}

/** What a mounted instance publishes up (`DrawerFactsBridge`). */
export interface DrawerFacts {
  /** The project's Super Agent is handed over (its stage exists). */
  superOn: boolean;
  /** The overlay is showing the Super stage right now. */
  superSelected: boolean;
  /** The overlay is expanded: this project is "on Chat". */
  chatOpen: boolean;
  team: DrawerTeamRow[];
  /** Each chat window with its own ring and count (W3); absent = one window, the rollup's. */
  windows?: DrawerWindowFact[];
  activeWindowId?: string;
}

/** What the fan-out reads for an expanded project that is not mounted (D7). No ring: nothing
 *  runs while a project is not mounted. */
export interface FanoutFacts {
  tabs: number;
  superOn: boolean;
  team: DrawerTeamRow[];
  /** Each saved window's name and tab count (`?summary=1`'s `perWindow`); absent on an older server. */
  windows?: Array<{ id: string; name: string; tabs: number }>;
}

export interface DrawerProjectInput {
  name: string;
  logo: boolean;
  logoStamp: number | null;
  /** In this window, mounted (not a cold chip). */
  mounted: boolean;
  /** In this window as a cold chip ("asleep"). */
  asleep: boolean;
  /** Held by another OS window. */
  otherWindow: boolean;
  rollup: ProjectRollup | null;
}

export type DrawerChild =
  | { kind: 'super'; on: boolean; selected: boolean }
  | { kind: 'member'; slug: string; title: string; hasPhoto: boolean; status: TeamStatus }
  | {
    kind: 'window';
    id: string;
    /** The window's own name (a stored default reads as the localised "Chat"). */
    name: string;
    /** Live chats mid-turn (the ring). Zero for a project read by fan-out. */
    working: number;
    asking: number;
    flagged: number;
    /** The rest of the window's tabs (the plain count beside the ring). */
    other: number;
    selected: boolean;
  };

export interface DrawerProjectRow {
  name: string;
  logo: boolean;
  logoStamp: number | null;
  active: boolean;
  /** This window holds it (mounted or asleep): only then can it be closed here. */
  held: boolean;
  asleep: boolean;
  otherWindow: boolean;
  expanded: boolean;
  /** Where its child rows came from. `none` = expanded, but nothing read yet. */
  source: 'mounted' | 'fanout' | 'none';
  children: DrawerChild[];
  /** Collapsed and mounted: every window's chats summed, for the ring beside the name. */
  sum?: { live: number; asking: number; working: number; idle: number; flagged: number };
}

/** The listed members of a roster, those that want the owner first (needs, approval), then the
 *  working ones, each part in the roster's own order. */
export function teamRowsOf(roster: readonly TeamRow[]): DrawerTeamRow[] {
  const listed = roster.filter((r) => LISTED_TEAM.has(r.status) && !r.readOnly);
  const rank = (s: TeamStatus) => (s === 'needs' ? 0 : s === 'approval' ? 1 : 2);
  return listed
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.status) - rank(b.r.status) || a.i - b.i)
    .map(({ r }) => ({ slug: r.slug, title: r.title, hasPhoto: r.hasPhoto, status: r.status }));
}

export interface DrawerModelInput {
  /** Every project, in the picker's order (`projectOrder`). */
  projects: readonly DrawerProjectInput[];
  activeVault: string | null;
  expanded: readonly string[];
  facts: Readonly<Record<string, DrawerFacts | undefined>>;
  fanout: Readonly<Record<string, FanoutFacts | undefined>>;
}

export function buildDrawerRows({ projects, activeVault, expanded, facts, fanout }: DrawerModelInput): DrawerProjectRow[] {
  const open = new Set(expanded);
  return projects.map((p): DrawerProjectRow => {
    const isOpen = open.has(p.name);
    const active = p.name === activeVault;
    const base = {
      name: p.name, logo: p.logo, logoStamp: p.logoStamp, active, held: p.mounted || p.asleep,
      asleep: p.asleep, otherWindow: p.otherWindow, expanded: isOpen,
    };
    if (!isOpen) {
      const r = p.mounted ? p.rollup : null;
      const sum = r && r.live > 0
        ? { live: r.live, asking: r.asking, working: r.working, idle: Math.max(0, r.live - r.working - r.asking), flagged: r.flagged }
        : undefined;
      return { ...base, source: 'none', children: [], ...(sum ? { sum } : {}) };
    }

    const mine = p.mounted ? facts[p.name] : undefined;
    const far = p.mounted ? undefined : fanout[p.name];
    const source: DrawerProjectRow['source'] = p.mounted ? 'mounted' : far ? 'fanout' : 'none';
    const onChat = active && !!mine?.chatOpen;
    const superSelected = onChat && !!mine?.superSelected;

    const children: DrawerChild[] = [
      // Always there, even before anything is read: it is how a project with no chat starts one.
      { kind: 'super', on: !!(mine?.superOn ?? far?.superOn), selected: superSelected },
    ];
    for (const m of (mine?.team ?? far?.team ?? [])) {
      children.push({ kind: 'member', slug: m.slug, title: m.title, hasPhoto: m.hasPhoto, status: m.status });
    }
    const r = p.mounted ? p.rollup : null;
    const windowsOn = onChat && !superSelected;
    if (mine?.windows?.length) {
      for (const w of mine.windows) {
        children.push({ kind: 'window', ...w, selected: windowsOn && w.id === mine.activeWindowId });
      }
    } else if (far?.windows?.length) {
      // Nothing runs while a project is not mounted: no ring, only each window's tab count.
      for (const w of far.windows) children.push({ kind: 'window', id: w.id, name: w.name, working: 0, asking: 0, flagged: 0, other: w.tabs, selected: false });
    } else {
      children.push({
        kind: 'window',
        id: 'main',
        name: 'Chat',
        working: r?.working ?? 0,
        asking: r?.asking ?? 0,
        flagged: r?.flagged ?? 0,
        other: r ? Math.max(0, r.live - r.working - r.asking) : (far?.tabs ?? 0),
        selected: windowsOn,
      });
    }
    return { ...base, source, children };
  });
}

/**
 * Which expanded projects the fan-out reads (D7): only expanded ones that are NOT mounted (a
 * mounted one publishes its own facts). While the drawer is visible and the window focused, the
 * first {@link DRAWER_POLL_CAP} of them poll; the rest are read once.
 */
export function fanoutTargets(
  expanded: readonly string[],
  mounted: readonly string[],
  live: boolean,
  cap = DRAWER_POLL_CAP,
): { poll: string[]; once: string[] } {
  const far = expanded.filter((v) => !mounted.includes(v));
  if (!live) return { poll: [], once: far };
  return { poll: far.slice(0, cap), once: far.slice(cap) };
}

/** A drawer intent only travels to a project this window now shows, mounted (D5, the
 *  `landLink` rule): another window coming forward, a refusal at the ceiling or a cold chip all
 *  drop it, and the notice (or the other window) says why. */
export function intentLands(result: AddTabResult, mountedAfter: boolean): boolean {
  return (result === 'added' || result === 'focused-tab') && mountedAfter;
}

/** Move `name` one step up (-1) or down (+1) in `order`; an end stays put. */
export function moveInOrder(order: readonly string[], name: string, delta: -1 | 1): string[] {
  const i = order.indexOf(name);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Drop `name` before the project at `beforeIndex` (pointer drag-and-drop). */
export function dropInOrder(order: readonly string[], name: string, beforeIndex: number): string[] {
  const rest = order.filter((n) => n !== name);
  if (rest.length === order.length) return [...order];
  const from = order.indexOf(name);
  const at = Math.max(0, Math.min(rest.length, from < beforeIndex ? beforeIndex - 1 : beforeIndex));
  rest.splice(at, 0, name);
  return rest;
}
