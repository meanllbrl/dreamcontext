/**
 * The new shell's chat drawer, as data (W2-A). Pure: `WindowChrome` hands it what the window
 * knows (the picker order, the mounted instances' rollups and drawer facts, the fan-out reads of
 * expanded projects that are not mounted) and `ChatDrawer` draws exactly the rows this returns.
 *
 * Under each expanded project, in order: the Super Agent row (always, D6), ONE Ekip row when the
 * project has a member of its own (plan-r10 1d: faces and one count, from `summary=1` `members`;
 * ten members are still one row), and one row per chat window that holds a chat, with its own
 * ring and count (W3, D8). A project with none has one New Chat row instead: nothing here opens
 * onto an empty screen. A collapsed project's row carries the sum of those same rows and keeps
 * its Ekip row. Members of all projects are in ONE Global ekip row at the very bottom (1f).
 */
import type { ProjectRollup } from '../../sleepy/agentStatus';
import {
  buildEkip, buildGlobalEkip, ekipAsking, ekipCount, projectEkip,
  type EkipIdentity, type EkipMember, type EkipSummary, type GlobalEkipMember, type TeamRow, type TeamStatus,
} from '../../aiteam/teamModel';
import type { AddTabResult } from '../WindowChrome';
import type { DrawerChatFact, DrawerWindowFact } from '../../../lib/drawerIntents';
import type { LiveChatWire, LiveChatsWire } from '../../handsfree/macContract';
import { type OpenRow } from '../../sleepy/phoneList';
import { homeRows, type HomeRow } from '../../sleepy/phoneHome';

/** Team members the drawer lists by name: the ones with work. Everyone else is on AI Team. */
export const LISTED_TEAM: ReadonlySet<TeamStatus> = new Set<TeamStatus>(['working', 'needs', 'approval']);

/** At most this many unmounted projects are polled; the rest are read once on expand (D7). */
export const DRAWER_POLL_CAP = 8;
/** The fan-out and the hidden-instance facts both refresh at this cadence while visible. */
export const DRAWER_POLL_MS = 15_000;
/** The tunnel's chat rows refresh at this cadence the whole time the page is visible. */
export const TUNNEL_CHATS_POLL_MS = 3_000;
/** A queued intent nobody consumed within this long is dropped (D5). */
export const DRAWER_INTENT_TTL_MS = 30_000;

export interface DrawerTeamRow {
  slug: string;
  title: string;
  hasPhoto: boolean;
  status: TeamStatus;
  /** Everything that makes it busy is the Super Agent's (a headless `team` job). */
  superOnly?: boolean;
  /** Its open question's words (a headless routine's). */
  preview?: string | null;
}

/** What one project's Ekip row is read from: the summary's `members` and who they are. */
export interface DrawerEkipFacts {
  /** `GET /agent/sessions?summary=1` `members`; absent before the first read. */
  members?: EkipSummary[];
  /** `GET /agents`: names and faces. */
  identities?: EkipIdentity[];
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
  /** The owner's chats alone, for a project with no window list yet. Absent = the whole rollup. */
  shown?: { live: number; asking: number; working: number; flagged: number };
  /** The member whose conversation the chat area shows. */
  member?: string;
  /** The Super Agent row's marks: its children at work, and a question for the owner. */
  superMarks?: { working: number; asking: boolean };
  /** The owner's chat tabs, each in its window (`DrawerSurfaceState.chats`). */
  chats?: DrawerChatFact[];
  /** The tab on screen. */
  activeChatId?: string;
  /** The Ekip row's read (plan-r10 1d). */
  members?: EkipSummary[];
  identities?: EkipIdentity[];
}

/** What the fan-out reads for an expanded project that is not mounted (D7). No ring: nothing
 *  runs while a project is not mounted. */
