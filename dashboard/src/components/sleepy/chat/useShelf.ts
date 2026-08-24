import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseChatActions } from './chatActions';
import {
  foldViews, layoutShelf, type ShelfEntry, type ShelfFact, type ShelfLayout,
} from '../../../lib/shelfModel';
import { readPins, writePins } from '../../../lib/pinStore';
import { newlyTicked } from '../../../lib/progressModel';
import {
  useSessionFacts, useTaskProgress, type ProgressCriterion, type TaskProgress,
} from '../../../hooks/useAgentCapabilities';
import type { ChatViewSpec } from '../../../lib/chatViewSpec';
import type { ChatSession } from '../chatSession';

/**
 * The shelf's state, assembled from four sources that must not fight:
 *
 *   1. the STORE      — what this conversation pinned before the page was reloaded,
 *   2. the TRANSCRIPT — `pin`/`progress` blocks in messages that have finished streaming,
 *   3. the SERVER     — branch + worktree, polled (the user never has to ask the agent),
 *   4. the USER       — what is open, what was dismissed, what was promoted back.
 *
 * Every RULE lives in `lib/shelfModel.ts` (pure, unit-tested); this hook only feeds it and
 * holds the React state. Nothing here reads scroll position, and that is deliberate: the
 * shelf's defining property is that it does not move, and a surface that cannot observe a
 * scroll gesture cannot react to one.
 *
 * ── Why the transcript is scanned incrementally ──────────────────────────────────────────
 * A restored conversation replays its whole history, so a naive "re-derive from every message
 * on every render" would (a) re-parse hundreds of messages per token and (b) stamp every pin
 * with a fresh `updatedAt`, which is exactly the field that decides who owns the one open row
 * — a reload would silently reshuffle the shelf. So: the store is the seed, every item present
 * at mount is marked consumed on the FIRST render, and only messages that arrive afterwards
 * are parsed. `parseChatActions` runs once per finished message, never per token.
 *
 * Only `done` text items are read. A half-streamed fence is not a pin yet, and `ChatTextItem`
 * already carries the flag that says so — no timers, no busy-edge bookkeeping.
 */

/** Everything `PinShelf` needs, and nothing it would have to derive itself. */
export interface ShelfHandle {
  layout: ShelfLayout;
  /** The SERVER-derived session facts, as handed to `layoutShelf`. */
  facts: ShelfFact[];
  /** The one open detail — a long pin's in-place panel, or the progress popover. One at a
   *  time, so the shelf's height is predictable and two panels never overlap. */
  openId: string | null;
  setOpenId: (id: string | null) => void;
  /** True when the shelf is currently more than its resting tag line — the composer's
   *  `shelved` prop and the shell's `has-rows` class are the same question. The progress
   *  POPOVER is deliberately not part of it: it floats, so it adds no row to be shelved. */
  hasRows: boolean;
  /** Remove a pin (and, if it was the open one, close it). */
  dismiss: (tagOrEntryId: string) => void;
  /** A demoted `⌃` chip was clicked: give it the newest timestamp so it wins the row back. */
  promote: (entryId: string) => void;
  /** The live reading behind a `progress` row, or null when no run owns the row. */
  progress: TaskProgress | null;
  /** `criterionKey`s of criteria that flipped ticked within the flash window — the panel's
   *  "you just saw that happen" set. Empty on the first reading of a run. */
  justTicked: ReadonlySet<string>;
  /** Whether the TURN is actually running. The live treatment keys off this rather than off
   *  the panel being open: a settled run's row goes quiet and lets its clock say when it last
   *  moved, instead of animating over a task nobody is working on. */
  live: boolean;
  /** How many pins this conversation has evicted past the cap — reported, never silent. */
  evicted: number;
}

/**
 * How long a newly-ticked criterion stays highlighted. Comfortably longer than the 4s poll, so
 * a tick is never applied and expired between two frames the user could have been looking at.
 *
 * Expiry is evaluated when the NEXT payload lands rather than on a timer, so the flash outlives
 * this window by up to one poll. That slack is deliberate and it costs nothing visually: the
 * CSS animation is what fades the highlight and the label, and it runs on its own clock (see
 * `progressPanel.css`). Paying for a second interval here — one that re-renders the whole pane
 * every second — to make a purely decorative expiry exact would be the wrong trade.
 */
const FLASH_MS = 6_000;

/**
 * A tag's id is `<entryId>#<factIndex>` for a fact chip and the bare entry id for a demoted
 * row (see `shelfModel.factTag`). Pin ids cannot contain `#` (`validatePin` holds them to
 * `[A-Za-z0-9._-]`), so the last `#` is an unambiguous separator.
 */
export function entryIdOf(tagId: string): string {
  const at = tagId.lastIndexOf('#');
  return at === -1 ? tagId : tagId.slice(0, at);
}

