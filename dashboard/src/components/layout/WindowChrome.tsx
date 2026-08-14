import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useServerHealth } from '../../hooks/useServerHealth';
import { useSidebarCollapse } from '../../hooks/useSidebarCollapse';
import { useTheme } from '../../context/ThemeContext';
import { setChipActiveProbe } from '../../lib/attention';
import { setActiveOverlayScope } from '../../lib/overlayStack';
import {
  focusWindow,
  openVaultWindow,
  setGoToProjectHandler,
  startTitleBarDrag,
  toggleMaximizeWindow,
} from '../../lib/desktop';
import { HEARTBEAT_MS, findWindowForVault, publishOpenVaults, releaseWindow } from '../../lib/windowRegistry';
import type { ProjectRollup } from '../sleepy/agentStatus';
import { ProjectInstance } from '../../ProjectInstance';
import { ProjectSwitcher } from '../search/ProjectSwitcher';
import { UpgradeRelaunchBanner } from './UpgradeRelaunchBanner';
import { ChromeSlotsProvider, type ChromeSlots } from './chromeSlots';
import { ProjectTabs, type ProjectChip } from './ProjectTabs';
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

export interface ChromeApi {
  open: OpenProject[];
  activeVault: string;
  addTab(vault: string): Promise<AddTabResult>;
  activate(vault: string): void;
  closeTab(vault: string): void;
  detachToWindow(vault: string): Promise<void>;
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
};

const ChromeContext = createContext<ChromeApi>(DETACHED_CHROME);

/** This window's tab state and the operations on it; {@link DETACHED_CHROME} in the launcher. */
export function useChrome(): ChromeApi {
  return useContext(ChromeContext);
}

/* ─────────────────────────────── window-level chrome bits ─────────────────────────────── */

const ZOOM_LEVELS = [0.85, 0.9, 1.0, 1.1, 1.2];
const ZOOM_STORAGE_KEY = 'dreamcontext-zoom';

