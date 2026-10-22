import { createHash } from 'node:crypto';
import { MAX_CONTAINERS, MAX_FLOAT, atLeastSize, floatCount, isPageKind, minSizeFor, type ContainerKind, type SuperContainer, type SuperState } from './types.js';
import type { SuperSignal } from './signals.js';

/**
 * The cards the SERVER opens and settles on its own (jarvis plan r9, §3 S1-S3, noise rules
 * G2-G6), as pure edits of a draft record: no timer, no I/O, `now` is a parameter. The caller
 * (`agent-chat.ts` for a frame, `inbox.ts` for idle/gone) runs them inside the locked write.
 *
 *  - G2: an automatic card never touches the owner's dropped card (`pos`) or a card the view
 *    shows (half / present). The one view it sets is its own (owner 2026-10-22, "it should have
 *    shown it directly"): a new page (a dev server, a child's browser) goes side by side when
 *    the stage floats or shows another automatic page, marked `auto`; only such a view may be
 *    taken back by automation, when its page settles. The owner's or the agent's view stays.
 *  - G3: at most AUTO_FLOAT_BUDGET automatic cards float at once; a third sends the oldest to
 *    Others. A full stage puts the new card straight into Others; a full record skips it.
 *  - G4: one `browser` card per child, one `web` card per url: a repeat is the same card.
 *  - G5: a card the owner closed is not reopened automatically for DISMISS_MS.
 *  - G6: a card the owner dragged (`pos`) is never moved to Others by automation.
 */

export const AUTO_FLOAT_BUDGET = 2;
export const DISMISS_MS = 10 * 60_000;
/** A child's live browser goes to Others after this long idle with no new browser call. */
export const BROWSER_IDLE_MS = 60_000;

/** Same id rule as `containerIdFor` in inbox.ts (kept here so this module stays I/O-free). */
export function autoContainerId(kind: ContainerKind, ref: string): string {
  return `${kind}-${createHash('sha1').update(ref).digest('hex').slice(0, 12)}`;
}

const inView = (s: SuperState, id: string): boolean =>
  (s.view.mode === 'half' && s.view.card === id && !s.view.auto) || (s.view.mode === 'present' && (s.view.cards ?? []).includes(id));

/** The page automation put side by side leaves it: the stage floats again. */
function releaseAutoView(s: SuperState, id: string): void {
  if (s.view.mode === 'half' && s.view.card === id && s.view.auto) s.view = { mode: 'float' };
}

/** A new or returning page goes side by side, unless the owner or the agent set the view. */
function showAuto(s: SuperState, c: SuperContainer): void {
  if (c.place !== 'float' || !isPageKind(c.kind)) return;
  if (s.view.mode === 'float' || (s.view.mode === 'half' && s.view.auto)) s.view = { mode: 'half', card: c.id, auto: true };
}

/** A page is never smaller than large, unless the owner sized it. */
function sizeAuto(c: SuperContainer): void {
  if (c.sizeBy === 'owner') return;
  const next = atLeastSize(c.size ?? 'small', minSizeFor(c.kind));
  if (next !== 'small') c.size = next;
}

const grouped = (s: SuperState): Set<string> => new Set(s.groups.flatMap((g) => g.cards));

/** May automation move this card? Not the owner's drop, not a viewed card, not a card the owner
 *  or the agent put in a group (its tile is the group's) (G2, G6). */
const movable = (s: SuperState, c: SuperContainer): boolean => !c.pos && !inView(s, c.id) && !grouped(s).has(c.id);

function dismissed(s: SuperState, kind: ContainerKind, ref: string, now: number): boolean {
  return s.dismissed.some((d) => d.kind === kind && d.ref === ref && d.until > now);
}

/** G3: keep at most AUTO_FLOAT_BUDGET automatic cards floating; `keep` is the one just opened. */
function enforceBudget(s: SuperState, keep: string): void {
  const inGroup = grouped(s);
  const floating = s.containers.filter((c) => c.by === 'auto' && c.place === 'float' && !inGroup.has(c.id));
  let over = floating.length - AUTO_FLOAT_BUDGET;
  for (const c of floating) {
    if (over <= 0) break;
    if (c.id === keep || !movable(s, c)) continue;
    releaseAutoView(s, c.id);
    c.place = 'others';
    over -= 1;
  }
}

