import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useServerHealth } from '../../hooks/useServerHealth';
import { useI18n } from '../../context/I18nContext';
import { SelectionBar } from '../sleepy/chat/SelectionBar';
import { useSidebarCollapse } from '../../hooks/useSidebarCollapse';
import { useTheme } from '../../context/ThemeContext';
import { setChipActiveProbe } from '../../lib/attention';
import { matchableItem } from '../../lib/openItem';
import { snapZoom } from '../../lib/zoom';
import { ZoomMenu } from './newshell/ZoomMenu';
import { trackPresence } from '../../lib/presence';
import { focusedChatFor, onFocusedChat } from '../../lib/focusedChat';
import { armFocusDiag, healUnfocusedPresses } from '../../lib/focusDiag';
import { setActiveOverlayScope } from '../../lib/overlayStack';
import {
  focusThisWindow,
  focusWindow,
  confirmAction,
  isDesktop,
  openVaultWindow,
  setGoToProjectHandler,
  startTitleBarDrag,
  toggleMaximizeWindow,
  START_INTENT_EVENT,
  type StartIntent,
} from '../../lib/desktop';
import { acceptStartIntent } from '../../lib/startChatIntent';
import { HEARTBEAT_MS, findWindowForVault, publishOpenVaults, releaseWindow } from '../../lib/windowRegistry';
import { ASSISTANT_WAKE_EVENT } from '../../lib/assistantBridge';
import { APP_LINK_OPEN_EVENT, isProjectAppLink, parseAppLink } from '../../lib/appLink';
import type { ProjectRollup } from '../sleepy/agentStatus';
import { ProjectInstance, type PendingAppLink, type PendingStartIntent } from '../../ProjectInstance';
import { ProjectSwitcher } from '../search/ProjectSwitcher';
import { markProjectSwitch } from '../../lib/projectSwitchPage';
import { UpgradeRelaunchBanner } from './UpgradeRelaunchBanner';
import { HandsfreeButton } from '../handsfree/HandsfreeButton';
import { isMacPhoneSurface } from '../../lib/phoneSurface';
import { COARSE_POINTER_QUERY, readIsMobile, useIsMobile, useRemoteDesktop } from '../../hooks/useIsMobile';
import { PhoneDrawerFoot } from '../handsfree/phone/PhoneDrawerFoot';
import { wasOpenedForLink } from '../../lib/windowLaunch';
import { useKeyboardUp } from '../../hooks/useKeyboardUp';
import { ChromeSlotsProvider, type ChromeSlots } from './chromeSlots';
import { ProjectTabs, type ProjectChip } from './ProjectTabs';
import { drawerTogglePanel, readDeviceShell, useIsNewShell, type NewProjectLanding } from '../../lib/uxMode';
import { drawerWidthOf, readLayoutPrefs, writeLayoutPrefs } from '../../lib/launcherPrefs';
import { useShellProjects } from '../../hooks/useShellProjects';
import { useUnregisterVault } from '../../hooks/useLauncher';
import { confirmRemoveProject, nextProjectAfterRemove } from '../../lib/removeProject';
import { TitleBar } from './newshell/TitleBar';
import type { PickerRow } from './newshell/ProjectPicker';
import { mergeProjectOrder } from './newshell/projectOrder';
import { ceilingKeep, chill, liveInstanceCount, oldestEvictable } from './instanceCeiling';
import { createRevealGate, isBareModifier, isMovePress, type Prepare, type PrepareReport, type PrepareTarget, type RevealGate } from '../../lib/revealGate';
import { ChatDrawer } from './newshell/ChatDrawer';
import { NewProjectFlow } from './newshell/NewProjectFlow';
import {
  buildDrawerRows, deviceChatsOf, deviceWaitingCount, DRAWER_INTENT_TTL_MS, dropInOrder, effectiveHidden, intentLands, moveAmong, NO_DEVICE_CHATS,
  sidebarMode, type DeviceChats, type DrawerFacts, type SidebarMode,
} from './newshell/drawerModel';
import { useBoardsFanout } from './newshell/boardsFanout';
import { useDrawerProjects } from '../../hooks/useDrawerProjects';
import { ApiClient } from '../../api/client';
import { setMemberEnabled } from '../aiteam/teamModel';
import { requestManageMembers } from '../../lib/openAgents';
import { useDrawerChats } from '../../hooks/useDrawerChats';
import { recentlyClosed } from '../sleepy/phoneClosed';
import type { HomeRow } from '../sleepy/phoneHome';
import { useIsNarrowWindow } from '../../hooks/useIsNarrowWindow';
import { ChatHistoryPicker } from '../sleepy/ChatHistoryPicker';
import { landsOnChat, type DrawerIntent, type PendingDrawerIntent } from '../../lib/drawerIntents';
import { createPlaceHistory, localPlaceStorage, type Place, type PlaceHistory } from '../../lib/placeHistory';
import { createNavRecorder, targetOf, type MoveTarget, type NavRecorder } from './navRecorder';
import { readShownSurface } from '../../lib/projectSwitchPage';
import { PAGE_LABEL_KEY } from '../../lib/pageLabels';
import { DEVICE_HIDDEN_PAGES } from './newshell/railModel';
import type { Page } from './Sidebar';
import './newshell/NewShell.css';
import './ProjectTabs.css';
import './Header.css';

/**
 * The window-level shell: everything that belongs to the WINDOW rather than to any one
 * project it is holding.
 *
 * dreamcontext used to be one OS window per project, which made "the window" and "the
 * project" the same thing — so the title bar could show a vault name, the zoom control could
 * live in a project's Header, and a chip strip was unnecessary. Now one window holds several
 * LIVE projects at once. This component owns the split: the chip strip and the controls that
 * are genuinely per-window (zoom, theme, the server-level banners, the rail width) live here;
 * everything per-vault (the rail toggle, the search pill, sleep debt, the update badge) is
 * still OWNED by the instance's Header, which portals it into this bar's two slots — one bar
 * on screen, N possible owners behind it (see `chromeSlots.tsx`).
 *
 * The instances themselves are all MOUNTED, all the time. Switching a chip toggles
 * visibility — it never unmounts, because an unmounted instance is a killed PTY and a dropped
 * WebSocket mid-conversation.
 */

/**
 * How many projects may be mounted and live at once. Each instance carries its own
 * QueryClient, agent surface and (usually) one or more PTYs, so this is a real resource
 * ceiling rather than a UI preference.
 */
export const MAX_LIVE_INSTANCES = 6;

/** How long a refusal stays on screen before it stops being an answer and starts being noise. */
const NOTICE_MS = 6_000;

export interface OpenProject {
  vault: string;
  /** Stable for the life of THIS mount, never reused — a reopened project gets a fresh id. */
  instanceId: string;
  /** Torn down to free a slot at the ceiling: the chip survives, the instance does not. */
  cold: boolean;
  /**
   * The latest rollup this instance published, or null when it has not published one yet.
   * **null is not idle** — see {@link oldestEvictable}.
   */
  rollup: ProjectRollup | null;
}

/** What `addTab` actually did, so the caller can tell "opened" from "already had it". */
export type AddTabResult = 'added' | 'focused-tab' | 'focused-window' | 'refused-ceiling';

/** What the active project's Shell reports to the window's recorder (navigation B, C3). */
export interface ShownReport {
  page: Page;
  chatOpen: boolean;
  /** The open item of the shown page (C4), or null. */
  item: { id: string; label: string | null } | null;
  /** The owner caused this change (he navigated inside the project), not a landing. */
  byOwner: boolean;
}

/** The window's ← → (navigation B, C2): one list of places across every project. */
export interface ChromeHistory {
  canBack: boolean;
  canForward: boolean;
  back(): void;
  forward(): void;
  /** Where ← lands ("acme · Control Panel"), or null. */
  backLabel: string | null;
  forwardLabel: string | null;
}

export interface ChromeApi {
  open: OpenProject[];
  activeVault: string;
  addTab(vault: string): Promise<AddTabResult>;
  activate(vault: string): void;
  closeTab(vault: string): void;
  detachToWindow(vault: string): Promise<void>;
  /** The window's zoom (one for every project in it). */
  zoom: number;
  setZoom(level: number): void;
  /** Open a chat row of `vault` (the drawer's rows, the phone's swipe): that project comes
   *  forward and the chat opens in it (`open-chat`). */
  openChatRow(vault: string, row: HomeRow): void;
  /** A device shell's chat facts (`readDeviceShell`): the drawer rows, whether the live read has
   *  answered and the conversations History hides. Everything on a
   *  device shell reads this one object. {@link NO_DEVICE_CHATS} anywhere else. */
  deviceChats: DeviceChats;
  /** Open the window's History (across projects). The tunnel has no other: a surface's own
   *  openers (⌘⇧O, the empty state, the New menu) call this. */
  openHistory(): void;
  /** Close the floating drawer: every bottom-bar / rail tap and a project pick (a phone's first
   *  screen opens with it over the page, so a tap must not rely on a page change to close it). */
  dismissDrawer(): void;
  /** Bring `vault` forward and hand it `intent` through the drawer's own per-project pending-intent
   *  queue (what a drawer row's click does): the intent lands once that project is mounted and on
   *  screen, never by a timer. A global member's project chip and the Global ekip list use it. */
  queueDrawerIntent(vault: string, intent: DrawerIntent): void;
  /** Navigation B (C2): open `place` (a page of a project with its item, or its Chat). */
  goToPlace(place: Place): void;
  /** The owner's own switch to `vault` (⌘P, ⌘1-9, ⌥Tab): the page on screen is carried. */
  switchTo(vault: string): void;
  /** The active project's Shell says what it shows (C3). */
  reportShown(vault: string, shown: ShownReport): void;
  history: ChromeHistory;
  /** The rail's projects, in order: `projectOrder` minus the hidden ones (badge N is ⌘N). */
  projects: string[];
  /** Every registered project, hidden ones too (⌘K searches them all). */
  registered: string[];
  /** The window's place memory (last item per page, last here, recent), or null outside a window. */
  places: PlaceHistory | null;
  /** "acme · Boards · Launch plan": how a place is named on screen. */
  placeLabel(place: Place): string;
  /** Tek-kenar C2: the project being prepared for a move (its sidebar row shows busy), or null. */
  preparingVault: string | null;
  /** Tek-kenar C4: the sidebar's "Search boards…", read by the embedded board explorer. */
  sidebarQuery: string;
  /** Tek-kenar C4/C6: the active project's board list, so its flat list is ready when it leaves. */
  seedBoards(vault: string, list: readonly { slug: string; name: string }[]): void;
}

/**
 * What `useChrome()` answers with no `WindowChrome` above it — the launcher window, which
 * mounts `ProjectSwitcher` too but holds no instances. It must not throw and must not
 * pretend there are chips: picking a project from the launcher opens that project's WINDOW,
 * which is exactly what the launcher did before any of this existed.
 */
const DETACHED_CHROME: ChromeApi = {
  open: [],
  activeVault: '',
  addTab: async (vault: string) => {
    await openVaultWindow(vault);
    return 'focused-window';
  },
  activate: () => {},
  closeTab: () => {},
  detachToWindow: async (vault: string) => {
    await openVaultWindow(vault);
  },
  zoom: 1,
  setZoom: () => {},
  openChatRow: () => {},
  deviceChats: NO_DEVICE_CHATS,
  openHistory: () => {},
  dismissDrawer: () => {},
  queueDrawerIntent: () => {},
  goToPlace: () => {},
  switchTo: () => {},
  reportShown: () => {},
  history: { canBack: false, canForward: false, back: () => {}, forward: () => {}, backLabel: null, forwardLabel: null },
  projects: [],
  registered: [],
  places: null,
  placeLabel: (place: Place) => place.vault,
  preparingVault: null,
  sidebarQuery: '',
  seedBoards: () => {},
};

const ChromeContext = createContext<ChromeApi>(DETACHED_CHROME);

/** This window's tab state and the operations on it; {@link DETACHED_CHROME} in the launcher. */
export function useChrome(): ChromeApi {
  return useContext(ChromeContext);
}

/* ─────────────────────────────── window-level chrome bits ─────────────────────────────── */

const ZOOM_STORAGE_KEY = 'dreamcontext-zoom';

function getStoredZoom(): number {
  try {
    const stored = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (stored !== null) {
      const val = parseFloat(stored);
      // The old 10% steps (0.85 … 1.2) are all on the new 5% grid; anything else snaps to it.
      if (Number.isFinite(val)) return snapZoom(val);
    }
  } catch { /* ignore */ }
  return 1.0;
}

/**
 * Zoom is a WINDOW property, not a project one — every instance's type scales together.
 * Which is also why the broadcast below stays on `window` rather than moving to an instance
 * bus: each mounted agent surface sets its xterm font size imperatively in JS and would
 * otherwise ignore app zoom entirely, so ALL of them have to hear this.
 */
function applyZoom(zoom: number) {
  document.documentElement.style.setProperty('--zoom', String(zoom));
  window.dispatchEvent(new CustomEvent('dreamcontext-zoom', { detail: zoom }));
}