export interface FanoutFacts {
  tabs: number;
  superOn: boolean;
  team: DrawerTeamRow[];
  /** Each saved window's name and tab count (`?summary=1`'s `perWindow`); absent on an older server. */
  windows?: Array<{ id: string; name: string; tabs: number }>;
  /** The same marks, read from that project's record. */
  superMarks?: { working: number; asking: boolean };
  /** The Ekip row's read, collapsed projects included. */
  members?: EkipSummary[];
  identities?: EkipIdentity[];
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
  | { kind: 'super'; on: boolean; selected: boolean; working: number; asking: boolean }
  /** ONE Ekip row (plan-r10 1d): the project's own members, in the list's order; one count. */
  | { kind: 'team'; vault: string; members: EkipMember[]; count: number; asking: boolean; selected: boolean }
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
  }
  /** One chat by name: a tab of a mounted project, or a chat the Mac runs in a project this
   *  window has not mounted. `windowId` set = nested under its window's row (2+ windows). */
  | {
    kind: 'chat';
    id: string;
    vault: string;
    title: string;
    state: ChatRowState;
    flagged: boolean;
    selected: boolean;
    /** A tab here: it has a close button (closing ends the process). */
    closable: boolean;
    windowId?: string;
    /** What a tap opens (`openChatPlan`). */
    row: HomeRow;
    /** A Super row the Mac runs no chat for: drawn disabled, a tap does nothing. */
    offline?: boolean;
  }
  /** No window here holds a chat: opens one, ready to type in. */
  | { kind: 'new-chat' };

export type ChatRowState = 'asking' | 'working' | 'idle';

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
  /** Collapsed: its Super Agent (or a child) waits on the owner. */
  superAsking?: boolean;
  /** Collapsed: the sum of the rows it would show, for the ring beside the name. */
  sum?: { live: number; asking: number; working: number; idle: number; flagged: number };
  /** Collapsed: its Ekip row stays under it (r8-05). */
  team?: Extract<DrawerChild, { kind: 'team' }>;
}

/** The Global ekip row (plan-r10 1f, r8-12): every member of all projects once. */
export interface GlobalTeamRow {
  members: GlobalEkipMember[];
  count: number;
  asking: boolean;
}

/** The headless rows the Ekip row still reads: in-flight headless `team` jobs (the Super's) and
 *  a routine's open question. Everything else comes from the summary's `members`. */
export function headlessRowsOf(roster: readonly TeamRow[]): DrawerTeamRow[] {
  return roster
    .filter((r) => !r.readOnly && (r.status === 'working' || r.status === 'needs' || r.status === 'approval'))
    .map((r) => ({ slug: r.slug, title: r.title, hasPhoto: r.hasPhoto, status: r.status, superOnly: r.superOnly, preview: r.preview }));
}

/** One project's members, globals included, from what the window read for it. */
export function ekipOf(read: (DrawerEkipFacts & { team?: readonly DrawerTeamRow[] }) | undefined): EkipMember[] {
  if (!read?.members) return [];
  return buildEkip(read.members, read.identities, read.team ?? []);
}

/** The Ekip row of a project, or null when it has no member of its own. */
export function teamChildOf(vault: string, all: readonly EkipMember[], selected: boolean): Extract<DrawerChild, { kind: 'team' }> | null {
  const members = projectEkip(all);
  if (!members.length) return null;
  return { kind: 'team', vault, members, count: ekipCount(members), asking: ekipAsking(members), selected };
}

/**
 * The Global ekip row over the listed projects, or null when no project has a member of all
 * projects. Its count: each project's owner-facing questions and owner-origin unread of global
 * members, summed, plus each global member's approval card ONCE (one machine-wide bucket).
 */
export function buildGlobalTeam(perProject: ReadonlyArray<{ vault: string; members: readonly EkipMember[] }>, inView: string | null): GlobalTeamRow | null {
  const members = buildGlobalEkip(perProject, inView);
  if (!members.length) return null;
  let count = 0;
  for (const p of perProject) {
    for (const m of p.members) {
      if (!m.global || !m.enabled || m.superOnly) continue;
      if (m.asking) count += 1;
      count += m.unread;
    }
  }
  for (const m of members) if (m.approval) count += 1;
  return { members, count, asking: members.some((m) => m.approval || (m.asking && m.enabled && !m.superOnly)) };
}

/** Every listed project's members (globals included), for the Global ekip row: the mounted
 *  ones' facts, the fan-out's reads, a device shell's live read. */