/** Open (or bring back) an automatic card. True when the record changed. */
function openAuto(s: SuperState, kind: ContainerKind, ref: string, child: string, now: number): boolean {
  const id = autoContainerId(kind, ref);
  const have = s.containers.find((c) => c.id === id);
  if (have) {
    // G4: the same card. An automatic one resting in Others comes back when it is live again.
    if (have.by !== 'auto' || have.place === 'float' || grouped(s).has(id) || dismissed(s, kind, ref, now)) return false;
    if (floatCount(s) >= MAX_FLOAT) return false;
    have.place = 'float';
    sizeAuto(have);
    showAuto(s, have);
    enforceBudget(s, id);
    return true;
  }
  if (dismissed(s, kind, ref, now)) return false;
  if (s.containers.length >= MAX_CONTAINERS) return false;
  const place = floatCount(s) < MAX_FLOAT ? 'float' : 'others';
  // A site card is titled by its host and port (`localhost:5173`): a full URL breaks in a 1:1 tile.
  let title: string | undefined;
  if (kind === 'web') { try { title = new URL(ref).host; } catch { title = undefined; } }
  const card: SuperContainer = { id, kind, ref, shape: kind === 'web' ? 'tall' : 'square', place, by: 'auto', of: child, ...(title ? { title } : {}) };
  sizeAuto(card);
  s.containers.push(card);
  showAuto(s, card);
  if (place === 'float') enforceBudget(s, id);
  return true;
}

/**
 * A child's signal on the draft record. `signal.url` must already be a web ref the super
 * `web` rule accepts (the caller validates it against the owned ports). True when changed.
 */
export function applySignal(s: SuperState, child: string, signal: SuperSignal, now: number): boolean {
  if (!s.enabled || !Object.prototype.hasOwnProperty.call(s.children, child)) return false;
  switch (signal.kind) {
    case 'browser':
      return openAuto(s, 'browser', child, child, now);
    case 'devserver':
      return openAuto(s, 'web', signal.url, child, now);
    case 'devserver-drop': {
      let changed = false;
      for (const c of s.containers) {
        if (c.by === 'auto' && c.kind === 'web' && c.of === child && c.place === 'float' && movable(s, c)) { releaseAutoView(s, c.id); c.place = 'others'; changed = true; }
      }
      return changed;
    }
  }
}

/**
 * A child settled. `idle` (its browser quiet for BROWSER_IDLE_MS): its live browser card goes
 * to Others. `gone` (it really ended): its browser card closes (no frames will come), its chat
 * card and its other automatic cards go to Others. Never the owner's drop, never a viewed card.
 */
export function settleChild(s: SuperState, child: string, how: 'idle' | 'gone', _now: number): boolean {
  let changed = false;
  const browserId = autoContainerId('browser', child);
  if (how === 'idle') {
    const b = s.containers.find((c) => c.id === browserId);
    if (b && b.place === 'float' && movable(s, b)) { releaseAutoView(s, b.id); b.place = 'others'; changed = true; }
    return changed;
  }
  const b = s.containers.find((c) => c.id === browserId);
  if (b && movable(s, b)) {
    releaseAutoView(s, b.id);
    s.containers = s.containers.filter((c) => c.id !== browserId);
    changed = true;
  }
  for (const c of s.containers) {
    const mine = (c.kind === 'chat' && c.ref === child) || (c.by === 'auto' && c.of === child);
    if (mine && c.place === 'float' && movable(s, c)) { releaseAutoView(s, c.id); c.place = 'others'; changed = true; }
  }
  return changed;
}

/** The owner closed cards: each automatic one is remembered for DISMISS_MS (G5). */
export function noteDismissed(s: SuperState, closed: readonly SuperContainer[], now: number): void {
  for (const c of closed) {
    if (c.by !== 'auto') continue;
    s.dismissed = s.dismissed.filter((d) => !(d.kind === c.kind && d.ref === c.ref));
    s.dismissed.push({ kind: c.kind, ref: c.ref, until: now + DISMISS_MS });
  }
}
