import { samePlace, type Place, type PlaceHistory } from '../../lib/placeHistory';

/**
 * The window's ONE observer of the screen (navigation B, C3): the only caller of the place
 * history's `record` and of its step commits. A pure state machine; the window injects the clock
 * and the timers and feeds it two things:
 *
 *  - what the ACTIVE project shows (`shown`), each report saying whether the owner caused it
 *    (`byOwner`: he navigated inside the project) or a landing did;
 *  - every move the window starts (`move`, `step`): a badge, a card row, a ⌘K hit, a switch, a
 *    drawer row, a link, ← →. Each carries its target.
 *
 * A place is recorded only once it has stayed on screen for {@link SETTLE_MS} with no move in
 * flight, so a quick hop is not a stop. While a move is in flight a place that differs from its
 * target never ends it: it ends on its target (recorded once, or the step committed), a refusal,
 * the owner's own navigation, a newer move, or its bound.
 */
export const SETTLE_MS = 400;
/** A move to a page place. */
export const PAGE_MOVE_MAX_MS = 5_000;
/** A move to a project's Chat: at least AgentSurface's `LINKED_SESSION_WAIT_MS` +
 *  `ARRIVAL_SLACK_MS` (a drift test reads both), the longest a chat surface takes to come up. */
export const CHAT_MOVE_MAX_MS = 20_000;

/** Where a move is going: a place, or (`place: null`) any place of that project and kind. */
export interface MoveTarget {
  vault: string;
  kind: 'page' | 'chat';
  place: Place | null;
}

export function targetOf(place: Place): MoveTarget {
  return { vault: place.vault, kind: place.kind, place };
}

export function targetMatches(target: MoveTarget, place: Place | null): boolean {
  if (!place || place.vault !== target.vault || place.kind !== target.kind) return false;
  return target.place ? samePlace(target.place, place) : true;
}

export interface RecorderDeps {
  history: PlaceHistory;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Something the back/forward buttons read changed. */
  onChange?: () => void;
}

export interface NavRecorder {
  /** The active project shows `place`. */
  shown(place: Place, byOwner: boolean): void;
  /** A window move toward `target`; returns its id. */
  move(target: MoveTarget): number;
  /** ← (-1) or → (1); null when there is nowhere to go. `onReplaced` runs when a newer move
   *  replaces this step before it lands (its queued intent is dropped there). */
  step(direction: -1 | 1, skip: (p: Place) => boolean, onReplaced?: () => void): { id: number; target: Place } | null;
  /** The move's project could not be brought back (the ceiling). */
  refused(id: number): void;
  /** Another window holds the move's project: it came forward and nothing lands here. */
  focusedWindow(id: number): void;
  /** Tests and the window's diagnostics. */
  inFlight(): MoveTarget | null;
  dispose(): void;
}

interface Move {
  id: number;
  target: MoveTarget;
  step: boolean;
  timer: unknown;
  /** A place that settled under the move without being its target. */
  settledUnder: Place | null;
  onReplaced?: () => void;
}

export function createNavRecorder(deps: RecorderDeps): NavRecorder {
  const { history, setTimer, clearTimer } = deps;
  const changed = () => deps.onChange?.();
  let current: Place | null = null;
  let settled = false;
  let settleTimer: unknown = null;
  let move: Move | null = null;
  let seq = 0;

  const stopSettle = () => {
    if (settleTimer !== null) clearTimer(settleTimer);
    settleTimer = null;
  };

  /** The move reached its target and it settled. */
  const finish = (m: Move, place: Place) => {
    clearTimer(m.timer);
    move = null;
    if (m.step) history.commitStepAt(place);
    else history.record(place);
    changed();
  };

  /** The move ends without its target (the owner moved, a newer move): a step goes back, and
   *  what had already settled under it is recorded first. */
  const endUnfinished = (m: Move) => {
    clearTimer(m.timer);
    move = null;
    if (m.step) history.abortStep();
    if (m.settledUnder) history.record(m.settledUnder);
    changed();
  };

  const onSettle = () => {
    settleTimer = null;
    settled = true;
    const place = current;
    if (!place) return;
    if (move) {
      if (targetMatches(move.target, place)) finish(move, place);
      else move.settledUnder = place;
      return;
    }
    history.record(place);
    changed();
  };

  const onBound = (m: Move) => {
    if (move !== m) return;
    move = null;
    const place = settled ? current : m.settledUnder;
    if (m.step) {
      // The project is the unit (A1): a chat step whose project settled on a page commits there.
      const sameProject = !!place && place.vault === m.target.vault && (place.kind === m.target.kind || m.target.kind === 'chat');
      if (place && sameProject) history.commitStepAt(place);
      else {
        history.abortStep();
        if (place) history.record(place);
      }
    } else if (place) {
      history.record(place);
    }
    changed();
  };

  const start = (target: MoveTarget, step: boolean, onReplaced?: () => void): Move => {
    seq += 1;
    const m: Move = { id: seq, target, step, timer: null, settledUnder: null, onReplaced };
    m.timer = setTimer(() => onBound(m), target.kind === 'chat' ? CHAT_MOVE_MAX_MS : PAGE_MOVE_MAX_MS);
    move = m;
    // Already there (a move to the place on screen): it ends at once.
    if (settled && targetMatches(target, current)) finish(m, current as Place);
    return m;
  };

  return {
    shown(place, byOwner) {
      stopSettle();
      current = place;
      settled = false;
      if (move && byOwner && !targetMatches(move.target, place)) endUnfinished(move);
      settleTimer = setTimer(onSettle, SETTLE_MS);
    },
    move(target) {
      if (move) {
        if (move.step) move.onReplaced?.();
        endUnfinished(move);
      }
      return start(target, false).id;
    },
    step(direction, skip, onReplaced) {
      // A newer move ends a non-step one first (what settled under it is recorded).
      if (move && !move.step) endUnfinished(move);
      const next = direction < 0 ? history.peekBack(skip) : history.peekForward(skip);
      if (!next) return null;
      if (move) {
        // ← again before the first landed: the walk goes on from it, its origin kept.
        clearTimer(move.timer);
        move.onReplaced?.();
        move = null;
      }
      const begun = history.beginStep(direction, skip);
      if (!begun) return null;
      const m = start(targetOf(begun.target), true, onReplaced);
      changed();
      return { id: m.id, target: begun.target };
    },
    refused(id) {
      if (!move || move.id !== id) return;
      const m = move;
      clearTimer(m.timer);
      move = null;
      if (m.step) history.abortStep();
      changed();
    },
    focusedWindow(id) {
      if (!move || move.id !== id) return;
      const m = move;
      clearTimer(m.timer);
      move = null;
      if (m.step) history.commitStep();
      changed();
    },
    inFlight: () => move?.target ?? null,
    dispose() {
      stopSettle();
      if (move) clearTimer(move.timer);
      move = null;
    },
  };
}
