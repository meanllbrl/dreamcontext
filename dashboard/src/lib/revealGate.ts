import type { Page } from '../components/layout/Sidebar';
import { isEndless } from './motionClock';

/**
 * Prepare, then activate (tek-kenar C2): a move to another project B never shows B half-made.
 * B is mounted (or kept) out of sight, its landing runs there, and the window makes it the
 * project on screen in ONE commit once it shows the target and nothing in the target's region is
 * loading or moving, or once the bound has run out. A pure state machine: the window injects the
 * clock and its timers, and feeds it what B reports per frame.
 *
 * The region helpers below are the ONE definition of where readiness is read; the seamless probe
 * (scripts/verify/tek-kenar-seamless.mjs) reads the same selectors, so the two cannot disagree.
 */

/** B already shows the target page: its landing is a short one. */
export const PREPARE_WARM_MS = 300;
/** B was mounted by this move, or shows another page or item. */
export const PREPARE_COLD_MS = 1500;
/** Frames in a row the target must read settled before the commit. */
export const SETTLED_FRAMES = 2;

/** The Shell's page frame (it never contains the agent surface). */
export const PAGE_REGION_SELECTOR = '[data-region="page"]';
/** The project's chat surface root. */
export const AGENT_SURFACE_SELECTOR = '.agent-surface';
/** Every node that draws a loading or not-yet-drawn state. */
export const LOADING_SELECTOR = '[data-loading]';

/** Where a prepare is going: the project's Chat, a page (with its item), or any page of it. */
export type PrepareTarget =
  | { kind: 'chat' }
  | { kind: 'page'; page: Page; id: string | null }
  | { kind: 'any' };

/** What the preparing project shows, read once per frame. */
export interface PrepareReport {
  page: Page;
  chatOpen: boolean;
  item: string | null;
  /** {@link regionSettled} for the target. */
  settled: boolean;
}

/** The region the target's readiness is read in, or null when it is not drawn. */
export function readinessRegion(root: ParentNode, target: PrepareTarget): Element | null {
  return root.querySelector(target.kind === 'chat' ? AGENT_SURFACE_SELECTOR : PAGE_REGION_SELECTOR);
}

function hasRunningMotion(el: Element | null): boolean {
  if (!el || typeof (el as Element & { getAnimations?: unknown }).getAnimations !== 'function') return false;
  return el.getAnimations({ subtree: true }).some((a) => a.playState === 'running' && !isEndless(a));
}

/** No loading marker in the region, nothing moving in it or on the agent surface, and the agent
 *  surface at the target's state (expanded for Chat; collapsed and not closing for a page). */
export function regionSettled(root: ParentNode, target: PrepareTarget): boolean {
  const region = readinessRegion(root, target);
  if (!region) return false;
  if (region.matches(LOADING_SELECTOR) || region.querySelector(LOADING_SELECTOR)) return false;
  const surface = root.querySelector(AGENT_SURFACE_SELECTOR);
  if (hasRunningMotion(region)) return false;
  if (surface && surface !== region && hasRunningMotion(surface)) return false;
  if (target.kind === 'chat') return !!surface?.classList.contains('expanded');
  return !surface || (!surface.classList.contains('expanded') && !surface.classList.contains('closing'));
}

/** B shows the target (its intent taken): Chat open for Chat; Chat closed, the page and its item
 *  for a page; anything for "any page". */
export function targetShown(target: PrepareTarget, report: PrepareReport, consumed: boolean): boolean {
  if (!consumed) return false;
  if (target.kind === 'any') return !report.chatOpen;
  if (target.kind === 'chat') return report.chatOpen;
  return !report.chatOpen && report.page === target.page && (!target.id || report.item === target.id);
}

export interface Prepare {
  id: number;
  vault: string;
  target: PrepareTarget;
  cold: boolean;
  startedAt: number;
  /** The queued intent's nonce, or null for "any page" (nothing queued). */
  nonce: number | null;
  consumed: boolean;
  /** The recorder's move this prepare lands. */
  moveId: number | null;
}

export interface RevealGateDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Make the prepare's project the one on screen (one commit). `why`: the target was shown and
   *  settled (`match`), or the bound ran out (`bound`). */
  onActivate: (p: Prepare, why: 'match' | 'bound') => void;
  /** A prepare ended without activation (cancelled or replaced). */
  onEnd?: (p: Prepare, why: 'cancel' | 'replaced') => void;
  /** The pending prepare changed (started, replaced, ended). */
  onChange?: (p: Prepare | null) => void;
}