export function ekipByProject(input: Pick<DrawerModelInput, 'projects' | 'facts' | 'fanout' | 'device'>): Array<{ vault: string; members: EkipMember[] }> {
  return input.projects.map((p) => {
    const mine = p.mounted ? input.facts[p.name] : undefined;
    const far = p.mounted ? undefined : input.fanout[p.name];
    if (input.device) {
      const live = input.device.members?.find((x) => x.vault === p.name)?.members;
      return { vault: p.name, members: ekipOf({ members: live, identities: mine?.identities }) };
    }
    return { vault: p.name, members: ekipOf(mine ?? far) };
  });
}

/** The listed members of a roster, those that want the owner first (needs, approval), then the
 *  working ones, each part in the roster's own order. */
export function teamRowsOf(roster: readonly TeamRow[]): DrawerTeamRow[] {
  const listed = roster.filter((r) => LISTED_TEAM.has(r.status) && !r.readOnly && !r.superOnly);
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
  /** A device shell (the tunnel, a phone on the laptop listener; `readDeviceShell`): its rows. */
  device?: DeviceDrawerInput;
}

/** What a device shell's drawer is built from: the window's one published fact
 *  (`ChromeApi.deviceChats`). */
export interface DeviceDrawerInput {
  /** Every chat row over the chosen projects (`homeRows`), Super rows included. */
  rows: readonly HomeRow[];
  /** Each project's members (`live-chats` `members` on a phone): its Ekip row. */
  members?: ReadonlyArray<{ vault: string; members: EkipSummary[] }>;
}

/** The device shell's published chat facts. Off a device shell it is {@link NO_DEVICE_CHATS}. */
export interface DeviceChats {
  rows: HomeRow[];
  /** The live read has answered (always true where nothing is read): the waiting toast's
   *  baseline. Nothing waits for it: every chosen project may start a chat at once. */
  liveAnswered: boolean;
  /** Conversations History must not list here: running, draining, or a Super's or its child's. */
  hiddenIds: ReadonlySet<string>;
  /** Each project's members (`live-chats` `members`), for the phone's Ekip rows. */
  members?: Array<{ vault: string; members: EkipSummary[] }>;
}

export const NO_DEVICE_CHATS: DeviceChats = { rows: [], liveAnswered: true, hiddenIds: new Set() };

/** The device shell's published fact, from the live read and the mounted projects' tabs. Pure. */
export function deviceChatsOf(o: {
  activeVault: string;
  projects: readonly string[];
  tabsByVault: Readonly<Record<string, readonly DrawerChatFact[] | undefined>>;
  live: LiveChatsWire | undefined;
  /** The tunnel: rows wait for the live read. A phone on the laptop listener reads none. */
  tunnel: boolean;
  liveAnswered: boolean;
  closed?: readonly string[];
}): DeviceChats {
  const closed = new Set(o.closed ?? []);
  const live = o.live ? { ...o.live, chats: o.live.chats.filter((c) => !closed.has(c.conversationId)) } : undefined;
  const otherTabs: Record<string, readonly DrawerChatFact[] | undefined> = {};
  for (const [v, tabs] of Object.entries(o.tabsByVault)) if (v !== o.activeVault) otherTabs[v] = tabs;
  const rows = homeRows({
    vault: o.activeVault, tabs: o.tabsByVault[o.activeVault] ?? [], otherTabs,
    projects: o.projects.length ? o.projects : [o.activeVault], live,
  });
  const hiddenIds = new Set<string>([
    ...(o.live?.chats ?? []).map((c) => c.conversationId),
    ...(o.live?.draining ?? []),
    ...(o.live?.supers ?? []).flatMap((x) => [x.conversationId, ...x.childIds]),
    ...(o.live?.parked ?? []),
    ...closed,
  ]);
  const members = liveMembersOf(o.live);
  return { rows, liveAnswered: o.tunnel ? o.liveAnswered : true, hiddenIds, ...(members.length ? { members } : {}) };
}

/** `live-chats` `members` on a phone (plan-r10 2.4), each entry checked: it is another
 *  machine's answer read over the wire. */