/**
 * Version handshake against the running server process. Per-SERVER, not per-vault (one
 * server serves every project in this window), so it belongs to the chrome.
 *
 * This bundle is served fresh from disk, but a long-lived server keeps its route table in
 * memory — after an upgrade it serves THIS (new) bundle with an OLD API and newer routes
 * 404. An exact version match is the only check that can't drift.
 */
/** -1 / 0 / 1 for `a` vs `b` as dotted numeric versions (a pre-release tag is ignored), null when either is unparsable. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
  const parse = (v: string | null | undefined) => (typeof v === 'string' && /^\d+(\.\d+)*/.test(v) ? v.match(/^\d+(\.\d+)*/)![0].split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function StaleServerBanner() {
  const { t } = useI18n();
  const { health, serverCurrent } = useServerHealth();
  if (!health || serverCurrent) return null;
  // A server NEWER than this window's bundle: the page predates a rebuild, not the server.
  if (compareVersions(health.version, __DC_VERSION__) === 1) {
    return (
      <div className="stale-server-banner" data-testid="stale-page-banner">
        {t('staleServer.olderPage').replace('{page}', __DC_VERSION__).replace('{server}', String(health.version))}
      </div>
    );
  }
  return (
    <div className="stale-server-banner">
      ⚠ The dashboard server is running an older build (
      {health.version ?? 'unknown'} vs {__DC_VERSION__}) — some actions will fail.
      Restart it: <code>dreamcontext dashboard</code>
    </div>
  );
}

/* ──────────────────────────────────── ceiling rules ──────────────────────────────────── */

/**
 * Whether two rollups say the same thing — the re-render gate in `handleRollup`.
 *
 * EVERY field, listed once. An earlier form compared `worst`/`live`/`waiting` inline and
 * silently dropped `alive`, so a shell opening or closing could not reach the chrome at all
 * while the other three sat still — and `alive` is the one field the eviction rule reads. The
 * status counts have the same hazard in a subtler shape: one chat going idle while another
 * starts working leaves `worst`, `live` and `waiting` all unchanged, and only the bubbles
 * move. Comparing the whole record means adding a field to `ProjectRollup` can't quietly
 * reintroduce either bug.
 */
function sameRollup(a: ProjectRollup, b: ProjectRollup): boolean {
  return (Object.keys(a) as (keyof ProjectRollup)[]).every((k) => a[k] === b[k]);
}

/* ──────────────────────────────────── the component ──────────────────────────────────── */

/**
 * The link a window was OPENED to land (`&open=`, see `openVaultWindow`), as the first chip's
 * pending link — or nothing, when it names another project or is not a project link at all.
 */
function seedPendingLinks(initialVault: string, initialLink: string | null | undefined): Record<string, PendingAppLink> {
  const link = initialLink ? parseAppLink(initialLink) : null;
  if (!link || !isProjectAppLink(link) || link.vault !== initialVault) return {};
  return { [initialVault]: { raw: initialLink as string, nonce: 1 } };
}

/** Where a landed link goes (navigation B): a session lands on that project's Chat, a page or an
 *  app on that page place, anything else (a project, an automation, an agent) on any page of it. */
function linkTarget(link: Extract<ReturnType<typeof parseAppLink>, { vault: string }>): MoveTarget {
  const { vault } = link;
  if (link.kind === 'session') return targetOf({ vault, kind: 'chat' });
  if (link.kind === 'app') return targetOf({ vault, kind: 'page', page: 'apps', id: null, label: null });
  if (link.kind === 'page' && link.page !== 'agents' && link.page !== 'settings') {
    return targetOf({ vault, kind: 'page', page: link.page, id: link.id, label: null });
  }
  return { vault, kind: 'page', place: null };
}

/** How long the pointer may be off both the drawer button and the drawer before a hover peek closes:
 *  long enough to cross the gap between them. */
const PEEK_GRACE_MS = 200;