export interface RevealGate {
  /** Start a prepare of `vault`. A second start for the vault already preparing keeps its id,
   *  its `cold` and its bound; another vault replaces it. */
  start(vault: string, target: PrepareTarget, opts: { cold: boolean; nonce: number | null; moveId: number | null }): Prepare;
  /** The queued intent `nonce` of `vault` was taken. */
  consumed(vault: string, nonce: number): void;
  /** One frame's report from the preparing project. */
  report(vault: string, r: PrepareReport): void;
  /** Cancel the pending prepare (input, another activation). */
  cancel(): Prepare | null;
  current(): Prepare | null;
  dispose(): void;
}

export function createRevealGate(deps: RevealGateDeps): RevealGate {
  let cur: Prepare | null = null;
  let timer: unknown = null;
  let frames = 0;
  let seq = 0;
  /** The last prepare that ended without activation: a re-prepare of the same B while its cold
   *  bound would still run stays cold (its instance may still be loading). */
  let lastEnded: { vault: string; cold: boolean; startedAt: number } | null = null;

  const stopTimer = () => { if (timer !== null) deps.clearTimer(timer); timer = null; };
  const end = (why: 'cancel' | 'replaced'): Prepare | null => {
    const p = cur;
    if (!p) return null;
    stopTimer();
    cur = null;
    frames = 0;
    lastEnded = { vault: p.vault, cold: p.cold, startedAt: p.startedAt };
    deps.onEnd?.(p, why);
    deps.onChange?.(null);
    return p;
  };
  const activate = (id: number, why: 'match' | 'bound') => {
    const p = cur;
    if (!p || p.id !== id) return;
    stopTimer();
    cur = null;
    frames = 0;
    lastEnded = null;
    deps.onActivate(p, why);
    deps.onChange?.(null);
  };
  const arm = (p: Prepare, remaining: number) => {
    stopTimer();
    const id = p.id;
    timer = deps.setTimer(() => { timer = null; activate(id, 'bound'); }, Math.max(0, remaining));
  };

  return {
    start(vault, target, opts) {
      if (cur && cur.vault === vault) {
        // The same B again (a second ⌘2, a row clicked twice): one prepare, its cold and bound.
        cur = { ...cur, target, nonce: opts.nonce, consumed: opts.nonce === null, moveId: opts.moveId ?? cur.moveId };
        frames = 0;
        deps.onChange?.(cur);
        return cur;
      }
      if (cur) end('replaced');
      seq += 1;
      const now = deps.now();
      const resumeCold = !!lastEnded && lastEnded.vault === vault && lastEnded.cold && now - lastEnded.startedAt < PREPARE_COLD_MS;
      const cold = opts.cold || resumeCold;
      const startedAt = resumeCold && lastEnded ? lastEnded.startedAt : now;
      const p: Prepare = {
        id: seq, vault, target, cold, startedAt,
        nonce: opts.nonce, consumed: opts.nonce === null, moveId: opts.moveId,
      };
      cur = p;
      frames = 0;
      arm(p, (cold ? PREPARE_COLD_MS : PREPARE_WARM_MS) - (now - startedAt));
      deps.onChange?.(p);
      return p;
    },
    consumed(vault, nonce) {
      if (cur && cur.vault === vault && cur.nonce === nonce && !cur.consumed) {
        cur = { ...cur, consumed: true };
      }
    },
    report(vault, r) {
      const p = cur;
      if (!p || p.vault !== vault) return;
      if (r.settled && targetShown(p.target, r, p.consumed)) {
        frames += 1;
        if (frames >= SETTLED_FRAMES) activate(p.id, 'match');
      } else {
        frames = 0;
      }
    },
    cancel: () => end('cancel'),
    current: () => cur,
    dispose() { stopTimer(); cur = null; },
  };
}

/** A key that is never input of its own (a bare modifier). */
export function isBareModifier(key: string): boolean {
  return key === 'Meta' || key === 'Alt' || key === 'Shift' || key === 'Control' || key === 'CapsLock' || key === 'Fn';
}

/** A pointer press that is not input in the project on screen: a primary press on a move control
 *  (`data-move`: project rows, other projects' board rows, ← →, the project label), or on the
 *  sidebar's own frame (`data-sidebar-frame`: its resize handle, the hover peek's frame), or on a
 *  scroll container itself (its scrollbar). */
export function isMovePress(target: EventTarget | null, button: number): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function' || typeof el.matches !== 'function') return false;
  if (button === 0 && el.closest('[data-move]')) return true;
  return el.matches('[data-sidebar-frame], [data-scroll-frame]');
}