function getStoredZoom(): number {
  try {
    const stored = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (stored !== null) {
      const val = parseFloat(stored);
      if (ZOOM_LEVELS.includes(val)) return val;
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
function StaleServerBanner() {
  const { health, serverCurrent } = useServerHealth();
  if (!health || serverCurrent) return null;
  return (
    <div className="stale-server-banner">
      ⚠ The dashboard server is running an older build (
      {health.version ?? 'unknown'} vs {__DC_VERSION__}) — some actions will fail.
      Restart it: <code>dreamcontext dashboard</code>
    </div>
  );
}

/* ──────────────────────────────────── ceiling rules ──────────────────────────────────── */

/** Instances actually mounted right now (cold chips cost nothing). */
function liveInstanceCount(open: OpenProject[]): number {
  return open.reduce((n, p) => (p.cold ? n : n + 1), 0);
}

/**
 * The oldest instance it is SAFE to tear down, or null when there is none.
 *
 * The null-rollup case is the load-bearing one. `rollup === null` means the instance has not
 * published its state yet — freshly mounted, just revived from a cold chip, or (until T19
 * lands the publisher) simply never.
 * It does **not** mean idle. Reading null as "nothing running here" would tear down an
 * instance holding a live chat, killing its PTY mid-conversation, which is the single thing
 * this whole design is not allowed to do. So an instance is evictable only once it has said,
 * in its own words, that it has nothing live.
 *
 * The active instance is never a candidate either: the user is looking at it.
 *
 * Reads `alive`, never `live`. `live` is a PRESENTATION count for the chip badge — it
 * excludes shells on purpose, because a plain terminal has no agent behind it and isn't an
 * "active chat". A dev server or build watch running in a shell is exactly the kind of PTY
 * this ceiling must never kill, and it would report `live: 0` while still very much alive.
 * `alive` counts every session still holding a live PTY/WebSocket, shells included — it is
 * the only field allowed to gate a teardown.
 */
function oldestEvictable(open: OpenProject[], keep: readonly string[]): OpenProject | null {
  for (const p of open) {
    if (p.cold || keep.includes(p.vault)) continue;
    if (p.rollup !== null && p.rollup.alive === 0) return p;
  }
  return null;
}

/** Tear an instance down to a cold chip: it unmounts, its chip stays, its rollup is void. */
function chill(open: OpenProject[], vault: string): OpenProject[] {
  return open.map((p) => (p.vault === vault ? { ...p, cold: true, rollup: null } : p));
}

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

export function WindowChrome({ initialVault }: { initialVault: string }) {
  const { theme, setTheme, resolved } = useTheme();
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
  const chromeSlots = useMemo<ChromeSlots>(
    () => ({ left: leftSlot, right: rightSlot }),
    [leftSlot, rightSlot],
  );

  /**
   * One rail width for the whole window. Hoisted out of `Shell` because N instances each
   * running their own `useSidebarCollapse()` would read the shared key at mount and then
   * diverge the moment one of them toggled — two rails of different widths in one window.
   */
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapse();

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

  const setActive = useCallback((vault: string) => {
    activeRef.current = vault;
    setActiveState(vault);
  }, []);

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
        const victim = oldestEvictable(current, [vault, activeRef.current]);
        if (!victim) {
          notify(`Can't reopen ${vault} — every other project has a live session.`);
          return;
        }
        next = chill(next, victim.vault);
      }
      setOpen(next.map((p) => (
        p.vault === vault ? { ...p, cold: false, rollup: null, instanceId: mintInstanceId() } : p
      )));
    }

    setActive(vault);
  }, [mintInstanceId, notify, setActive, setOpen]);

  /**
   * The vault the ⌃Tab picker is currently POINTING AT, or null when the picker is down.
   * A preview, never a switch: nothing about the mounted instances changes while it is set.
   */
  const [preview, setPreviewState] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const setPreview = useCallback((vault: string | null) => {
    previewRef.current = vault;
    setPreviewState(vault);
  }, []);

  /**
   * ⌃Tab / ⌃⇧Tab walks the chip strip, in strip order, wrapping at both ends — as a HELD
   * pick, the way ⌘Tab works everywhere else on this machine.
   *
   * The shape is the point. Pressing ⌃Tab does not switch project; it opens a cursor on the
   * strip and moves it. Each further Tab (or ← / →) moves it again. The switch happens on the
   * RELEASE of Control, once — so walking four chips to the right one costs one switch instead
   * of four. That difference is not cosmetic here: a chip may be COLD, and switching to it
   * rebuilds a whole project instance (and can be refused at the ceiling). Under the old
   * press-to-switch shape, tabbing PAST a cold chip rebuilt it just to leave it again.
   *
   * NOT ⌘Tab, which is the combo the hand reaches for first: macOS gives it to the app
   * switcher before any web view is offered it, so it cannot be bound at all — `lib/sleepy.ts`
   * refuses it in `RESERVED_HOTKEYS` for exactly this reason. ⌃Tab is the in-window
   * equivalent every browser already uses for its own tabs.
   *
   * Listens on `window` in the CAPTURE phase, and that placement is the whole trick: a chip
   * can be picked while a terminal pane holds focus, and without capturing above it the same
   * keystroke would ALSO be written to the PTY. This is the second and last Ctrl chord the app
   * claims (`AgentSurface` has ⌃` for a new terminal) — every other one belongs to the shell.
   * The arrow keys are captured ONLY while the picker is up, i.e. only while Control is
   * physically held: outside that window they still belong entirely to whatever has focus.
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
      if (target === null || target === activeRef.current) return;
      if (!openRef.current.some((p) => p.vault === target)) return;
      activate(target);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.altKey) return;
      if (e.key === 'Tab' && e.ctrlKey) {
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
     * Fires on Control coming up, and — as a belt-and-braces second arm — on ANY key coming up
     * once `ctrlKey` has gone false, which is what a swallowed or reordered modifier release
     * looks like. Releasing Tab or Shift while Control is still down reports `ctrlKey: true`
     * and is correctly ignored, so a ⌃⇧Tab walk survives letting go of Shift mid-way.
     */
    const onKeyUp = (e: KeyboardEvent) => {
      if (previewRef.current === null) return;
      if (e.key !== 'Control' && e.ctrlKey) return;
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
  }, [activate, setPreview]);

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
      const victim = oldestEvictable(current, [activeRef.current]);
      if (!victim) {
        notify(`${MAX_LIVE_INSTANCES} projects are open and all of them have a live session — close one first.`);
        return 'refused-ceiling';
      }
      next = chill(next, victim.vault);
      notify(`${victim.vault} was idle, so it was put to sleep to make room. Click its chip to reopen it.`);
    }

    // 4. Room to grow.
    setOpen([...next, { vault, instanceId: mintInstanceId(), cold: false, rollup: null }]);
    setActive(vault);
    return 'added';
  }, [activate, mintInstanceId, notify, setActive, setOpen]);

  const closeTab = useCallback((vault: string) => {
    const current = openRef.current;
    if (current.length <= 1) {
      notify('This window always keeps one project open.');
      return;
    }
    const index = current.findIndex((p) => p.vault === vault);
    if (index === -1) return;

    const next = current.filter((p) => p.vault !== vault);
    setOpen(next);

    if (activeRef.current === vault) {
      // Prefer the chip that took its place, then walk left; skip cold chips so closing a tab
      // never lands the user on a blank body.
      const searchOrder = [...next.slice(index), ...next.slice(0, index).reverse()];
      setActive((searchOrder.find((p) => !p.cold) ?? searchOrder[0]).vault);
    }
  }, [notify, setActive, setOpen]);

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

  const chrome = useMemo<ChromeApi>(
    () => ({ open, activeVault, addTab, activate, closeTab, detachToWindow }),
    [open, activeVault, addTab, activate, closeTab, detachToWindow],
  );

  const chips = useMemo<ProjectChip[]>(() => open.map((p) => ({
    vault: p.vault,
    active: p.vault === activeVault,
    // Where a released ⌃ would land. Independent of `active`, and on the SAME chip until the
    // first ⌃Tab moves it — "you are here" and "you would go here" are two different claims.
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
    // TODO(T19): the bounce has exactly one writer, and it is not this memo. The sink above
    // holds the state a bounce is derived FROM (`waiting` crossing 0→>0); T19 owns turning
    // that edge into a nonce, alongside the publisher that makes the edge happen at all.
    bounceNonce: 0,
  })), [open, activeVault, preview]);

  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);
  const changeZoom = (delta: -1 | 1) => {
    const nextIndex = zoomIndex + delta;
    if (nextIndex < 0 || nextIndex >= ZOOM_LEVELS.length) return;
    const next = ZOOM_LEVELS[nextIndex];
    setZoom(next);
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(next)); } catch { /* ignore */ }
  };

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

  return (
    <ChromeContext.Provider value={chrome}>
      <ChromeSlotsProvider value={chromeSlots}>
      <div className="window-chrome">
        <UpgradeRelaunchBanner />
        <StaleServerBanner />

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
            onActivate={activate}
            onClose={closeTab}
            onAdd={openSwitcher}
            onDetach={(vault) => void detachToWindow(vault)}
          />

          {notice && <div className="window-chrome-notice" role="status">{notice}</div>}

          <div className="window-chrome-right">
            {/* The active project's sleep tracker + update badge land here. */}
            <div className="chrome-slot" ref={setRightSlot} />
            <div className="zoom-controls">
              <button className="zoom-btn" onClick={() => changeZoom(-1)} disabled={zoomIndex <= 0} title="Zoom out">-</button>
              <span className="zoom-label">{Math.round(zoom * 100)}%</span>
              <button className="zoom-btn" onClick={() => changeZoom(1)} disabled={zoomIndex >= ZOOM_LEVELS.length - 1} title="Zoom in">+</button>
            </div>
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