export function useShelf(session: ChatSession, vault: string | null): ShelfHandle {
  const conv = session.getModel();
  const conversationId = session.claudeId;
  // `''` rather than a fallback vault name: `pinStore` treats an unscoped call as "no pins"
  // instead of writing into a key two projects could share.
  const scope = vault ?? '';
  const connected = session.status === 'open';

  const [entries, setEntries] = useState<ShelfEntry[]>(() => readPins(scope, conversationId));
  const [evicted, setEvicted] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  // Read by the scan effect, which computes the next list from the CURRENT one without going
  // through a state updater — a `setState(fn)` whose body also called `setEvicted` would be a
  // reducer with a side effect, and React is allowed to run those twice.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // Seeded during the first render, not in an effect: by the time an effect ran, the scan
  // below would already have re-derived every pin the store just restored.
  const consumedRef = useRef<Set<string> | null>(null);
  if (consumedRef.current === null) {
    consumedRef.current = new Set(conv.items.map((i) => i.id));
  }

  // ── 2. New finished messages → shelf entries ────────────────────────────────────────
  const items = conv.items;
  useEffect(() => {
    const consumed = consumedRef.current;
    if (!consumed) return;
    const fresh: ChatViewSpec[] = [];
    for (const item of items) {
      if (item.kind !== 'text' || !item.done || consumed.has(item.id)) continue;
      consumed.add(item.id);
      for (const view of parseChatActions(item.text).views) {
        if (view.type === 'pin' || view.type === 'progress') fresh.push(view);
      }
    }
    if (fresh.length === 0) return;
    const { entries: next, evicted: dropped } = foldViews(entriesRef.current, fresh, Date.now());
    entriesRef.current = next;
    setEntries(next);
    if (dropped > 0) setEvicted((n) => n + dropped);
  }, [items]);

  // ── 1. Persistence ──────────────────────────────────────────────────────────────────
  // `writePins` debounces internally, so this may fire per applied event without one
  // serialize per token.
  useEffect(() => {
    writePins(scope, conversationId, entries);
  }, [scope, conversationId, entries]);

  // ── 3. Server-derived session facts ─────────────────────────────────────────────────
  // Scoped to THIS conversation, not to the vault: the session moves (EnterWorktree), and a
  // vault-wide cache entry showed every pane whichever checkout answered last.
  const factsQuery = useSessionFacts(connected, conversationId || null);
  const factsData = factsQuery.data;
  const facts = useMemo<ShelfFact[]>(() => {
    if (!factsData?.isRepo) return [];
    const out: ShelfFact[] = [];
    if (factsData.branch) out.push({ label: factsData.branch, icon: 'branch' });
    // The NAME when the server knows it, the bare word otherwise. "worktree" answers a
    // question nobody with one open is asking; "which one" is the useful fact, and a
    // pre-`worktreeName` server (or an unnamed root) still gets the marker it had.
    if (factsData.worktree) {
      out.push({ label: factsData.worktreeName || 'worktree', marker: true, icon: 'worktree' });
    }
    return out;
  }, [factsData]);

  const layout = useMemo(() => layoutShelf(entries, facts), [entries, facts]);

  // ── The progress reading behind the row, when a run owns it ─────────────────────────
  const progressTask = layout.row?.kind === 'progress' ? layout.row.task : null;
  const progress = useTaskProgress(progressTask, connected).data ?? null;

  // ── Liveness: which criteria flipped between two readings ──────────────────────────
  // The complaint this answers is not that the number was wrong — it is that nothing on the
  // panel ever moved, so a run that had stalled looked exactly like one that was working
  // (owner, 2026-08-24). Which criteria just ticked is derived by diffing successive payloads
  // (`newlyTicked`, pure and unit-tested), so the server is asked for nothing it was not
  // already sending and no timer runs here at all.
  //
  // The OTHER half of the liveness — the clock that ticks every second — deliberately does NOT
  // live in this hook. `useShelf` is called by `ChatPane`, so a per-second state change here
  // would re-render the entire pane, transcript included, for the sake of one changing word.
  // It lives in `ProgressRow` instead, which is a leaf and exists only while a progress row
  // does. See `useSecondTick` in PinShelf.tsx.
  const [flashes, setFlashes] = useState<{ key: string; at: number }[]>([]);
  const prevCriteria = useRef<ProgressCriterion[]>([]);

  // A different task is a different run: its first reading is the state of the world, not a
  // burst of things that just happened. Both the baseline and the flashes reset with the slug.
  useEffect(() => {
    prevCriteria.current = [];
    setFlashes([]);
  }, [progressTask]);

  useEffect(() => {
    const next = progress?.criteria ?? [];
    const fresh = newlyTicked(prevCriteria.current, next);
    prevCriteria.current = next;
    const at = Date.now();
    setFlashes((prev) => {
      const kept = prev.filter((f) => at - f.at < FLASH_MS);
      // Identity-stable when nothing changed: a poll that reports no movement must not produce
      // a new array, or every 4s tick of an idle run would re-render the shelf for nothing.
      if (fresh.length === 0) return kept.length === prev.length ? prev : kept;
      return [...kept, ...fresh.map((key) => ({ key, at }))];
    });
  }, [progress]);

  const justTicked = useMemo(() => new Set(flashes.map((f) => f.key)), [flashes]);

  // M3: when the run ENDS the row closes and the tag line stays. "Ends" is the conjunction of
  // both signals — every criterion ticked on disk AND the turn settled. While the turn is
  // still running, an all-ticked task keeps its row and says so through the route's notice,
  // so the two M3 bullets hold at the same time rather than one hiding the other.
  useEffect(() => {
    if (!progressTask || progress?.state !== 'all-done' || session.busy) return;
    const id = `progress:${progressTask}`;
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setOpenId((cur) => (cur === id ? null : cur));
  }, [progressTask, progress?.state, session.busy]);

  // ── 4. User actions ─────────────────────────────────────────────────────────────────
  // Dismissal is a REMOVAL, not a tombstone: a later message re-sending the same `id` brings
  // the pin back, because that is the agent explicitly re-asserting it. Nothing else in the
  // list is touched, so no other pin moves.
  const dismiss = useCallback((tagOrEntryId: string) => {
    const id = entryIdOf(tagOrEntryId);
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setOpenId((cur) => (cur === id ? null : cur));
  }, []);

  const promote = useCallback((entryId: string) => {
    const at = Date.now();
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, updatedAt: at } : e)));
  }, []);

  const hasRows = layout.row !== null;

  return {
    layout, facts, openId, setOpenId, hasRows,
    dismiss, promote, progress, justTicked, live: session.busy, evicted,
  };
}
