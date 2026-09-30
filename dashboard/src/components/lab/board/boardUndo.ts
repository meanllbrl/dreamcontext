import type { BoardSpec } from './boardTypes';

/**
 * THE BOARD'S UNDO STACK: whole specs, not diffs.
 *
 * Every edit the page makes is the board's whole next spec (the save queue
 * wants exactly that), so undo is the same move backwards: `record(before)`
 * on each edit, `undo(current)` hands back the spec to save and remembers
 * `current` for redo. A new edit after an undo drops the redo branch, as every
 * editor does.
 *
 * The stack belongs to ONE board and one rev line. A 409 (someone else wrote
 * the file) makes every remembered spec a rewrite of a file that no longer
 * exists, so the page clears it; switching boards clears it too. Depth is
 * capped so a long drag session cannot grow it without bound.
 */

export const UNDO_DEPTH = 50;

export interface UndoStack {
  /** An edit is about to replace `before`. */
  record: (before: BoardSpec) => void;
  /** The spec to go back to (and `current` joins redo), or null when there is nothing to undo. */
  undo: (current: BoardSpec) => BoardSpec | null;
  /** The spec to go forward to (and `current` joins undo), or null. */
  redo: (current: BoardSpec) => BoardSpec | null;
  clear: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

export function createUndoStack(depth = UNDO_DEPTH): UndoStack {
  let past: BoardSpec[] = [];
  let future: BoardSpec[] = [];
  const cap = (list: BoardSpec[]) => (list.length > depth ? list.slice(list.length - depth) : list);
  return {
    record(before) {
      past = cap([...past, before]);
      future = [];
    },
    undo(current) {
      const prev = past[past.length - 1];
      if (!prev) return null;
      past = past.slice(0, -1);
      future = cap([...future, current]);
      return prev;
    },
    redo(current) {
      const next = future[future.length - 1];
      if (!next) return null;
      future = future.slice(0, -1);
      past = cap([...past, current]);
      return next;
    },
    clear() {
      past = [];
      future = [];
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  };
}

/** ⌘Z / Ctrl+Z = undo, ⇧⌘Z / Ctrl+Y = redo; never while typing in a field. */
export function undoKey(e: {
  key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean;
  target?: EventTarget | null;
}): 'undo' | 'redo' | null {
  if (e.altKey || !(e.metaKey || e.ctrlKey)) return null;
  const el = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tag = el?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return null;
  const key = e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && e.ctrlKey && !e.metaKey) return 'redo';
  return null;
}

/**
 * WHOSE REV IS THIS? The undo stack is only valid against revs this page
 * wrote itself. A refetch (a sync tick invalidating `['lab']`, window focus)
 * can bring a rev someone else wrote: an agent's `lab board set`, the CLI, a
 * brain-sync pull. Undoing then would PUT an old spec with that NEW rev, and
 * the server would accept it: a silent overwrite of their change. So every
 * rev the page sees goes through `observe`, and a rev that is neither the one
 * it already knew nor the one its own last save produced clears the stack.
 *
 * While one of our PUTs is in flight the answer waits (`saving`): a refetch
 * can land our own new rev before the PUT's response has told us it is ours.
 * The next observation, once idle, decides.
 */
export interface RevGuard {
  /** 'clear' = the stack must be emptied now. */
  observe: (rev: string | null, ctx: { slug: string | null; ownRev: string | null; saving: boolean }) => 'keep' | 'clear';
  /** A board switch: forget the rev (the stack is cleared with it). */
  reset: () => void;
}

export function createRevGuard(): RevGuard {
  let known: string | null = null;
  let knownSlug: string | null = null;
  return {
    observe(rev, { slug, ownRev, saving }) {
      if (slug !== knownSlug) {
        // Another board: its first rev is the baseline (its stack starts empty).
        knownSlug = slug;
        known = null;
      }
      if (rev === null || saving) return 'keep';
      if (known === null || rev === known) {
        known = rev;
        return 'keep';
      }
      known = rev;
      return rev === ownRev ? 'keep' : 'clear';
    },
    reset() {
      known = null;
      knownSlug = null;
    },
  };
}

/**
 * After a Move to board finishes: a move spans TWO boards and the stack holds
 * ONE, so it is never recorded (undoing just the source half would leave the
 * card on both boards). The history before it no longer composes with the
 * source's new cards either, so the source's stack is cleared: but only when
 * the source is still the board on screen. A move that finishes after the
 * user switched boards must not touch the new board's stack.
 */
export function settleMoveUndo(stack: Pick<UndoStack, 'clear'>, from: string, activeNow: string | null): boolean {
  if (from !== activeNow) return false;
  stack.clear();
  return true;
}