export function liveMembersOf(live: unknown): Array<{ vault: string; members: EkipSummary[] }> {
  const raw = (live as { members?: unknown } | null | undefined)?.members;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    if (!e || typeof e !== 'object') return [];
    const { vault, members } = e as { vault?: unknown; members?: unknown };
    if (typeof vault !== 'string' || !Array.isArray(members)) return [];
    const ok = members.filter((m): m is EkipSummary => !!m && typeof m === 'object' && typeof (m as { slug?: unknown }).slug === 'string');
    return ok.length ? [{ vault, members: ok }] : [];
  });
}

/** A device shell's chat rows of one project, from its published rows: the Super Agent's row
 *  when it is handed over, then the owner's chats, waiting → working → idle. */
function deviceChildren(vault: string, d: DeviceDrawerInput, sel: { onChat: boolean; activeChatId?: string; tabs: readonly DrawerChatFact[] }): DrawerChild[] {
  const out: DrawerChild[] = [];
  for (const row of d.rows) {
    if (row.vault !== vault) continue;
    if (row.kind === 'super') {
      const sup = row.row;
      out.unshift({
        // The product's name, the same in every language (`handsfree.super.title`).
        kind: 'chat', id: `super:${vault}`, vault, title: 'Super Agent',
        state: sup.live ? (sup.state === 'asking' ? 'asking' : sup.state === 'working' ? 'working' : 'idle') : 'idle',
        flagged: false, selected: false, closable: false, row, ...(sup.live ? {} : { offline: true }),
      });
      continue;
    }
    const r = row.row;
    const tab = r.kind === 'tab' ? sel.tabs.find((c) => c.id === r.id) : undefined;
    out.push(chatChild(vault, r, { selected: sel.onChat && r.kind === 'tab' && r.id === sel.activeChatId, flagged: !!tab?.attention }));
  }
  return out;
}

const stateOfDot = (dot: string): ChatRowState => (dot === 'asking' ? 'asking' : dot === 'working' || dot === 'starting' ? 'working' : 'idle');

/** One drawer chat row from a phone-list open row (a tab, or a chat the Mac runs). */
function chatChild(vault: string, r: OpenRow, o: { selected: boolean; windowId?: string; flagged: boolean }): DrawerChild {
  const row: HomeRow = {
    key: `${vault}:${r.key}`, vault, kind: 'open', row: r, title: r.title ?? '',
    line: r.kind === 'mac' ? r.lastLine : '', section: r.waiting ? 'waiting' : stateOfDot(r.dot) === 'working' ? 'working' : 'idle',
    updatedAt: r.kind === 'mac' ? r.chat.updatedAt : null,
  };
  return {
    kind: 'chat', id: r.id, vault, title: r.title ?? '', state: stateOfDot(r.dot), flagged: o.flagged,
    selected: o.selected, closable: r.kind === 'tab', ...(o.windowId ? { windowId: o.windowId } : {}), row,
  };
}

export function buildDrawerRows({ projects, activeVault, expanded, facts, fanout, device }: DrawerModelInput): DrawerProjectRow[] {
  const open = new Set(expanded);
  if (device) return projects.map((p) => deviceProjectRow(p, { activeVault, open, facts, device }));
  return projects.map((p): DrawerProjectRow => {
    const isOpen = open.has(p.name);
    const active = p.name === activeVault;
    const base = {
      name: p.name, logo: p.logo, logoStamp: p.logoStamp, active, held: p.mounted || p.asleep,
      asleep: p.asleep, otherWindow: p.otherWindow, expanded: isOpen,
    };
    const { source, children } = childrenOf(p, active, facts, fanout);
    if (isOpen) return { ...base, source, children };
    // Folded, the project row carries what its rows would say: no second count.
    const sum = sumOf(children, source);
    // A question still reaches the owner too.
    const ask = children.some((c) => c.kind === 'super' && c.asking);
    // Its Ekip row stays under it, folded or not (r8-05).
    const team = children.find((c): c is Extract<DrawerChild, { kind: 'team' }> => c.kind === 'team');
    return { ...base, source: 'none', children: [], ...(sum ? { sum } : {}), ...(ask ? { superAsking: true } : {}), ...(team ? { team } : {}) };
  });
}