export function WindowChrome({ initialVault, initialLink, initialStart = null, initialIntent }: {
  initialVault: string;
  /** A `dreamcontext://` link this window was built to land (the `?open=` param). */
  initialLink?: string | null;
  /** The onboarding start intent this window was built to start (the `?start=` param). */
  initialStart?: StartIntent | null;
  /** What this window was built to land on (a project just made in the launcher window). */
  initialIntent?: DrawerIntent;
}) {
  const { theme, setTheme, resolved } = useTheme();
  const { t } = useI18n();
  // The new shell (Settings → New layout), frozen for this window by `lib/uxMode.ts`.
  const newShell = useIsNewShell();
  // A device shell (lib/uxMode.ts): the tunnel on any device, a phone on the laptop listener.
  const deviceShell = newShell && readDeviceShell();
  // Mac mode's tunnel: the trust boundary (`isMacPhoneSurface`), unchanged.
  const tunnel = isMacPhoneSurface();
  // The phone layout (narrow AND a finger), only ever in the new shell: the reading/touch switch,
  // never a navigation of its own.
  const narrowTouch = useIsMobile();
  const isMobile = newShell && narrowTouch;
  const newShellRef = useRef(newShell);
  // The new shell's one switch wrapper (navigation B), set once it is built below.
  const switchToRef = useRef<(vault: string) => void>(() => {});
  // The landed link's move (navigation B), set once the recorder is built below.
  const linkMoveRef = useRef<(target: MoveTarget) => { refused(): void; focusedWindow(): void } | null>(() => null);
  // The notices are set from stable callbacks (`addTab`, `activate`); a ref keeps them stable.
  const tRef = useRef(t);
  tRef.current = t;
  const [zoom, setZoom] = useState(getStoredZoom);
  const [notice, setNotice] = useState<string | null>(null);

  /*
   * The bar's two per-project mount points, held as STATE rather than refs: the active
   * instance portals its controls into them (see `chromeSlots.tsx`), and a portal target
   * read from a ref would be null on the instances' first render — they mount in the same
   * commit as the bar. The ref-callback → setState round trip re-renders the subtree once
   * the nodes exist, which is exactly when the portals can attach.
   */
  const [leftSlot, setLeftSlot] = useState<HTMLElement | null>(null);
  const [rightSlot, setRightSlot] = useState<HTMLElement | null>(null);
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null);
  // The local new shell (tek-kenar C4, C7): the page tabs in the bar, the board explorer and its
  // foot in the sidebar.
  const [tabsSlot, setTabsSlot] = useState<HTMLElement | null>(null);
  const [boardsSlot, setBoardsSlot] = useState<HTMLElement | null>(null);
  const [boardsFootSlot, setBoardsFootSlot] = useState<HTMLElement | null>(null);
  const chromeSlots = useMemo<ChromeSlots>(
    () => (newShell
      ? { left: leftSlot, right: rightSlot, rail: railSlot, tabs: tabsSlot, boards: boardsSlot, boardsFoot: boardsFootSlot }
      : { left: leftSlot, right: rightSlot }),
    [leftSlot, rightSlot, railSlot, tabsSlot, boardsSlot, boardsFootSlot, newShell],
  );

  /*
   * NO PERSISTENCE, deliberately. The window opens with exactly the one project the launcher
   * named in `?vault=`, every time. A restored tab list would resurrect N live agent surfaces
   * (and N PTYs) on a launch the user meant as a fresh start, and would do it before they had
   * a chance to say otherwise.
   */
  const [open, setOpenState] = useState<OpenProject[]>(() => [
    { vault: initialVault, instanceId: 'inst-1', cold: false, rollup: null },
  ]);
  const [activeVault, setActiveState] = useState(initialVault);
  /**
   * One rail width for the whole window. Hoisted out of `Shell` because N instances each
   * running their own `useSidebarCollapse()` would read the shared key at mount and then
   * diverge the moment one of them toggled — two rails of different widths in one window.
   * It folds while the ACTIVE project is handed over to its Super Agent (plan-r8 F9).
   */
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapse(
    open.find((p) => p.vault === activeVault)?.instanceId ?? null,
  );

  /*
   * `addTab` has to READ the current tabs and DECIDE in one synchronous pass (is it already
   * here? is there room? who can be evicted?) before returning its verdict to the caller. A
   * state variable captured in a closure is one render behind for that, so the tab list is
   * mirrored into a ref and every write goes through these two setters.
   */
  const openRef = useRef(open);
  const activeRef = useRef(activeVault);
  const seqRef = useRef(1);

  const setOpen = useCallback((next: OpenProject[]) => {
    openRef.current = next;
    setOpenState(next);
  }, []);

  /*
   * Tek-kenar C2, prepare then activate: a move to another project mounts or keeps it out of
   * sight, lets its landing run there and makes it the project on screen in ONE commit, once it
   * shows the target with nothing loading or moving, or at the bound (lib/revealGate.ts).
   */
  const [preparing, setPreparing] = useState<Prepare | null>(null);
  /** What ending a prepare does beyond the gate (drop its intent, end its move): set below. */
  const prepareEndRef = useRef<(p: Prepare, why: 'cancel' | 'replaced') => void>(() => {});
  const gateRef = useRef<RevealGate | null>(null);
  /** Set by the gate's activation: where focus lands if A going inert drops it (see below). */
  const landFocusRef = useRef<{ vault: string; chat: boolean } | null>(null);
  if (gateRef.current === null) {
    gateRef.current = createRevealGate({
      now: Date.now,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      // Acts only on a project still open and mounted; one commit with `preparing = null`.
      onActivate: (p, why) => {
        const tab = openRef.current.find((o) => o.vault === p.vault);
        if (!tab || tab.cold) return;
        // The seamless probe (scripts/verify/tek-kenar-seamless.mjs) sets this list; nothing else does.
        const log = (window as Window & { __dcReveal?: unknown[] }).__dcReveal;
        if (Array.isArray(log)) log.push({ vault: p.vault, why, cold: p.cold, ms: Date.now() - p.startedAt, at: performance.now() });
        landFocusRef.current = { vault: p.vault, chat: p.target.kind === 'chat' };
        activeRef.current = p.vault;
        setActiveState(p.vault);
      },
      onEnd: (p, why) => prepareEndRef.current(p, why),
      onChange: (p) => setPreparing(p),
    });
  }
  const gate = gateRef.current;
  useEffect(() => () => gate.dispose(), [gate]);
  /*
   * A key-driven move (⌘N, ⌥Tab) leaves focus inside A, which goes inert at activation, so focus
   * would fall to body. Before paint it moves to B's twin of where it was: B's composer when it
   * was in A's chat, else B's sidebar row (never into B's chat: ⌘1-9 skip the chat, so the next
   * ⌘N would stop working). Focus the owner put somewhere live is never taken.
   */
  useLayoutEffect(() => {
    const land = landFocusRef.current;
    landFocusRef.current = null;
    if (!land || land.vault !== activeVault) return;
    const at = document.activeElement;
    // Dead focus: body, inside A, or inside a body-portalled sheet that just went hidden with A.
    if (at && at !== document.body && !at.closest('.project-instance:not([data-active]), [hidden]')) return;
    const fromChat = !!at?.closest('.agent-surface');
    const inst = [...document.querySelectorAll<HTMLElement>('.project-instance[data-active]')]
      .find((el) => el.dataset.instanceVault === land.vault);
    const surface = land.chat && fromChat ? inst?.querySelector<HTMLElement>('.agent-surface') : null;
    const row = (sel: string) => document.querySelector<HTMLElement>(`${sel} .ns-dr-toggle`);
    const to = surface?.querySelector<HTMLElement>('textarea:not([disabled]), [contenteditable="true"]')
      ?? row(`[data-row-key="${CSS.escape(`project:${land.vault}`)}"]`)
      ?? row(`[data-drawer-project="${CSS.escape(land.vault)}"]`);
    to?.focus({ preventScroll: true });
  }, [activeVault]);

  /** The ONE activation entry. Every path but the gate's own commit cancels a pending prepare
   *  first: a chat row, a link, a start, New project, closing a tab all land where they say. */
  const setActive = useCallback((vault: string) => {
    gate.cancel();
    activeRef.current = vault;
    setActiveState(vault);
  }, [gate]);

  /** A fresh instance id. Never reuses a retired one — stale ids would collide in the DOM. */
  const mintInstanceId = useCallback(() => {
    seqRef.current += 1;
    return `inst-${seqRef.current}`;
  }, []);

  /**
   * The rollup sink: where every instance's published chip state lands, and the only place a
   * rollup lives.
   *
   * Kept ON the tab record rather than in a second `Record<vault, ProjectRollup>` beside it,
   * because a separate map would need its own invalidation on close, on eviction and on
   * revival — and the failure mode of getting that wrong is a stale `live: 0` making a
   * freshly-rebuilt instance look evictable. Here the rollup goes away exactly when the tab
   * that owns it does: `closeTab` drops the record, `chill` and `activate` null the field.
   *
   * Bails out BEFORE `setOpen` when nothing in the rollup moved. A publisher re-emits on
   * every status flip its surface notices — keystroke-driven `working`↔`ready` churn included
   * — and re-rendering the whole chrome (every chip, every consumer of `useChrome`) for a
   * rollup that says the same thing is the difference between a strip that idles and one that
   * repaints under the user's hands. Object identity is no use as the test: each publish is a
   * fresh object, so the comparison is field-by-field in {@link sameRollup}.
   */
  const handleRollup = useCallback((vault: string, next: ProjectRollup) => {
    const current = openRef.current;
    const index = current.findIndex((p) => p.vault === vault);
    if (index === -1) return;            // closed while its instance was tearing down
    const tab = current[index];
    if (tab.cold) return;                // evicted; whatever it says is about a dead instance
    const prev = tab.rollup;
    if (prev && sameRollup(prev, next)) return;
    const updated = [...current];
    updated[index] = { ...tab, rollup: next };
    setOpen(updated);
  }, [setOpen]);

  /**
   * Links waiting to land, one per project: handed to that project's instance, which acts on it
   * and reports it consumed. Held HERE rather than fired at the instance, because the instance
   * may not exist yet — a cold chip is rebuilt by the landing itself, and a fresh window's first
   * instance mounts in the same commit the link is seeded in. Cleared on consumption so a chip
   * that is later chilled and revived does not land the same link twice.
   */
  const [pendingLinks, setPendingLinks] = useState<Record<string, PendingAppLink>>(
    () => seedPendingLinks(initialVault, initialLink),
  );
  const linkSeqRef = useRef(1);
  const consumeLink = useCallback((vault: string, nonce: number) => {
    setPendingLinks((prev) => {
      if (prev[vault]?.nonce !== nonce) return prev;
      const next = { ...prev };
      delete next[vault];
      return next;
    });
  }, []);

  /**
   * Start intents waiting to reach a project's agent (the onboarding hand-off), held here for
   * the same reason as `pendingLinks`: the instance may not be mounted yet. Seeded from this
   * window's `?start=` param for its first project only.
   */
  const [pendingStarts, setPendingStarts] = useState<Record<string, PendingStartIntent>>(
    () => (initialStart ? { [initialVault]: { intent: initialStart, nonce: 1 } } : {}),
  );
  const startSeqRef = useRef(1);
  /** Broadcast nonces already taken, so a re-delivered `START_INTENT_EVENT` starts nothing. */
  const seenStartNoncesRef = useRef(new Set<string>());
  const consumeStart = useCallback((vault: string, nonce: number) => {
    setPendingStarts((prev) => {
      if (prev[vault]?.nonce !== nonce) return prev;
      const next = { ...prev };
      delete next[vault];
      return next;
    });
  }, []);

  const noticeTimer = useRef<number | null>(null);
  const notify = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    applyZoom(zoom);
  }, [zoom]);

  /*
   * The banners stack ABOVE the title bar, but every fixed surface below it (the Agent
   * overlay, full-page task and fullscreen views, the boards) is placed at `--header-height`
   * from the top of the viewport. Without this they kept starting 42px down while a banner
   * pushed the bar further, so the bar covered their first row: the chat's session tabs and
   * its new-chat button vanished whenever an update or stale-server banner was up.
   */
  const bannersRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bannersRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--chrome-banners-height', `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--chrome-banners-height');
    };
  }, []);

  /**
   * Teach the ask alarm which project is on screen.
   *
   * Without this, `attention.ts` can only ask whether the WINDOW is focused — and a focused
   * window holding six projects tells it nothing about the one that is asking. It would skip
   * the banner and the Dock bounce for a background project's question, which is the single
   * scenario the chip strip exists to surface.
   *
   * Reads `activeRef`, never the `activeVault` closure: an empty dep array over a captured
   * value would pin the probe to whichever project was active at MOUNT and answer for it for
   * the life of the window — a quieter version of the bug this fixes. Registered once and
   * torn down on unmount so a closed window never leaves a dangling answer behind.
   */
  useEffect(() => {
    setChipActiveProbe((vault) => vault === activeRef.current);
    return () => setChipActiveProbe(null);
  }, []);

  /**
   * Tell the server which project the owner is looking at while this window is in front
   * (`lib/presence.ts`): the notch only announces a finished chat from a project that is NOT
   * on screen, and the Assistant knows where the owner is. Reads `activeRef` for the same
   * reason the probe above does; a chip switch pokes it, and so does a chat taking the focus
   * in the project's surface (lib/focusedChat.ts): only THAT chat is on the owner's screen.
   */
  const presenceRef = useRef<ReturnType<typeof trackPresence> | null>(null);
  useEffect(() => {
    const p = trackPresence(() => {
      const vault = activeRef.current || null;
      return vault ? { vault, sessionId: focusedChatFor(vault) } : null;
    });
    presenceRef.current = p;
    const off = onFocusedChat(() => p.poke());
    return () => { off(); p.dispose(); presenceRef.current = null; };
  }, []);
  useEffect(() => { presenceRef.current?.poke(); }, [activeVault]);
  // A press in this page while it believes it is unfocused activates the app (lib/focusDiag.ts).
  useEffect(() => healUnfocusedPresses(), []);

  /**
   * Point the overlay stack at the project on screen, so Esc closes the panel the user can
   * SEE.
   *
   * Every instance stays mounted, so a background project's Esc handler is still registered
   * on `window` and still fires. Sharing one flat LIFO across them lets two projects steal
   * each other's Esc in both directions — a panel open in the background can sit on top and
   * deafen the foreground, or answer an Esc meant for it. `overlayStack.ts` carries the
   * reasoning; this is the one line that tells it which project is in front.
   *
   * Keyed on the INSTANCE id rather than the vault: reviving a cold chip mints a fresh id,
   * and the revived project's overlays must not inherit the dead instance's scope.
   */
  const activeInstanceId = open.find((p) => p.vault === activeVault)?.instanceId ?? null;
  useEffect(() => {
    setActiveOverlayScope(activeInstanceId);
    return () => setActiveOverlayScope(null);
  }, [activeInstanceId]);

  const activate = useCallback((vault: string) => {
    const current = openRef.current;
    const target = current.find((p) => p.vault === vault);
    if (!target) return;

    if (target.cold) {
      // Reviving a cold chip rebuilds a real instance, so it has to pass the ceiling too.
      let next = current;
      if (liveInstanceCount(current) >= MAX_LIVE_INSTANCES) {
        const victim = oldestEvictable(current, ceilingKeep(activeRef.current, gate.current()?.vault, vault));
        if (!victim) {
          notify(newShellRef.current ? tRef.current('shell.notice.ceiling') : `Can't reopen ${vault} — every other project has a live session.`);
          return;
        }
        next = chill(next, victim.vault);
        if (newShellRef.current) notify(tRef.current('shell.notice.evicted').replace('{name}', victim.vault));
      }
      setOpen(next.map((p) => (
        p.vault === vault ? { ...p, cold: false, rollup: null, instanceId: mintInstanceId() } : p
      )));
    }

    setActive(vault);
  }, [mintInstanceId, notify, setActive, setOpen, gate]);

  /**
   * The vault the ⌥Tab picker is currently POINTING AT, or null when the picker is down.
   * A preview, never a switch: nothing about the mounted instances changes while it is set.
   */
  const [preview, setPreviewState] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const setPreview = useCallback((vault: string | null) => {
    previewRef.current = vault;
    setPreviewState(vault);
  }, []);

  /**
   * ⌥Tab / ⌥⇧Tab walks the chip strip, in strip order, wrapping at both ends — as a HELD
   * pick, the way ⌘Tab works everywhere else on this machine.
   *
   * The shape is the point. Pressing ⌥Tab does not switch project; it opens a cursor on the
   * strip and moves it. Each further Tab (or ← / →) moves it again. The switch happens on the
   * RELEASE of Option, once — so walking four chips to the right one costs one switch instead
   * of four. That difference is not cosmetic here: a chip may be COLD, and switching to it
   * rebuilds a whole project instance (and can be refused at the ceiling). Under the old
   * press-to-switch shape, tabbing PAST a cold chip rebuilt it just to leave it again.
   *
   * NOT ⌘Tab, which is the combo the hand reaches for first: macOS gives it to the app
   * switcher before any web view is offered it, so it cannot be bound at all — `lib/agentSettings.ts`
   * refuses it in `RESERVED_HOTKEYS` for exactly this reason.
   *
   * Option rather than Control (which this was until 2026-08-14), because Control chords are
   * the SHELL's: ⌃C, ⌃D, ⌃W, ⌃A and the rest have to reach the PTY intact, and a window-level
   * capture that eats one is a bug the terminal can never explain. Claiming Option instead
   * leaves ⌃Tab to whatever has focus and costs nothing — macOS binds ⌥Tab to nothing, and the
   * app's only other Option chord is ⌥⌫ inside the terminal, which is not a Tab.
   *
   * Listens on `window` in the CAPTURE phase, and that placement is the whole trick: a chip
   * can be picked while a terminal pane holds focus, and without capturing above it the same
   * keystroke would ALSO be written to the PTY. The arrow keys are captured ONLY while the
   * picker is up, i.e. only while Option is physically held: outside that window they still
   * belong entirely to whatever has focus.
   *
   * With a single chip the key is not claimed at all: there is nowhere to go, and swallowing a
   * keystroke to do nothing is worse than leaving it whatever meaning it already had.
   */
  useEffect(() => {
    /** Move the cursor `delta` chips along, opening it at the ACTIVE chip on the first press. */
    const step = (delta: number): boolean => {
      const current = openRef.current;
      if (current.length < 2) return false;
      const from = previewRef.current ?? activeRef.current;
      const index = current.findIndex((p) => p.vault === from);
      if (index === -1) return false;
      setPreview(current[(index + delta + current.length) % current.length].vault);
      return true;
    };

    /**
     * Land on the picked chip and close the picker.
     *
     * Re-checks that the chip still EXISTS: the pick is held across an unbounded stretch of
     * wall-clock (the user's thumb), and a project can close underneath it — a background
     * window's registry claim, or the close button on a strip the pointer is also over.
     * Cold chips are committed INTO, like clicking one: reviving is what a chip in the strip
     * means. At the ceiling with every other project busy that revival can be refused, and
     * then the pick lands nowhere — the refusal says why, in the notice a click would raise.
     */
    const commit = () => {
      const target = previewRef.current;
      setPreview(null);
      // Committing back to the project on screen is a move to it: a prepare elsewhere ends.
      if (target === activeRef.current) { gate.cancel(); return; }
      if (target === null) return;
      if (!openRef.current.some((p) => p.vault === target)) return;
      if (newShellRef.current) { switchToRef.current(target); return; }
      markProjectSwitch(target);
      activate(target);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === 'Tab' && e.altKey) {
        if (!step(e.shiftKey ? -1 : 1)) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Everything below is claimed ONLY while the picker is up.
      if (previewRef.current === null) return;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          step(1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          step(-1);
          break;
        // Commit without waiting for the release, for a hand that would rather press Enter.
        case 'Enter':
        case ' ':
          commit();
          break;
        // Back out with nothing changed — the escape hatch a held gesture needs.
        case 'Escape':
          setPreview(null);
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    };

    /**
     * The release IS the switch.
     *
     * Fires on Option coming up (macOS reports it as `Alt`), and — as a belt-and-braces second
     * arm — on ANY key coming up once `altKey` has gone false, which is what a swallowed or
     * reordered modifier release looks like. Releasing Tab or Shift while Option is still down
     * reports `altKey: true` and is correctly ignored, so a ⌥⇧Tab walk survives letting go of
     * Shift mid-way.
     */
    const onKeyUp = (e: KeyboardEvent) => {
      if (previewRef.current === null) return;
      if (e.key !== 'Alt' && e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      commit();
    };

    /**
     * Losing the window mid-pick COMMITS rather than cancels. A blurred window never receives
     * the keyup, so the alternative is a pick that silently evaporates — the user asked for a
     * project, pressed the keys, and got nothing. Landing on the chip they were pointing at is
     * both the recoverable outcome and the one they asked for.
     */
    const onBlur = () => {
      if (previewRef.current !== null) commit();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [activate, setPreview, gate]);

  const addTab = useCallback(async (vault: string): Promise<AddTabResult> => {
    // 1. Already a chip in THIS window — the same project must never be open twice.
    if (openRef.current.some((p) => p.vault === vault)) {
      activate(vault);
      return 'focused-tab';
    }

    // 2. Already open in ANOTHER window — surface that window and add no chip here. One
    //    project, one home: two windows both live on the same `state/.agent-sessions.json`.
    //    The REGISTRY-ONLY lookup is the right one here, and deliberately so: it may name a
    //    window that has since closed, but the cost of that is a `focusWindow` resolving
    //    false, which falls straight through to opening the chip locally. (The corroborated
    //    `resolveLiveWindowForVault` is reserved for the checklist payload, where a wrong
    //    answer leaks a secret instead of costing a no-op — see `windowRegistry.ts`.)
    const otherWindow = findWindowForVault(vault);
    if (otherWindow && await focusWindow(otherWindow)) return 'focused-window';

    /*
     * That await yielded, so the tab list may have moved underneath: a rollup landed, or a
     * second pick of the same project got in behind this one. Re-read it — deciding the
     * ceiling from a pre-await snapshot and then writing it back would silently undo whatever
     * happened in between — and re-run the duplicate check on the fresh list.
     */
    const current = openRef.current;
    if (current.some((p) => p.vault === vault)) {
      activate(vault);
      return 'focused-tab';
    }

    // 3. At the ceiling — free a slot, or say why we can't.
    let next = current;
    if (liveInstanceCount(current) >= MAX_LIVE_INSTANCES) {
      const victim = oldestEvictable(current, ceilingKeep(activeRef.current, gate.current()?.vault));
      if (!victim) {
        notify(newShellRef.current ? tRef.current('shell.notice.ceiling') : `${MAX_LIVE_INSTANCES} projects are open and all of them have a live session — close one first.`);
        return 'refused-ceiling';
      }
      next = chill(next, victim.vault);
      notify(newShellRef.current
        ? tRef.current('shell.notice.evicted').replace('{name}', victim.vault)
        : `${victim.vault} was idle, so it was put to sleep to make room. Click its chip to reopen it.`);
    }

    // 4. Room to grow.
    setOpen([...next, { vault, instanceId: mintInstanceId(), cold: false, rollup: null }]);
    setActive(vault);
    return 'added';
  }, [activate, mintInstanceId, notify, setActive, setOpen, gate]);

  const closeTab = useCallback((vault: string) => {
    const current = openRef.current;
    if (current.length <= 1) {
      notify('This window always keeps one project open.');
      return;
    }
    const index = current.findIndex((p) => p.vault === vault);
    if (index === -1) return;
    // Closing (or detaching, or removing) the project being prepared ends its prepare.
    if (gate.current()?.vault === vault) gate.cancel();

    const next = current.filter((p) => p.vault !== vault);
    setOpen(next);

    if (activeRef.current === vault) {
      // Prefer the chip that took its place, then walk left; skip cold chips so closing a tab
      // never lands the user on a blank body.
      const searchOrder = [...next.slice(index), ...next.slice(0, index).reverse()];
      setActive((searchOrder.find((p) => !p.cold) ?? searchOrder[0]).vault);
    }
  }, [notify, setActive, setOpen, gate]);

  const detachToWindow = useCallback(async (vault: string) => {
    if (openRef.current.length <= 1) {
      notify(`${vault} is this window's only project — open another one first.`);
      return;
    }
    try {
      // Open FIRST, close second: if the window can't be created we still have the chip,
      // whereas the other order would drop the project on the floor.
      await openVaultWindow(vault);
    } catch (err) {
      notify(`Couldn't open a window for ${vault}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    closeTab(vault);
  }, [closeTab, notify]);

  /**
   * Take over `goToProject` for as long as this window can hold chips.
   *
   * "Go to project X" used to mean "open X's window" because a window WAS a project. It now
   * means "add a chip here" — but the callers that say it (the ⌘P switcher, and anything
   * non-React that reaches for `lib/desktop`) can't see chrome state, so the inversion happens
   * through a registration rather than an import. Cleared on unmount: a window that is going
   * away must not keep answering for chips it no longer has, and the launcher — which
   * registers nothing — keeps opening a separate window exactly as before.
   */
  useEffect(() => {
    setGoToProjectHandler(async (vault: string) => { await addTab(vault); });
    return () => setGoToProjectHandler(null);
  }, [addTab]);

  /**
   * The Assistant wants a project this window holds as a COLD tab: rebuild it here, so its
   * command lands in the window the owner already has instead of a new one
   * (`commandExecutor.ts`). Only a tab this window already lists is ever woken — the event
   * cannot add a project, only bring back one that is here.
   */
  useEffect(() => {
    if (!isDesktop()) return;
    let off: (() => void) | null = null;
    let gone = false;
    void (async () => {
      try {
        // The same `listen` the doorbell uses (`assistantBridge.ts`): proven to hear `emitTo`.
        // Every window hears it; only the one that holds the tab acts.
        const { listen } = await import('@tauri-apps/api/event');
        const fn = await listen<{ vault?: unknown }>(ASSISTANT_WAKE_EVENT, (e) => {
          const vault = typeof e.payload?.vault === 'string' ? e.payload.vault : '';
          if (vault && openRef.current.some((p) => p.vault === vault)) activate(vault);
        });
        if (gone) fn(); else off = fn;
      } catch { /* no Tauri runtime / ACL — the notch falls back to its own window */ }
    })();
    return () => { gone = true; off?.(); };
  }, [activate]);

  /**
   * A clicked `dreamcontext://` link landing in THIS window (`lib/appLink.ts` routes it here
   * because this window holds the project). Re-parsed, never trusted: the event is an `emitTo`
   * any window may send. The project's chip comes forward — a cold one is woken in place — the
   * window itself comes forward, and the link goes to that project's instance to finish.
   *
   * A project this window does not hold arrives only when the lookup was stale; it is added as
   * a chip if `addTab` agrees (it may instead focus the other window that has it, or refuse at
   * the ceiling with its own notice), and never forwarded on — two windows each believing the
   * other has it must not bounce a link between them.
   */
  const landLink = useCallback(async (raw: string) => {
    const link = parseAppLink(raw);
    if (!link || !isProjectAppLink(link)) return;
    const { vault } = link;
    // Navigation B: the link's landing is a move with its target (a session lands on Chat, a page
    // or app on that page place, anything else on any page of the project).
    const move = linkMoveRef.current(linkTarget(link));
    if (openRef.current.some((p) => p.vault === vault)) {
      activate(vault);
    } else {
      const result = await addTab(vault);
      if (result === 'focused-window') { move?.focusedWindow(); return; }
      if (result !== 'added' && result !== 'focused-tab') { move?.refused(); return; }
    }
    // `activate` refuses a cold chip at the ceiling (and says why); a link cannot land in a
    // project that is not mounted.
    const tab = openRef.current.find((p) => p.vault === vault);
    if (!tab || tab.cold) { move?.refused(); return; }
    armFocusDiag(`link ${link.kind}`);
    void focusThisWindow();
    linkSeqRef.current += 1;
    const nonce = linkSeqRef.current;
    setPendingLinks((prev) => ({ ...prev, [vault]: { raw, nonce } }));
  }, [activate, addTab]);
  const landLinkRef = useRef(landLink);
  landLinkRef.current = landLink;

  useEffect(() => {
    if (!isDesktop()) return;
    let off: (() => void) | null = null;
    let gone = false;
    void (async () => {
      try {
        // THIS webview's listener, not the global one: a global `listen` hears every emit in
        // the app, whatever window it was addressed to, and every project window would land it.
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const fn = await getCurrentWebviewWindow().listen<{ link?: unknown }>(APP_LINK_OPEN_EVENT, (e) => {
          const raw = typeof e.payload?.link === 'string' ? e.payload.link : '';
          if (raw) void landLinkRef.current(raw);
        });
        if (gone) fn(); else off = fn;
      } catch (err) {
        console.warn('[app-link] this window cannot receive links:', err);
      }
    })();
    return () => { gone = true; off?.(); };
  }, []);

  /**
   * The onboarding hand-off for a project whose window was ALREADY open (`openVaultWindow`
   * answered `'focused'`, so the `?start=` param never reached it): the Launcher broadcasts
   * `START_INTENT_EVENT` and every window hears it. Only an intent that passes
   * `acceptStartIntent` against the projects THIS window holds is taken, once per nonce; the
   * chip comes forward and the intent waits for that project's instance.
   */
  useEffect(() => {
    if (!isDesktop()) return;
    let off: (() => void) | null = null;
    let gone = false;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const fn = await listen<unknown>(START_INTENT_EVENT, (e) => {
          const held = openRef.current.map((p) => p.vault);
          const accepted = acceptStartIntent(e.payload, held, seenStartNoncesRef.current);
          if (!accepted) return;
          activate(accepted.vault);
          void focusThisWindow();
          startSeqRef.current += 1;
          const nonce = startSeqRef.current;
          setPendingStarts((prev) => ({ ...prev, [accepted.vault]: { intent: accepted.intent, nonce } }));
        });
        if (gone) fn(); else off = fn;
      } catch (err) {
        console.warn('[start-intent] this window cannot receive start intents:', err);
      }
    })();
    return () => { gone = true; off?.(); };
  }, [activate]);

  /**
   * Publish this window's chips to the cross-window registry, on every change and on a
   * heartbeat.
   *
   * COLD CHIPS ARE PUBLISHED TOO. A cold chip is still this window's claim on that project —
   * clicking it rebuilds the instance HERE — so another window asking "who has X?" has to be
   * told about it, or the same project ends up live in two windows with two writers on one
   * `state/.agent-sessions.json`.
   *
   * Keyed on the SERIALISED vault list rather than on `open` itself, so the write fires when
   * the set of projects changes and not every time a rollup ticks — `open` gets a new identity
   * on every published status flip, which would otherwise republish several times a second.
   */
  const openVaultsKey = JSON.stringify(open.map((p) => p.vault));
  useEffect(() => {
    const vaults = JSON.parse(openVaultsKey) as string[];
    publishOpenVaults(vaults);
    const beat = window.setInterval(() => publishOpenVaults(vaults), HEARTBEAT_MS);
    return () => window.clearInterval(beat);
  }, [openVaultsKey]);

  /**
   * Withdraw this window's row the moment it starts closing, instead of leaving a lookup
   * pointing at it for up to `STALE_MS`. `beforeunload` covers the real exit; the unmount
   * cleanup covers a teardown that never becomes a page unload (a dev reload, say). The
   * registry's staleness GC is the backstop for the crash neither of them can catch.
   */
  useEffect(() => {
    window.addEventListener('beforeunload', releaseWindow);
    return () => {
      window.removeEventListener('beforeunload', releaseWindow);
      releaseWindow();
    };
  }, []);

  const setZoomLevel = useCallback((value: number) => {
    const level = snapZoom(value);
    setZoom(level);
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(level)); } catch { /* ignore */ }
  }, []);

  /* ── The new shell (Settings → New layout) ─────────────────────────────────────────────── */

  // The project this window last showed, for the next launch's "open on the last project".
  useEffect(() => {
    if (newShell && activeVault) writeLayoutPrefs({ lastVault: activeVault });
  }, [newShell, activeVault]);

  // Every registered project, in the owner's order (`projectOrder`), for the picker and ⌘1-9.
  // On the tunnel only the chosen projects, by name; else the launcher's list.
  const { data: launcherStatus } = useShellProjects(newShell);
  // Bumped when the drawer reorders: `readLayoutPrefs()` already holds the new order.
  const [orderRev, setOrderRev] = useState(0);
  const projectOrder = useMemo(() => {
    const names = (launcherStatus?.vaults ?? []).filter((v) => v.exists).map((v) => v.name);
    for (const p of open) if (!names.includes(p.vault)) names.push(p.vault);
    return mergeProjectOrder(readLayoutPrefs().projectOrder, names);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launcherStatus, open, orderRev]);
  const projectOrderRef = useRef(projectOrder);
  projectOrderRef.current = projectOrder;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const pickerRows = useMemo<PickerRow[]>(() => {
    if (!newShell) return [];
    const byName = new Map((launcherStatus?.vaults ?? []).map((v) => [v.name, v] as const));
    return projectOrder.map((name) => {
      const held = open.find((p) => p.vault === name);
      const v = byName.get(name);
      return {
        name,
        logo: !!v?.logo,
        logoStamp: v?.logoStamp ?? null,
        active: name === activeVault,
        asleep: !!held?.cold,
        otherWindow: !held && !!findWindowForVault(name),
      };
    });
    // `pickerOpen` re-reads the other windows' registry each time the picker opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newShell, launcherStatus, projectOrder, open, activeVault, pickerOpen]);

  // The drawer button and ⌘B: one route (D12). The window bumps a nonce on the ACTIVE instance;
  // its `PageDrawerToggleBridge` decides what it means on that page.
  const [drawerToggleNonce, setDrawerToggleNonce] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(() => readLayoutPrefs().drawerOpen ?? true);
  const toggleDrawer = useCallback(() => {
    setDrawerOpen((o) => { writeLayoutPrefs({ drawerOpen: !o }); return !o; });
  }, []);

  /* ── The chat drawer (W2-A): facts up, intents down (D5) ── */

  // What each mounted project publishes; dropped when its instance unmounts.
  const [drawerFacts, setDrawerFacts] = useState<Record<string, DrawerFacts>>({});
  const handleDrawerFacts = useCallback((vault: string, facts: DrawerFacts) => {
    setDrawerFacts((prev) => ({ ...prev, [vault]: facts }));
  }, []);
  useEffect(() => {
    setDrawerFacts((prev) => {
      const live = new Set(open.filter((p) => !p.cold).map((p) => p.vault));
      const kept = Object.entries(prev).filter(([v]) => live.has(v));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
  }, [open]);

  /** A drawer click is landing on this project's chat area: it counts as on Chat from the click,
   *  so the drawer stays where it is while the project comes up. */
  const [arrivingVault, setArrivingVault] = useState<string | null>(initialIntent ? initialVault : null);
  const activeFactsOnChat = !!(activeVault && drawerFacts[activeVault]?.chatOpen);
  const activeOnChat = activeFactsOnChat || (!!activeVault && activeVault === arrivingVault);
  /** What each project last showed (its Shell's report while active, or while prepared out of
   *  sight): the sidebar's mode follows the ACTIVE one's, so it changes once, at activation. */
  const [shownPages, setShownPages] = useState<Record<string, { page: string; chatOpen: boolean }>>({});
  const noteShownPage = useCallback((vault: string, page: string, chatOpen: boolean) => {
    setShownPages((prev) => (prev[vault]?.page === page && prev[vault]?.chatOpen === chatOpen ? prev : { ...prev, [vault]: { page, chatOpen } }));
  }, []);
  const activeShown = activeVault ? shownPages[activeVault] : undefined;
  const sidebarModeNow: SidebarMode = sidebarMode({ onChat: activeOnChat || !!activeShown?.chatOpen, page: activeShown?.page });
  const navMode = newShell && !deviceShell && sidebarModeNow !== 'chat';
  const boardsMode = newShell && !deviceShell && sidebarModeNow === 'boards';
  const [boardQuery, setBoardQuery] = useState('');
  useEffect(() => {
    if (!arrivingVault) return undefined;
    if (drawerFacts[arrivingVault]?.chatOpen) { setArrivingVault(null); return undefined; }
    const timer = window.setTimeout(() => setArrivingVault(null), DRAWER_INTENT_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [arrivingVault, drawerFacts]);
  // ≤900 the drawer floats over the page and a pick closes it (without forgetting the setting).
  const narrow = useIsNarrowWindow(900);
  // A phone opens with the drawer over the page (its first screen is the chat list), unless the
  // window was built to land a link: a notification tap goes straight to its chat.
  const [floatingOpen, setFloatingOpen] = useState(() => newShell && readIsMobile() && !wasOpenedForLink());
  // Hover peek: with the drawer shut, the pointer on the drawer button opens it over the page at
  // once, and it closes when the pointer leaves the button AND the drawer (a short grace crosses
  // the gap between them). A click on the button while it peeks pins it (the normal toggle).
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<number | null>(null);
  const clearPeekTimer = useCallback(() => {
    if (peekTimer.current !== null) { window.clearTimeout(peekTimer.current); peekTimer.current = null; }
  }, []);
  const closeOverlay = useCallback(() => { clearPeekTimer(); setPeek(false); setFloatingOpen(false); }, [clearPeekTimer]);
  useEffect(() => clearPeekTimer, [clearPeekTimer]);
  // Leaving Chat or changing project closes it. Compared with the previous values, not a first-run
  // flag (StrictMode runs mount effects twice). On a phone the Chat page coming up under the open
  // drawer in the same project (the launch's auto-expand) leaves it open; bar taps close it
  // through `dismissDrawer`, never through a flip.
  const drawerFlipRef = useRef({ onChat: activeOnChat, vault: activeVault });
  useEffect(() => {
    const prev = drawerFlipRef.current;
    drawerFlipRef.current = { onChat: activeOnChat, vault: activeVault };
    if (prev.onChat === activeOnChat && prev.vault === activeVault) return;
    if (isMobile && !prev.onChat && activeOnChat && prev.vault === activeVault) return;
    closeOverlay();
  }, [activeOnChat, activeVault, isMobile, closeOverlay]);
  // The local new shell (tek-kenar C3): ONE sidebar docked on every page, floating only ≤900. A
  // device shell keeps dev's rule: docked beside Chat, floating over any other page.
  const drawerFloats = narrow || (deviceShell && !activeOnChat);
  const docked = !drawerFloats && drawerOpen;
  const drawerVisible = newShell && (docked || (drawerFloats && floatingOpen) || peek);
  const drawerFloating = !docked;
  const peekOnly = peek && !(drawerFloats && floatingOpen);
  const onDrawerHover = useCallback((over: boolean) => {
    clearPeekTimer();
    if (!newShell) return;
    if (over) {
      // On a page whose side panel the button drives (Whiteboards, Brain) the chat drawer is not
      // what a click would toggle, so it does not peek there.
      const page = document.querySelector('.project-instance[data-active]')?.getAttribute('data-page') ?? '';
      if (drawerTogglePanel({ chatOpen: activeFactsOnChat, page, local: !deviceShell }) === 'page') return;
      if (!docked && !(drawerFloats && floatingOpen)) setPeek(true);
      return;
    }
    peekTimer.current = window.setTimeout(() => { peekTimer.current = null; setPeek(false); }, PEEK_GRACE_MS);
  }, [newShell, docked, drawerFloats, floatingOpen, activeFactsOnChat, clearPeekTimer, deviceShell]);
  const onDrawerToggle = useCallback(() => {
    clearPeekTimer();
    if (peek) {
      // Pinned: the overlay stays (floating) or docks open, and hover stops governing it.
      setPeek(false);
      if (drawerFloats) setFloatingOpen(true);
      else toggleDrawer();
      return;
    }
    if (drawerFloats) setFloatingOpen((o) => !o);
    else toggleDrawer();
  }, [peek, drawerFloats, toggleDrawer, clearPeekTimer]);
  const dismissFloating = closeOverlay;
  const drawerFloatsRef = useRef(drawerFloats);
  drawerFloatsRef.current = drawerFloats;
  // A link landing (a notification tap while the app is open) goes straight to its chat.
  useEffect(() => {
    if (Object.keys(pendingLinks).length > 0) setFloatingOpen(false);
  }, [pendingLinks]);
  // ≤600 on a phone the floating drawer is the first screen: the full height above the bottom bar.
  const phoneNarrow = useIsNarrowWindow(600);
  const drawerHome = isMobile && phoneNarrow;
  // The phone layer's page-wide switch (`body[data-phone]`): ONE writer, the window, so an
  // instance unmounting (an eviction) cannot take it away from the others.
  useLayoutEffect(() => {
    if (!isMobile) return undefined;
    document.body.dataset.phone = 'true';
    return () => { delete document.body.dataset.phone; };
  }, [isMobile]);
  // The on-screen keyboard is up: a phone's bottom bar steps aside so the composer sits on it.
  const keyboardUp = useKeyboardUp(isMobile);
  // Esc closes a floating or peeking drawer (its menus own their Esc first).
  useEffect(() => {
    if (!floatingOpen && !peek) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeOverlay(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [floatingOpen, peek, closeOverlay]);

  const [drawerExpanded, setDrawerExpanded] = useState<string[]>(() => {
    const stored = readLayoutPrefs().drawerExpanded;
    return stored.length ? stored : (initialVault ? [initialVault] : []);
  });
  const toggleExpanded = useCallback((name: string) => {
    setDrawerExpanded((cur) => {
      const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
      writeLayoutPrefs({ drawerExpanded: next });
      return next;
    });
  }, []);
  /** New project landed: its row open and selected at once, with no reload. */
  const queueDrawerIntentRef = useRef<(vault: string, intent: DrawerIntent | null) => Promise<AddTabResult>>(async () => 'refused-ceiling');
  const landNewProject = useCallback<NewProjectLanding>((name, how) => {
    setNewProjectOpen(false);
    setDrawerExpanded((cur) => {
      if (cur.includes(name)) return cur;
      const next = [...cur, name];
      writeLayoutPrefs({ drawerExpanded: next });
      return next;
    });
    // It lands on its chat like any drawer click (its own start, the initializer, opens the chat
    // itself), so it comes up selected in the drawer, never on the page a project starts on.
    // A Super landing queues NO drawer intent, only brings the project forward: `open-window`
    // shows the panes and raced the landing's stage (verify 2026-11-20, "No open chats").
    const landing: DrawerIntent | null = how === 'super-landing' ? null : how ? { kind: 'open-window' } : { kind: 'new-window' };
    void queueDrawerIntentRef.current(name, landing).then((result) => {
      if ((how === 'initializer' || how === 'super-landing') && (result === 'added' || result === 'focused-tab')) {
        startSeqRef.current += 1;
        const nonce = startSeqRef.current;
        setPendingStarts((prev) => ({ ...prev, [name]: { intent: how, nonce } }));
      }
    });
  }, []);
  const [drawerWidth, setDrawerWidth] = useState(() => drawerWidthOf(readLayoutPrefs().drawerWidth));
  const resizeDrawer = useCallback((w: number) => {
    setDrawerWidth(w);
    writeLayoutPrefs({ drawerWidth: w });
  }, []);
  const reorder = useCallback((next: string[]) => {
    writeLayoutPrefs({ projectOrder: next });
    setOrderRev((n) => n + 1);
  }, []);

  /* ── Hidden projects (owner 2026-11-14, option A): folded into ONE "Hidden" group at the
     bottom of the drawer, its mark the sum of theirs. The project hidden while on screen stays
     in the list until the owner switches away (`hideDeferred`). ⌘1-9 skip hidden projects. ── */
  const [hiddenStored, setHiddenStored] = useState<string[]>(() => readLayoutPrefs().hiddenProjects);
  const [hideDeferred, setHideDeferred] = useState<string | null>(null);
  const hideProject = useCallback((name: string) => {
    setHiddenStored((cur) => {
      if (cur.includes(name)) return cur;
      const next = [...cur, name];
      writeLayoutPrefs({ hiddenProjects: next });
      return next;
    });
    // Folded, so its mark is read on every poll (a folded hidden project is never capped out).
    setDrawerExpanded((cur) => {
      if (!cur.includes(name)) return cur;
      const next = cur.filter((n) => n !== name);
      writeLayoutPrefs({ drawerExpanded: next });
      return next;
    });
    if (name === activeVault) setHideDeferred(name);
  }, [activeVault]);
  const showProject = useCallback((name: string) => {
    setHiddenStored((cur) => {
      if (!cur.includes(name)) return cur;
      const next = cur.filter((n) => n !== name);
      writeLayoutPrefs({ hiddenProjects: next });
      return next;
    });
    setHideDeferred((d) => (d === name ? null : d));
  }, []);
  useEffect(() => {
    if (hideDeferred && activeVault !== hideDeferred) setHideDeferred(null);
  }, [activeVault, hideDeferred]);
  // A device shell drives another machine's set and edits nothing: no Hidden group there.
  const drawerHidden = useMemo(
    () => (deviceShell ? [] : effectiveHidden(hiddenStored, hideDeferred).filter((n) => projectOrder.includes(n))),
    [deviceShell, hiddenStored, hideDeferred, projectOrder],
  );
  const drawerHiddenRef = useRef(drawerHidden);
  drawerHiddenRef.current = drawerHidden;

  const mountedNames = useMemo(() => open.filter((p) => !p.cold).map((p) => p.vault), [open]);
  const drawerFolded = useMemo(() => projectOrder.filter((name) => !drawerExpanded.includes(name)), [projectOrder, drawerExpanded]);
  // A device shell reads no project's roster or team (its drawer is chats only), so no fan-out
  // and no vault-less avatar request.
  // The projects and boards modes show every project folded with its mark: no roster is read open.
  const { facts: fanout, moveWindow: moveFarWindow } = useDrawerProjects(
    newShell && !deviceShell && !navMode ? drawerExpanded : [], mountedNames, drawerVisible,
    newShell && !deviceShell ? (navMode ? projectOrder : drawerFolded) : [], drawerHidden);
  // The Mac's running chats, for the chat rows of projects this window has not mounted.
  const { live: liveChats, answered: liveAnswered } = useDrawerChats({ activeVault, drawerVisible, enabled: newShell });
  // A device shell's one published fact: memoized on the read and the tabs, a constant elsewhere.
  const deviceChats = useMemo<DeviceChats>(() => {
    if (!deviceShell) return NO_DEVICE_CHATS;
    const tabsByVault: Record<string, DrawerFacts['chats']> = {};
    for (const [v, f] of Object.entries(drawerFacts)) tabsByVault[v] = f.chats;
    return deviceChatsOf({ activeVault, projects: projectOrder, tabsByVault, live: liveChats, tunnel, liveAnswered, closed: recentlyClosed() });
  }, [deviceShell, activeVault, projectOrder, drawerFacts, liveChats, tunnel, liveAnswered]);
  const drawerProjects = useMemo(() => {
    if (!newShell) return [];
    const byName = new Map((launcherStatus?.vaults ?? []).map((v) => [v.name, v] as const));
    return projectOrder.map((name) => {
        const held = open.find((p) => p.vault === name);
        const v = byName.get(name);
        return {
          name,
          logo: !!v?.logo,
          logoStamp: v?.logoStamp ?? null,
          mounted: !!held && !held.cold,
          asleep: !!held?.cold,
          otherWindow: !held && !!findWindowForVault(name),
          rollup: held?.rollup ?? null,
        };
      });
  }, [newShell, launcherStatus, projectOrder, open]);
  const drawerRows = useMemo(() => {
    if (!newShell) return [];
    return buildDrawerRows({
      projects: drawerProjects,
      activeVault,
      expanded: drawerExpanded,
      facts: drawerFacts,
      fanout,
      ...(deviceShell ? { device: deviceChats } : {}),
    });
  }, [newShell, drawerProjects, activeVault, drawerExpanded, drawerFacts, fanout, deviceShell, deviceChats]);
  /** The projects and boards modes' rows: every project folded, the active one too (C3). */
  const navRows = useMemo(() => {
    if (!navMode) return [];
    return buildDrawerRows({ projects: drawerProjects, activeVault, expanded: [], facts: drawerFacts, fanout, collapseAll: true });
  }, [navMode, drawerProjects, activeVault, drawerFacts, fanout]);
  // C6: the other listed projects' boards, while boards mode is on screen.
  const boardsVaults = useMemo(() => projectOrder.filter((n) => n !== activeVault), [projectOrder, activeVault]);
  const { entries: boardEntries, seed: seedBoards } = useBoardsFanout(boardsMode && drawerVisible, boardsVaults, activeVault);
  /** An Ekip list's switch (`POST /api/agents/:slug/enabled`): the server's answer, and the
   *  project's next read shows it. A refusal (a phone and a member of all projects, a teammate's
   *  member) is said once. */
  const switchMember = useCallback((vault: string, slug: string, enabled: boolean) => (
    setMemberEnabled(new ApiClient(vault), slug, enabled).catch((err: unknown) => {
      notify(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    })
  ), [notify]);
  /** "Üyeleri yönet" for a project not on screen: queued per project (like a drawer intent) and
   *  taken by that project's instance once it is mounted and active, never by a timer. */
  const [pendingManage, setPendingManage] = useState<Record<string, { nonce: number; create?: boolean; global?: boolean }>>({});
  const manageSeqRef = useRef(0);
  const consumeManage = useCallback((vault: string, nonce: number) => {
    setPendingManage((prev) => {
      if (prev[vault]?.nonce !== nonce) return prev;
      const { [vault]: _gone, ...rest } = prev;
      return rest;
    });
  }, []);
  /** "Üyeleri yönet": the modal opens in that project, which comes forward first; `create` opens
   *  it on New member (the drawer Team row's "⋯"). */
  const manageMembers = useCallback((vault: string | null, opts?: { create?: boolean; global?: boolean }) => {
    const target = vault ?? activeRef.current;
    if (!target) return;
    setFloatingOpen(false);
    // "Tüm projelerde çalışan üye": the create step with "All projects" picked.
    const ask = opts?.create ? { create: true, ...(opts.global ? { global: true } : {}) } : null;
    if (target === activeRef.current) { requestManageMembers(ask ?? undefined); return; }
    manageSeqRef.current += 1;
    const nonce = manageSeqRef.current;
    setPendingManage((prev) => ({ ...prev, [target]: { nonce, ...(ask ?? {}) } }));
    if (openRef.current.some((p) => p.vault === target)) { activate(target); return; }
    void addTab(target).then((result) => {
      const tab = openRef.current.find((p) => p.vault === target);
      // Another window took it, or the ceiling refused: nothing waits here.
      if (!intentLands(result, !!tab && !tab.cold)) consumeManage(target, nonce);
    });
  }, [activate, addTab, consumeManage]);

  // "Remove from app…" (owner 2026-11-03): ask, drop the registry entry (the folder stays). When the
  // project is this window's only one, the window lands on another project FIRST: the server refuses
  // every request naming an unregistered project, so a window must never be left on one. With
  // nowhere to land, nothing is asked and nothing is removed.
  const unregisterVault = useUnregisterVault();
  const removeProject = useCallback(async (name: string) => {
    const entry = (launcherStatus?.vaults ?? []).find((v) => v.name === name) as { path?: unknown } | undefined;
    const path = typeof entry?.path === 'string' ? entry.path : null;
    let landOn: string | null = null;
    if (openRef.current.some((p) => p.vault === name) && openRef.current.length <= 1) {
      // A project open in another window would only bring that window forward.
      const order = projectOrderRef.current.filter((n) => n === name || !findWindowForVault(n));
      landOn = nextProjectAfterRemove(order, name);
      if (!landOn) {
        notify(tRef.current('shell.drawer.removeNeedsAnother').replace('{name}', name));
        return;
      }
    }
    let removed = false;
    try {
      removed = await confirmRemoveProject(name, path, {
        confirm: confirmAction,
        unregister: async (n) => {
          if (landOn) {
            const landed = await addTab(landOn);
            if (landed !== 'added' && landed !== 'focused-tab') throw new Error(tRef.current('shell.drawer.removeCannotLand'));
          }
          return unregisterVault.mutateAsync(n);
        },
        t: tRef.current,
      });
    } catch (err) {
      notify(tRef.current('shell.drawer.removeFailed').replace('{name}', name).replace('{error}', err instanceof Error ? err.message : String(err)));
      return;
    }
    if (removed && openRef.current.some((p) => p.vault === name)) closeTab(name);
  }, [launcherStatus, unregisterVault, notify, addTab, closeTab]);

  // The queue (D5): a row's click brings its project forward FIRST, and the intent travels
  // only when that project is now on screen and mounted (the `landLink` rule).
  const [pendingDrawerIntents, setPendingDrawerIntents] = useState<Record<string, PendingDrawerIntent>>(
    () => (initialIntent ? { [initialVault]: { intent: initialIntent, nonce: 1, at: Date.now() } } : {}),
  );
  const drawerSeqRef = useRef(1);
  const dropDrawerIntentRef = useRef<(vault: string, nonce: number) => void>(() => {});
  /** The input event being dispatched while a prepare is pending, and whether a move ran in it. */
  const currentInputRef = useRef<{ stamped: boolean } | null>(null);
  /** What each project showed when it was last on screen (its last report): a prepare of a
   *  project already showing the target is a warm one (C2). */
  const shownByVaultRef = useRef<Record<string, ShownReport>>({});
  /**
   * C2: mount or keep `vault` WITHOUT making it active, for a prepare. A cold tab is revived and a
   * new project mounted, each past the ceiling (the keep set holds the project on screen and the
   * one being prepared); another window holding it comes forward instead. `mountedNow`: this move
   * mounted it (a cold prepare).
   */
  const mountForPrepare = useCallback(async (vault: string): Promise<{ result: AddTabResult; mountedNow: boolean }> => {
    const held = openRef.current.find((p) => p.vault === vault);
    if (held && !held.cold) return { result: 'focused-tab', mountedNow: false };
    if (!held) {
      const otherWindow = findWindowForVault(vault);
      if (otherWindow && await focusWindow(otherWindow)) return { result: 'focused-window', mountedNow: false };
    }
    const current = openRef.current;
    const again = current.find((p) => p.vault === vault);
    if (again && !again.cold) return { result: 'focused-tab', mountedNow: false };
    let next = current;
    if (liveInstanceCount(current) >= MAX_LIVE_INSTANCES) {
      const victim = oldestEvictable(current, ceilingKeep(activeRef.current, vault));
      if (!victim) {
        notify(tRef.current('shell.notice.ceiling'));
        return { result: 'refused-ceiling', mountedNow: false };
      }
      next = chill(next, victim.vault);
      notify(tRef.current('shell.notice.evicted').replace('{name}', victim.vault));
    }
    setOpen(again
      ? next.map((p) => (p.vault === vault ? { ...p, cold: false, rollup: null, instanceId: mintInstanceId() } : p))
      : [...next, { vault, instanceId: mintInstanceId(), cold: false, rollup: null }]);
    return { result: again ? 'focused-tab' : 'added', mountedNow: true };
  }, [mintInstanceId, notify, setOpen]);

  const queueDrawerIntent = useCallback(async (vault: string, intent: DrawerIntent | null, onQueued?: (nonce: number) => void,
    opts?: { prepare?: boolean; moveId?: number | null }): Promise<AddTabResult> => {
    // C2: a window move to ANOTHER project prepares it out of sight; inside the project on screen,
    // and on every device shell, a move lands as before.
    if (opts?.prepare && newShellRef.current && !deviceShell && vault !== activeRef.current) {
      const target: PrepareTarget = !intent ? { kind: 'any' }
        : intent.kind === 'page'
          ? (intent.page === 'chat' ? { kind: 'chat' } : { kind: 'page', page: intent.page, id: matchableItem(intent.page, intent.id) })
          : landsOnChat(intent) ? { kind: 'chat' } : { kind: 'any' };
      let nonce: number | null = null;
      if (intent) {
        drawerSeqRef.current += 1;
        nonce = drawerSeqRef.current;
        const queued = nonce;
        setPendingDrawerIntents((prev) => ({ ...prev, [vault]: { intent, nonce: queued, at: Date.now() } }));
        onQueued?.(queued);
        if (target.kind === 'chat') setArrivingVault(vault);
      }
      const { result, mountedNow } = await mountForPrepare(vault);
      const tab = openRef.current.find((p) => p.vault === vault);
      if (!intentLands(result, !!tab && !tab.cold)) {
        setArrivingVault((v) => (v === vault ? null : v));
        if (nonce !== null) dropDrawerIntentRef.current(vault, nonce);
        return result;
      }
      // Warm: B is mounted and already shows the target (its last report on screen).
      const shown = shownByVaultRef.current[vault];
      const showsTarget = !!shown && (target.kind === 'any' ? !shown.chatOpen
        : target.kind === 'chat' ? shown.chatOpen
          : !shown.chatOpen && shown.page === target.page && (!target.id || shown.item?.id === target.id));
      gate.start(vault, target, { cold: mountedNow || !showsTarget, nonce, moveId: opts.moveId ?? null });
      return result;
    }
    // Queued BEFORE the project comes forward, in the same commit: it is what the project's first
    // render lands on. Queued after, the project would first open on its own page.
    drawerSeqRef.current += 1;
    const nonce = drawerSeqRef.current;
    if (intent) setPendingDrawerIntents((prev) => ({ ...prev, [vault]: { intent, nonce, at: Date.now() } }));
    if (intent) onQueued?.(nonce);
    // A drag or a chat row's close moves a row, never the owner: the caller sends either only to
    // a mounted project.
    if (intent && (intent.kind === 'move-window' || intent.kind === 'close-chat')) return 'focused-tab';
    // A window move landing on Chat counts as on Chat from the click too (the drawer does not flip).
    if (!intent || landsOnChat(intent) || (intent.kind === 'page' && intent.page === 'chat')) setArrivingVault(vault);
    let result: AddTabResult;
    if (openRef.current.some((p) => p.vault === vault)) {
      activate(vault);
      result = 'focused-tab';
    } else {
      result = await addTab(vault);
    }
    const tab = openRef.current.find((p) => p.vault === vault);
    if (intentLands(result, !!tab && !tab.cold)) return result;
    // Another window took it, or the ceiling refused: nothing lands here.
    setArrivingVault((v) => (v === vault ? null : v));
    setPendingDrawerIntents((prev) => {
      if (prev[vault]?.nonce !== nonce) return prev;
      const next = { ...prev };
      delete next[vault];
      return next;
    });
    return result;
  }, [activate, addTab, deviceShell, gate, mountForPrepare]);

  /* ── Navigation B (C1-C3): the window owns back/forward, recent places and last items ── */

  const [navRev, setNavRev] = useState(0);
  const placesRef = useRef<PlaceHistory | null>(null);
  if (placesRef.current === null) {
    placesRef.current = createPlaceHistory({ now: Date.now, storage: deviceShell ? null : localPlaceStorage() });
  }
  const places = placesRef.current;
  const recorderRef = useRef<NavRecorder | null>(null);
  if (recorderRef.current === null) {
    recorderRef.current = createNavRecorder({
      history: places,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      onChange: () => setNavRev((n) => n + 1),
    });
  }
  const recorder = recorderRef.current;
  useEffect(() => () => recorder.dispose(), [recorder]);
  /** One predicate for ← → and their tooltips, decided before any side effect: a project no
   *  longer registered, or one another window holds and this one does not. */
  const skipPlace = useCallback((p: Place) => (
    !projectOrderRef.current.includes(p.vault)
    || (!openRef.current.some((o) => o.vault === p.vault) && !!findWindowForVault(p.vault))
  ), []);
  /** Drop a still-unconsumed intent (a step replaced before it landed). */
  const dropDrawerIntent = useCallback((vault: string, nonce: number) => {
    setPendingDrawerIntents((prev) => {
      if (prev[vault]?.nonce !== nonce) return prev;
      const next = { ...prev };
      delete next[vault];
      return next;
    });
  }, []);
  dropDrawerIntentRef.current = dropDrawerIntent;
  /** A prepare that ends without activation: its unconsumed intent goes, B's busy row and chat
   *  arrival clear, and a cancel by input (no newer move) ends the recorder's move for it. A
   *  newer move ends that move itself (`recorder.move` records what had settled). */
  prepareEndRef.current = (p, why) => {
    if (p.nonce !== null && !p.consumed) dropDrawerIntent(p.vault, p.nonce);
    setArrivingVault((v) => (v === p.vault ? null : v));
    if (why === 'cancel' && p.moveId !== null) recorder.refused(p.moveId);
  };
  /** A move started inside an input event stamps it, so the input-cancel below lets it be. */
  const stampInput = useCallback(() => { if (currentInputRef.current) currentInputRef.current.stamped = true; }, []);
  /** How a move's answer ends it: the ceiling refused (a cold tab that stays cold counts), or
   *  another window holds the project and came forward. */
  const settleMove = useCallback((id: number, vault: string, result: AddTabResult) => {
    if (result === 'focused-window') { recorder.focusedWindow(id); return; }
    const tab = openRef.current.find((p) => p.vault === vault);
    if (result === 'refused-ceiling' || !tab || tab.cold) recorder.refused(id);
  }, [recorder]);
  /** A place's landing intent: a page with its item, or the project's Chat as it stands. */
  const placeIntent = (place: Place): DrawerIntent => (
    place.kind === 'chat' ? { kind: 'page', page: 'chat' } : { kind: 'page', page: place.page, ...(place.id ? { id: place.id } : {}) }
  );
  const goToPlace = useCallback((place: Place) => {
    stampInput();
    const id = recorder.move(targetOf(place));
    void queueDrawerIntent(place.vault, placeIntent(place), undefined, { prepare: true, moveId: id }).then((r) => settleMove(id, place.vault, r));
  }, [recorder, queueDrawerIntent, settleMove, stampInput]);
  const stepTo = useCallback((direction: -1 | 1) => {
    stampInput();
    let queued: { vault: string; nonce: number } | null = null;
    // The step first (it ends the previous move and walks on from it), the prepare after: a fast
    // <- <- walks two places back.
    const begun = recorder.step(direction, skipPlace, () => { if (queued) dropDrawerIntent(queued.vault, queued.nonce); });
    if (!begun) return;
    const { target } = begun;
    if (target.vault === activeRef.current) gate.cancel();
    void queueDrawerIntent(target.vault, placeIntent(target), (nonce) => { queued = { vault: target.vault, nonce }; }, { prepare: true, moveId: begun.id })
      .then((r) => settleMove(begun.id, target.vault, r));
  }, [recorder, skipPlace, dropDrawerIntent, queueDrawerIntent, settleMove, stampInput, gate]);
  /** The owner's own switch: the page on screen is carried (lib/projectSwitchPage.ts); the move's
   *  target is that project's Chat when Chat is carried, else the carried page when it can show
   *  it, else any page of it. */
  const switchTo = useCallback((vault: string) => {
    if (!vault) return;
    // A move to the project on screen: nothing to land, a prepare elsewhere ends.
    if (vault === activeRef.current) { gate.cancel(); return; }
    stampInput();
    const carried = readShownSurface();
    const canShow = (p: Page) => p !== 'settings' && !(deviceShell && DEVICE_HIDDEN_PAGES.has(p));
    if (deviceShell) {
      // Device shells keep dev's switch: the carry of lib/projectSwitchPage.ts.
      const target: MoveTarget = carried?.chat
        ? { vault, kind: 'chat', place: { vault, kind: 'chat' } }
        : carried && canShow(carried.page)
          ? { vault, kind: 'page', place: { vault, kind: 'page', page: carried.page, id: null, label: null } }
          : { vault, kind: 'page', place: null };
      const id = recorder.move(target);
      markProjectSwitch(vault);
      void addTab(vault).then((r) => settleMove(id, vault, r));
      return;
    }
    // C5: the same place in B. Chat on Chat; page P at the item open there when he last left it.
    let intent: DrawerIntent | null = null;
    let target: MoveTarget = { vault, kind: 'page', place: null };
    if (carried?.chat) {
      intent = { kind: 'page', page: 'chat' };
      target = targetOf({ vault, kind: 'chat' });
    } else if (carried && canShow(carried.page)) {
      const last = places.lastItemOn(vault, carried.page);
      intent = { kind: 'page', page: carried.page, ...(last ? { id: last.id } : {}) };
      target = targetOf({ vault, kind: 'page', page: carried.page, id: last?.id ?? null, label: last?.label ?? null });
    }
    const id = recorder.move(target);
    void queueDrawerIntent(vault, intent, undefined, { prepare: true, moveId: id }).then((r) => settleMove(id, vault, r));
  }, [recorder, deviceShell, addTab, settleMove, places, queueDrawerIntent, stampInput, gate]);
  switchToRef.current = switchTo;
  linkMoveRef.current = (target: MoveTarget) => {
    if (!newShellRef.current) return null;
    const id = recorder.move(target);
    return { refused: () => recorder.refused(id), focusedWindow: () => recorder.focusedWindow(id) };
  };
  /** A drawer row (and every other caller of the queue): a chat intent is a move to that
   *  project's Chat, a page intent a move to that page; a rename, close or drag is none. */
  const trackedIntent = useCallback((vault: string, intent: DrawerIntent | null): Promise<AddTabResult> => {
    if (!intent) return queueDrawerIntent(vault, null);
    const target: MoveTarget | null = intent.kind === 'page'
      ? (intent.page === 'chat' ? targetOf({ vault, kind: 'chat' }) : targetOf({ vault, kind: 'page', page: intent.page, id: intent.id ?? null, label: null }))
      : landsOnChat(intent) ? targetOf({ vault, kind: 'chat' }) : null;
    if (!target) return queueDrawerIntent(vault, intent);
    const id = recorder.move(target);
    return queueDrawerIntent(vault, intent).then((r) => { settleMove(id, vault, r); return r; });
  }, [recorder, queueDrawerIntent, settleMove]);
  queueDrawerIntentRef.current = trackedIntent;
  const reportShown = useCallback((vault: string, shown: ShownReport) => {
    if (vault !== activeRef.current) return;
    shownByVaultRef.current[vault] = shown;
    noteShownPage(vault, shown.page, shown.chatOpen);
    const place: Place = shown.chatOpen
      ? { vault, kind: 'chat' }
      : { vault, kind: 'page', page: shown.page, id: shown.item?.id ?? null, label: shown.item?.label ?? null };
    recorder.shown(place, shown.byOwner);
  }, [recorder, noteShownPage]);
  const placeLabel = useCallback((place: Place) => {
    const page = place.kind === 'chat' ? t('nav.chat') : t(PAGE_LABEL_KEY[place.page]);
    return [place.vault, page, place.kind === 'page' ? place.label : null].filter(Boolean).join(' · ');
  }, [t]);
  const backPlace = places.peekBack(skipPlace);
  const forwardPlace = places.peekForward(skipPlace);
  const backLabel = backPlace ? placeLabel(backPlace) : null;
  const forwardLabel = forwardPlace ? placeLabel(forwardPlace) : null;
  const history = useMemo<ChromeHistory>(() => ({
    canBack: backLabel !== null,
    canForward: forwardLabel !== null,
    back: () => stepTo(-1),
    forward: () => stepTo(1),
    backLabel,
    forwardLabel,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [backLabel, forwardLabel, stepTo, navRev]);
  const railProjects = useMemo(() => projectOrder.filter((n) => !drawerHidden.includes(n)), [projectOrder, drawerHidden]);

  const openChatRow = useCallback((vault: string, row: HomeRow) => {
    void trackedIntent(vault, { kind: 'open-chat', row });
  }, [trackedIntent]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const openHistory = useCallback(() => {
    setHistoryOpen(true);
    setFloatingOpen(false);
  }, []);

  // ── The phone's back gesture: from a chat back to the drawer, never out of the app ──
  // ONE history mark for the window (a swipe moves between project instances, and a mark per
  // instance raced on that), pushed while a chat is on screen with nothing over it, unwound when
  // that ends by any other route. Only THIS visit's entry is unwound; a leftover from before a
  // reload is cleared on mount.
  useEffect(() => {
    if (isMobile && window.history.state?.phoneChat) window.history.replaceState(null, '');
  }, [isMobile]);
  const backMarkOn = isMobile && activeOnChat && !drawerVisible && !historyOpen;
  useEffect(() => {
    if (!backMarkOn) return undefined;
    const mark = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.history.pushState({ phoneChat: mark }, '');
    // A docked drawer is already on screen; only a floating one opens.
    // Landing ON the mark is a phone sheet going (PhoneSheet.tsx), not a step back off the chat.
    const onPop = () => { if (window.history.state?.phoneChat !== mark && drawerFloatsRef.current) setFloatingOpen(true); };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      const top = window.history.state;
      if (top?.phoneChat === mark) window.history.back();
      // A phone sheet going in the same commit is still on top. Its step back is on its way, and
      // WebKit drops a second one taken before the first lands: this mark's step waits for it.
      else if (top?.phoneSheet) {
        window.addEventListener('popstate', () => {
          if (window.history.state?.phoneChat === mark) window.history.back();
        }, { once: true });
      }
    };
  }, [backMarkOn]);
  const chrome = useMemo<ChromeApi>(
    () => ({
      open, activeVault, addTab, activate, closeTab, detachToWindow, zoom, setZoom: setZoomLevel, openChatRow, deviceChats, openHistory, dismissDrawer: dismissFloating,
      queueDrawerIntent: (vault: string, intent: DrawerIntent) => { void trackedIntent(vault, intent); },
      goToPlace, switchTo, reportShown, history, projects: railProjects, registered: projectOrder, places, placeLabel,
      preparingVault: preparing?.vault ?? null,
      sidebarQuery: boardQuery,
      seedBoards,
    }),
    [open, activeVault, addTab, activate, closeTab, detachToWindow, zoom, setZoomLevel, openChatRow, deviceChats, openHistory, dismissFloating, trackedIntent,
      goToPlace, switchTo, reportShown, history, railProjects, projectOrder, places, placeLabel, preparing?.vault, boardQuery, seedBoards],
  );
  const consumeDrawerIntent = useCallback((vault: string, nonce: number) => {
    gate.consumed(vault, nonce);
    setPendingDrawerIntents((prev) => {
      if (prev[vault]?.nonce !== nonce) return prev;
      const next = { ...prev };
      delete next[vault];
      return next;
    });
  }, [gate]);
  const handlePrepared = useCallback((vault: string, report: PrepareReport) => {
    noteShownPage(vault, report.page, report.chatOpen);
    gate.report(vault, report);
  }, [gate, noteShownPage]);

  /*
   * C2: the owner's input belongs to the project on screen. While a prepare is pending, every
   * press and key that is not a move cancels it and then reaches A as normal. Decided once per
   * event, after it has been dispatched: a move handler that ran in it stamped it (a second Cmd-2
   * to the B already preparing keeps that prepare). Captured, so input A stops on the way up (a
   * board card, the terminal) still counts. A bare modifier, a key repeat, a primary press on a
   * move control (`data-move`) or on the sidebar's frame is not input. A drag-reorder on a
   * project row starts on a `data-move` row: a move, not input.
   */
  const preparingId = preparing?.id ?? null;
  useEffect(() => {
    if (preparingId === null) return undefined;
    const onInput = (e: Event) => {
      if (e instanceof KeyboardEvent && (isBareModifier(e.key) || e.repeat)) return;
      if (e instanceof PointerEvent && isMovePress(e.target, e.button)) return;
      const rec = { stamped: false };
      currentInputRef.current = rec;
      window.setTimeout(() => {
        if (currentInputRef.current === rec) currentInputRef.current = null;
        if (!rec.stamped && gate.current()?.id === preparingId) gate.cancel();
      }, 0);
    };
    window.addEventListener('pointerdown', onInput, true);
    window.addEventListener('keydown', onInput, true);
    return () => {
      window.removeEventListener('pointerdown', onInput, true);
      window.removeEventListener('keydown', onInput, true);
    };
  }, [preparingId, gate]);

  // History tags a chat that is open (a tab here, or running on the Mac) as open.
  const historyOpenIds = useMemo(() => {
    const ids = new Set<string>();
    for (const f of Object.values(drawerFacts)) {
      for (const c of f.chats ?? []) for (const id of [c.claudeId, c.altClaudeId]) if (id) ids.add(id);
    }
    for (const c of liveChats?.chats ?? []) ids.add(c.conversationId);
    return [...ids];
  }, [drawerFacts, liveChats]);
  const [newWindowNonce, setNewWindowNonce] = useState(0);
  const newWindowRef = useRef<() => boolean>(() => false);
  newWindowRef.current = () => {
    if (!drawerVisible) return false;
    setNewWindowNonce((n) => n + 1);
    return true;
  };

  // ⌘P opens the picker, ⌘1-9 pick the Nth project in the picker's order, ⌘B is the drawer
  // button. `ProjectSwitcher` is not mounted in the new shell, so ⌘P has one owner.
  useEffect(() => {
    if (!newShell) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const el = e.target instanceof Element ? e.target : null;
      const inTerminal = !!el?.closest('.xterm');
      const editable = !!el?.closest('input, textarea, select, [contenteditable="true"], .xterm');
      // ⌘1-9 skip the chat too, as the classic switcher does (ProjectSwitcher.tsx).
      // The picker's own filter box is an input, but ⌘1-9 there still jump.
      const inChat = (editable && !el?.closest('.ns-picker')) || !!el?.closest('.agent-surface');
      const key = e.key.toLowerCase();
      if (key === 'p' && !inTerminal) {
        e.preventDefault();
        setPickerOpen((o) => !o);
      } else if (key === 'b' && !editable) {
        e.preventDefault();
        setDrawerToggleNonce((n) => n + 1);
      } else if (key === 'n' && !inTerminal && newWindowRef.current()) {
        // ⌘N: New chat window's project picker, while the drawer is on screen; otherwise the
        // key is left alone (⌃N moves a line down in the composer).
        e.preventDefault();
      } else if (/^[1-9]$/.test(e.key) && !inChat) {
        const target = projectOrderRef.current.filter((n) => !drawerHiddenRef.current.includes(n))[Number(e.key) - 1];
        if (!target) return;
        e.preventDefault();
        switchToRef.current(target);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newShell, addTab]);

  const chips = useMemo<ProjectChip[]>(() => open.map((p) => ({
    vault: p.vault,
    active: p.vault === activeVault,
    // Where a released ⌥ would land. Independent of `active`, and on the SAME chip until the
    // first ⌥Tab moves it — "you are here" and "you would go here" are two different claims.
    preview: p.vault === preview,
    cold: p.cold,
    worst: p.rollup?.worst ?? 'ended',
    live: p.rollup?.live ?? 0,
    waiting: p.rollup?.waiting ?? 0,
    // An unpublished rollup — and a cold chip, whose rollup is nulled on eviction — reports
    // three zeros, so the chip draws no bubbles at all. That is exactly right: a project with
    // nothing mounted has no chats to count, and inventing a grey "0" for it would put a
    // permanent mark on every quiet chip in the strip.
    asking: p.rollup?.asking ?? 0,
    working: p.rollup?.working ?? 0,
    idle: p.rollup?.idle ?? 0,
    // Rides alongside the three, never inside them: a chat can be working AND unseen.
    flagged: p.rollup?.flagged ?? 0,
    // TODO(T19): the bounce has exactly one writer, and it is not this memo. The sink above
    // holds the state a bounce is derived FROM (`waiting` crossing 0→>0); T19 owns turning
    // that edge into a nonce, alongside the publisher that makes the edge happen at all.
    bounceNonce: 0,
  })), [open, activeVault, preview]);

  const cycleTheme = () => {
    setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');
  };
  const themeLabel = theme === 'system' ? `System (${resolved})` : resolved === 'dark' ? 'Dark' : 'Light';

  /**
   * The `+` opens the ⌘P switcher by firing the keystroke it already listens for.
   * TODO(T9): `ProjectSwitcher` gains a chrome-owned open handle and this goes away — until
   * then this task does not reach into a file it doesn't own to add one.
   */
  const openSwitcher = useCallback(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true }));
  }, []);

  // A computer or landscape tablet on Mac mode's tunnel: the new shell's title bar carries the
  // Mac's chip instead of the hands-free button (Mac mode is the Mac's). The tunnel never draws the
  // classic shell (a device shell is always the new one, lib/uxMode.ts).
  const remote = useRemoteDesktop();

  // The drawer toggle carries what waits elsewhere on a device shell (the chat on screen excluded).
  const activeChatOnScreen = activeOnChat && !drawerVisible ? { vault: activeVault, chatId: drawerFacts[activeVault]?.activeChatId } : null;
  const drawerWaiting = deviceShell ? deviceWaitingCount(deviceChats, activeChatOnScreen) : 0;
  // A finger on the new shell's title bar: 44 px targets, no zoom menu, the notch cleared.
  const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_POINTER_QUERY).matches;

  if (newShell) {
    return (
      <ChromeContext.Provider value={chrome}>
        <SelectionBar />
        <ChromeSlotsProvider value={chromeSlots}>
        <div className="window-chrome" data-shell="new" data-touch={coarse ? 'true' : undefined} data-keyboard={keyboardUp ? 'true' : undefined}>
          <div className="window-chrome-banners" ref={bannersRef}>
            <UpgradeRelaunchBanner />
            <StaleServerBanner />
          </div>
          <TitleBar
            activeVault={activeVault}
            rows={pickerRows}
            pickerOpen={pickerOpen}
            onNewProject={() => { setPickerOpen(false); setNewProjectOpen(true); }}
            onPickerOpen={setPickerOpen}
            onPick={(name) => { closeOverlay(); switchTo(name); }}
            notice={notice}
            onToggleDrawer={() => setDrawerToggleNonce((n) => n + 1)}
            waiting={drawerWaiting}
            touch={coarse}
            onDrawerHover={onDrawerHover}
            zoom={zoom}
            onZoom={setZoomLevel}
            onCycleTheme={cycleTheme}
            themeLabel={themeLabel}
            dark={resolved === 'dark'}
            setLeftSlot={setLeftSlot}
            setRightSlot={setRightSlot}
            setTabsSlot={setTabsSlot}
            {...(deviceShell ? { device: { tunnel, remote } } : {})}
          />
          {newProjectOpen && <NewProjectFlow onClose={() => setNewProjectOpen(false)} onLand={landNewProject} />}
          {/* [rail][drawer (W2)][instances]: each instance starts right of the drawer, so the
              chat overlay bounded to it (D4) never covers the rail or the drawer. */}
          <div className="ns-body" data-drawer={drawerVisible ? 'open' : 'closed'}>
            {/* The local new shell has no rail: its pages are the title bar's tabs (tek-kenar C7). */}
            {deviceShell && <div className="ns-rail-slot" ref={setRailSlot} />}
            {drawerVisible && drawerFloating && !peekOnly && (
              <div className="ns-drawer-scrim" onClick={closeOverlay} aria-hidden="true" />
            )}
            {drawerVisible && (
              <ChatDrawer
                rows={drawerRows}
                width={drawerWidth}
                floating={drawerFloating}
                onHover={onDrawerHover}
                home={drawerHome}
                onNewProject={() => { closeOverlay(); setNewProjectOpen(true); }}
                onClose={closeOverlay}
                onResize={resizeDrawer}
                onToggleExpanded={toggleExpanded}
                onIntent={(vault, intent) => void trackedIntent(vault, intent)}
                onHistory={openHistory}
                onRelations={() => { if (activeVault) void trackedIntent(activeVault, { kind: 'page', page: 'relations' }); closeOverlay(); }}
                onMove={(name, delta) => reorder(moveAmong(projectOrder, drawerHidden, name, delta))}
                onDrop={(name, before) => reorder(dropInOrder(projectOrder, name, before))}
                onMoveWindow={(vault, windowId, before) => {
                  // Read now, not from the row: another window can take a project at any time, and
                  // the drawer's own answer waits for its next rebuild.
                  if (!mountedNames.includes(vault) && findWindowForVault(vault)) {
                    notify(`${vault}: ${t('shell.drawer.otherWindow')}`);
                    return;
                  }
                  // A mounted project holds its windows in memory and saves them itself; the
                  // roster of one that is not mounted is changed on disk.
                  if (mountedNames.includes(vault)) void queueDrawerIntent(vault, { kind: 'move-window', windowId, before });
                  else moveFarWindow(vault, windowId, before);
                }}
                onOpenInWindow={(name) => {
                  if (openRef.current.some((p) => p.vault === name)) void detachToWindow(name);
                  else void openVaultWindow(name).catch((err) => notify(`Couldn't open a window for ${name}: ${err instanceof Error ? err.message : String(err)}`));
                }}
                onCloseProject={(name) => closeTab(name)}
                {...(deviceShell ? {} : { onRemoveProject: (name: string) => { void removeProject(name); } })}
                hidden={drawerHidden}
                {...(deviceShell ? {} : { onHideProject: hideProject, onShowProject: showProject })}
                newWindowNonce={newWindowNonce}
                onSwitchMember={switchMember}
                onManage={manageMembers}
                {...(deviceShell ? { device: true } : {})}
                {...(tunnel ? { foot: <PhoneDrawerFoot /> } : {})}
                {...(deviceShell ? {} : {
                  sidebar: {
                    mode: sidebarModeNow,
                    navRows,
                    boardsOpen: drawerExpanded,
                    boards: boardEntries,
                    preparingVault: preparing?.vault ?? null,
                    boardQuery,
                    onBoardQuery: setBoardQuery,
                    onSwitch: (name: string) => switchTo(name),
                    onOpenBoard: (vault: string, slug: string) => goToPlace({ vault, kind: 'page', page: 'whiteboards', id: slug, label: null }),
                    onSettings: () => { if (activeVault) void queueDrawerIntent(activeVault, { kind: 'page', page: 'settings' }); },
                    setBoardsSlot,
                    setBoardsFootSlot,
                  },
                })}
              />
            )}
            <div className="window-chrome-body">
              {open.filter((p) => !p.cold).map((p) => (
                <ProjectInstance
                  key={p.instanceId}
                  vault={p.vault}
                  instanceId={p.instanceId}
                  isActive={p.vault === activeVault}
                  sidebarCollapsed={sidebarCollapsed}
                  onToggleSidebar={toggleSidebar}
                  onRollup={handleRollup}
                  pendingLink={pendingLinks[p.vault] ?? null}
                  onLinkConsumed={consumeLink}
                  pendingStart={pendingStarts[p.vault] ?? null}
                  onStartConsumed={consumeStart}
                  drawerToggleNonce={drawerToggleNonce}
                  drawerVisible={drawerVisible && !peekOnly}
                  onDrawerToggle={onDrawerToggle}
                  onDrawerDismiss={dismissFloating}
                  onDrawerFacts={handleDrawerFacts}
                  pendingDrawerIntent={pendingDrawerIntents[p.vault] ?? null}
                  onDrawerIntentConsumed={consumeDrawerIntent}
                  pendingManage={pendingManage[p.vault] ?? null}
                  onManageConsumed={consumeManage}
                  preparing={preparing && preparing.vault === p.vault && p.vault !== activeVault ? preparing.target : null}
                  onPrepared={handlePrepared}
                />
              ))}
            </div>
          </div>
          {/* History across projects (D7): a pick reopens the chat in ITS OWN project. */}
          <ChatHistoryPicker
            open={historyOpen}
            onClose={() => setHistoryOpen(false)}
            onPick={() => setHistoryOpen(false)}
            openIds={historyOpenIds}
            projects={projectOrder}
            currentVault={activeVault}
            {...(deviceShell ? { hiddenIds: deviceChats.hiddenIds, noSuper: true } : {})}
            onPickIn={(vault, s) => {
              setHistoryOpen(false);
              void trackedIntent(vault, { kind: 'open-session', sessionId: s.id });
            }}
          />
        </div>
        </ChromeSlotsProvider>
      </ChromeContext.Provider>
    );
  }

  return (
    <ChromeContext.Provider value={chrome}>
      <SelectionBar />
      <ChromeSlotsProvider value={chromeSlots}>
      <div className="window-chrome">
        <div className="window-chrome-banners" ref={bannersRef}>
          <UpgradeRelaunchBanner />
          <StaleServerBanner />
        </div>

        {/*
          This bar IS the title bar now. Drag and double-click-maximize are handled in JS
          rather than with `data-tauri-drag-region`: that attribute injects Tauri's own
          dblclick→toggleMaximize, which fires even with `dragDropEnabled: false` and fights
          our handler (and macOS native zoom) into a maximize/restore flicker — the reason
          `Header` dropped it. `startTitleBarDrag` already exempts every button, so a chip and
          the `+` are un-draggable and only the strip's empty space grabs the window.
        */}
        <div
          className="window-chrome-bar"
          // While a pick is held the strip comes forward and everything else in the bar steps
          // back, so the gesture is legible as a mode rather than as a chip that changed hue.
          data-picking={preview !== null ? 'true' : 'false'}
          onMouseDown={startTitleBarDrag}
          onDoubleClick={(e) => void toggleMaximizeWindow(e.target)}
        >
          {/* Everything left of the strip: the traffic-light clearance, then the active
              project's rail toggle + search pill (portalled in — see `chromeSlots.tsx`). */}
          <div className="window-chrome-left">
            <div className="window-chrome-inset" aria-hidden="true" />
            <div className="chrome-slot" ref={setLeftSlot} />
          </div>

          <ProjectTabs
            chips={chips}
            onActivate={(vault) => { markProjectSwitch(vault); activate(vault); }}
            onClose={closeTab}
            onAdd={openSwitcher}
            onDetach={(vault) => void detachToWindow(vault)}
          />

          {notice && <div className="window-chrome-notice" role="status">{notice}</div>}

          <div className="window-chrome-right">
            {/* The active project's sleep tracker + update badge land here. */}
            <div className="chrome-slot" ref={setRightSlot} />
            <HandsfreeButton vault={activeVault} />
            <ZoomMenu zoom={zoom} onZoom={setZoomLevel} />
            <button className="theme-toggle" onClick={cycleTheme} title={`Theme: ${themeLabel}`}>
              {resolved === 'dark' ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 1zm0 10a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 11zm7-3a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 15 8zM5 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 5 8zm7.07-4.07a.5.5 0 0 1 0 .71l-1.41 1.41a.5.5 0 1 1-.71-.71l1.41-1.41a.5.5 0 0 1 .71 0zM6.05 10.66a.5.5 0 0 1 0 .71l-1.41 1.41a.5.5 0 0 1-.71-.71l1.41-1.41a.5.5 0 0 1 .71 0zm7.72 3.12a.5.5 0 0 1-.71 0l-1.41-1.41a.5.5 0 1 1 .71-.71l1.41 1.41a.5.5 0 0 1 0 .71zM5.34 6.05a.5.5 0 0 1-.71 0L3.22 4.64a.5.5 0 0 1 .71-.71l1.41 1.41a.5.5 0 0 1 0 .71zM8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/*
          Every non-cold project, mounted at once. `isActive` decides which one is VISIBLE;
          it must never decide which one exists.
        */}
        <div className="window-chrome-body">
          {open.filter((p) => !p.cold).map((p) => (
            <ProjectInstance
              key={p.instanceId}
              vault={p.vault}
              instanceId={p.instanceId}
              isActive={p.vault === activeVault}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
              onRollup={handleRollup}
              pendingLink={pendingLinks[p.vault] ?? null}
              onLinkConsumed={consumeLink}
              pendingStart={pendingStarts[p.vault] ?? null}
              onStartConsumed={consumeStart}
            />
          ))}
        </div>

        {/* One switcher for the window, not one per project. */}
        <ProjectSwitcher />
      </div>
      </ChromeSlotsProvider>
    </ChromeContext.Provider>
  );
}