/** The rows under a project, open or folded: the one place their numbers come from. */
function childrenOf(
  p: DrawerProjectInput,
  active: boolean,
  facts: DrawerModelInput['facts'],
  fanout: DrawerModelInput['fanout'],
): { source: DrawerProjectRow['source']; children: DrawerChild[] } {
  const mine = p.mounted ? facts[p.name] : undefined;
  const far = p.mounted ? undefined : fanout[p.name];
  const source: DrawerProjectRow['source'] = p.mounted ? 'mounted' : far ? 'fanout' : 'none';
  const onChat = active && !!mine?.chatOpen;
  const superSelected = onChat && !!mine?.superSelected;

  const marks = mine?.superMarks ?? far?.superMarks;
  const children: DrawerChild[] = [
    // Always there, even before anything is read: it is how a project with no chat starts one.
    { kind: 'super', on: !!(mine?.superOn ?? far?.superOn), selected: superSelected, working: marks?.working ?? 0, asking: !!marks?.asking },
  ];
  // ONE Ekip row (plan-r10 1d): selected while a member's stage is on screen. It goes LAST (plan
  // r4 R5): it is the one block that grows (the list opens in place), so it pushes nothing down.
  const team = teamChildOf(p.name, ekipOf(mine ?? far), onChat && !!mine?.member);
  const r = p.mounted ? (mine?.shown ?? p.rollup) : null;
  const windowsOn = onChat && !superSelected && !mine?.member;
  const before = children.length;
  if (mine?.windows) {
    // `tabs` counts saved chats too: a window of sleeping tabs is not empty.
    for (const { tabs, ...w } of mine.windows) {
      if (tabs === 0) continue;
      children.push({ kind: 'window', ...w, selected: windowsOn && w.id === mine.activeWindowId });
    }
  } else if (far?.windows) {
    // Nothing runs while a project is not mounted: no ring, only each window's tab count.
    for (const w of far.windows) {
      if (w.tabs > 0) children.push({ kind: 'window', id: w.id, name: w.name, working: 0, asking: 0, flagged: 0, other: w.tabs, selected: false });
    }
  } else if ((r?.live ?? 0) > 0 || (far?.tabs ?? 0) > 0) {
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
  // Only on a known answer: before the roster is restored, or after a failed read, no row is
  // better than offering a chat over chats that are there.
  // A project with members keeps its New chat row (r8-07): its chevron is where a member's one
  // conversation starts.
  if ((children.length === before || team) && (mine?.windows || far?.windows)) children.push({ kind: 'new-chat' });
  if (team) children.push(team);
  return { source, children };
}

/**
 * The folded project's ring: the Super Agent row plus every chat row. Super's children never sit
 * in a chat window (`sessionHome`), so nothing counts twice. Team rows carry a status, no number.
 * A project that is not mounted adds only its Super Agent: `other` there is saved tabs, none of
 * them live, and a sleeping project gets no number.
 */
function sumOf(children: readonly DrawerChild[], source: DrawerProjectRow['source']): DrawerProjectRow['sum'] {
  const sum = { live: 0, asking: 0, working: 0, idle: 0, flagged: 0 };
  for (const c of children) {
    if (c.kind === 'super') sum.working += c.working;
    else if (c.kind === 'window' && source === 'mounted') {
      sum.working += c.working;
      sum.asking += c.asking;
      sum.idle += c.other;
      sum.flagged += c.flagged;
    }
  }
  sum.live = sum.working + sum.asking + sum.idle;
  return sum.live > 0 ? sum : undefined;
}

/**
 * A device shell's project: its Super row (handed over) and its chats by name, and nothing else:
 * no Super Agent button (a phone never hands over), no AI Team members, no window rows. A project
 * with no chat of the owner's offers New chat, handed over or not. A project with a chat waiting
 * on the owner opens by itself; folded, it sums its rows.
 */
function deviceProjectRow(p: DrawerProjectInput, o: { activeVault: string | null; open: ReadonlySet<string>; facts: Readonly<Record<string, DrawerFacts | undefined>>; device: DeviceDrawerInput }): DrawerProjectRow {
  const active = p.name === o.activeVault;
  const mine = p.mounted ? o.facts[p.name] : undefined;
  const onChat = active && !!mine?.chatOpen;
  const children = deviceChildren(p.name, o.device, { onChat, activeChatId: mine?.activeChatId, tabs: mine?.chats ?? [] });
  const waiting = children.some((c) => c.kind === 'chat' && c.state === 'asking');
  const isOpen = o.open.has(p.name) || waiting;
  const base = {
    name: p.name, logo: p.logo, logoStamp: p.logoStamp, active, held: p.mounted || p.asleep,
    asleep: p.asleep, otherWindow: p.otherWindow, expanded: isOpen,
  };
  // The phone's Ekip row (r8-05 at 390): from `live-chats` `members`; names from a mounted
  // project's read, else the slug.
  const live = o.device.members?.find((x) => x.vault === p.name)?.members;
  const team = teamChildOf(p.name, ekipOf({ members: live, identities: mine?.identities }), onChat && !!mine?.member);
  if (!isOpen) {
    const chats = children.filter((c): c is Extract<DrawerChild, { kind: 'chat' }> => c.kind === 'chat');
    const asking = chats.filter((c) => c.state === 'asking').length;
    const working = chats.filter((c) => c.state === 'working').length;
    const flagged = chats.filter((c) => c.flagged).length;
    const sum = chats.length ? { live: chats.length, asking, working, idle: chats.length - asking - working, flagged } : undefined;
    return { ...base, source: 'none', children: [], ...(sum ? { sum } : {}), ...(team ? { team } : {}) };
  }
  if (!children.some((c) => c.kind === 'chat' && c.row.kind !== 'super')) children.push({ kind: 'new-chat' });
  // Team last, after the chats and New chat, as on the desktop (plan r4 R5).
  if (team) children.push(team);
  return { ...base, source: p.mounted ? 'mounted' : 'none', children };
}

/**
 * A History pick on the tunnel resumes nothing when the chat is the Mac's fresh answer's Super or
 * a child of it, when it is still draining, or when there is no answer (a running chat would be
 * resumed beside itself). A project being handed over refuses nothing: the owner's chats live on
 * beside its Super. Pure: the guard of a pick.
 */
export function historyPickRefused(live: Pick<LiveChatsWire, 'supers' | 'draining' | 'parked'> | null | undefined, conversationId: string): boolean {
  if (!live) return true;
  if ((live.parked ?? []).includes(conversationId)) return true;
  if ((live.supers ?? []).some((x) => x.conversationId === conversationId || x.childIds.includes(conversationId))) return true;
  return (live.draining ?? []).includes(conversationId);
}

/** A drawer intent a device shell's surface refuses: only the hand-over (the Super Agent button
 *  is the Mac's). A new chat is never refused here: the tunnel already serves only the chosen
 *  projects. */
export function deviceRefusesIntent(kind: string): boolean {
  return kind === 'super';
}

/** The drawer toggle's count on a device shell: chats waiting on the owner, except the one on
 *  screen (it is already in front of them). */
export function deviceWaitingCount(d: Pick<DeviceChats, 'rows'>, onScreen: { vault: string; chatId?: string } | null): number {
  return d.rows.filter((r) => r.section === 'waiting'
    && !(onScreen && r.vault === onScreen.vault && r.kind === 'open' && r.row.kind === 'tab' && r.row.id === onScreen.chatId)).length;
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

/** The folded projects whose Super Agent marks are read, one summary each: not mounted, capped. */
export function foldedTargets(folded: readonly string[], mounted: readonly string[], cap = DRAWER_POLL_CAP): string[] {
  return folded.filter((v) => !mounted.includes(v)).slice(0, cap);
}

/**
 * What the drawer reads for a project that is not mounted. A folded one has only its fresh marks:
 * a full read left from when it was open has stopped updating, and a stale ring is a wrong number.
 */
export function fanoutWithMarks(
  facts: Readonly<Record<string, FanoutFacts>>,
  marks: Readonly<Record<string, NonNullable<FanoutFacts['superMarks']>>>,
  folded: readonly string[],
  /** A folded project's Ekip read (its row stays under it). */
  teams: Readonly<Record<string, DrawerEkipFacts | undefined>> = {},
): Record<string, FanoutFacts> {
  const out = { ...facts };
  for (const v of folded) {
    delete out[v];
    const ekip = teams[v];
    if (marks[v]) out[v] = { tabs: 0, superOn: true, team: [], superMarks: marks[v], ...(ekip?.members ? { members: ekip.members, identities: ekip.identities ?? [] } : {}) };
  }
  return out;
}

/** A drawer intent only travels to a project this window now shows, mounted (D5, the
 *  `landLink` rule): another window coming forward, a refusal at the ceiling or a cold chip all
 *  drop it, and the notice (or the other window) says why. */
export function intentLands(result: AddTabResult, mountedAfter: boolean): boolean {
  return (result === 'added' || result === 'focused-tab') && mountedAfter;
}

/**
 * Where a chat row dragged to height `y` lands: before the first window row whose middle is
 * below `y`, or the end (null). Only window rows are given, so Super Agent and the team rows
 * above them are never a target: pulled above the first window, a row stops there.
 */
export function windowDropBefore(rows: ReadonlyArray<{ id: string; top: number; height: number }>, y: number): string | null {
  return rows.find((r) => y < r.top + r.height / 2)?.id ?? null;
}

/** Would a drop before `before` leave the rows as they are? `ids` is the rows' order. */
export function windowDropIsNoop(ids: readonly string[], id: string, before: string | null): boolean {
  const next = ids[ids.indexOf(id) + 1] ?? null;
  return before === id || before === next;
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

/** What a chat row's tap does in its project (`open-chat`, read by `AgentSurface`). */
export type OpenChatPlan =
  /** A tab here: select it (a parked window comes forward). */
  | { kind: 'tab'; id: string }
  /** A chat the Mac runs: ADOPT it (`reattach=1`), never a resume beside it, which would start a
   *  second process on one conversation. */
  | { kind: 'adopt'; chat: LiveChatWire }
  /** A child of this project's Super Agent (a row read before a hand-over): its stage, adopting
   *  nothing. */
  | { kind: 'stage' }
  /** A handed-over project's Super row (the tunnel only). */
  | { kind: 'super'; row: HomeRow & { kind: 'super' } }
  /** Nothing to open: the row is for another project, or its tab has gone. */
  | { kind: 'none' };

export function openChatPlan(row: HomeRow, ctx: {
  vault: string;
  hasTab: (tabId: string) => boolean;
  /** This project's Super Agent is handed over now (its record, not the drawer's read). */
  superOn: boolean;
  /** The conversation is the Super Agent's (`sessionHome`). */
  isSuperChild: (conversationId: string) => boolean;
  tunnel: boolean;
}): OpenChatPlan {
  if (row.vault !== ctx.vault) return { kind: 'none' };
  if (row.kind === 'super') return ctx.tunnel ? { kind: 'super', row } : { kind: 'none' };
  if (row.kind !== 'open') return { kind: 'none' };
  const r = row.row;
  if (r.kind === 'tab') return ctx.hasTab(r.id) ? { kind: 'tab', id: r.id } : { kind: 'none' };
  // A tab here already holding it is found by the adoption itself (`resumePastSession`), which
  // also takes it back from a screen that took it over.
  if (ctx.superOn && ctx.isSuperChild(r.chat.conversationId)) return { kind: 'stage' };
  return { kind: 'adopt', chat: r.chat };
}

/**
 * How often the drawer's chat rows read `GET /agent/live-chats`, or false for not at all. The
 * route answers only the Mac's own app window and a signed-in phone: any other window reads
 * nothing and draws its own tabs. The tunnel at its quicker cadence while the page is visible;
 * the Mac only while the drawer is on screen and its window focused.
 * The caller passes the result through `pollMs`.
 */
export function drawerChatsPollMs(o: { tunnel: boolean; desktop: boolean; drawerVisible: boolean; focused: boolean; hidden: boolean }): number | false {
  if (o.hidden) return false;
  // The tunnel's rows feed the drawer AND the chat screen (swipe, toast, back badge): the whole
  // time the page is visible.
  if (o.tunnel) return TUNNEL_CHATS_POLL_MS;
  if (!o.desktop) return false;
  return o.drawerVisible && o.focused ? DRAWER_POLL_MS : false;
}
