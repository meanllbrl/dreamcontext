import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { SuperContainer } from '../../../lib/superTypes';
import { getWindowActivity } from '../../../lib/windowActivity';
import { playSuperCue } from '../../../lib/superSfx';
import type { ChatSession } from '../chatSession';
import type { CardPlan, StagePlan } from './superLayout';
import { CUE_MS, cueOf, holdsNewCards, revealStep, type SuperCueKind } from './superCues';

/** A cue on one card: its kind and, for a delegated card, where it flies in from (the surface
 *  measures dx/dy on the plan it draws, so a cue that lands before the new card's plan still
 *  flies from the centre). */
export interface StageCue { kind: SuperCueKind; dx: number; dy: number; at: number }

/** A card that just left the record, still drawn while it fades (its last plan, and whether its
 *  web frame was live, so the fade shows the page and not the Load placeholder). */
export interface LeavingCard { container: SuperContainer; plan: CardPlan; webLive: boolean; at: number; index: number }

/**
 * The cards to draw: the record's, with each fading card put back at the index it had, so React
 * keeps its DOM node where it was (moving a node that holds an iframe reloads the page, and the
 * fade would show a blank frame). Pure.
 */
export function withGhosts<T extends { id: string }>(cards: readonly T[], ghosts: ReadonlyArray<{ card: T; index: number }>): T[] {
  const live = new Set(cards.map((c) => c.id));
  const out = [...cards];
  for (const g of [...ghosts].filter((x) => !live.has(x.card.id)).sort((a, b) => a.index - b.index)) {
    out.splice(Math.min(Math.max(0, g.index), out.length), 0, g.card);
  }
  return out;
}

/**
 * The stage's cues and its reveal gate (jarvis plan r9 G1, AC16), beside the surface so the
 * surface's own file only wires three props:
 *  - `held`: new cards waiting to appear (drawn invisible in their spot meanwhile);
 *  - `cueFor(id)`: the one-time animation a card plays right now;
 *  - `leaving`: closed cards still fading out.
 * Sounds go through `playSuperCue`, which stays quiet while the owner types or a spoken answer
 * plays.
 */
export function useStageCues(opts: {
  containers: readonly SuperContainer[];
  /** The plan this render draws, and the web cards holding a live frame in it. Refs, filled by
   *  the surface once its plan exists: the plan itself waits on `held` (a half page that has not
   *  appeared yet keeps the stage floating), so this hook runs before it is computed. */
  planRef: { readonly current: StagePlan | null };
  liveWebRef: { readonly current: ReadonlySet<string> };
  superSession: ChatSession | undefined;
  dragging: boolean;
  /** The card the SERVER put side by side on its own (`view.auto`), or null. */
  autoHalf: string | null;
}): { held: ReadonlySet<string>; autoHalfHeld: boolean; cueFor: (id: string) => StageCue | undefined; leaving: readonly LeavingCard[] } {
  const { containers, planRef, liveWebRef, superSession, dragging, autoHalf } = opts;
  const [cues, setCues] = useState<ReadonlyMap<string, StageCue>>(new Map());
  const [held, setHeld] = useState<string[]>([]);
  const [leaving, setLeaving] = useState<LeavingCard[]>([]);
  const known = useRef<Map<string, SuperContainer> | null>(null);
  const lastPlans = useRef<Record<string, CardPlan>>({});
  const lastLiveWeb = useRef<ReadonlySet<string>>(new Set());

  // A closed card becomes its ghost IN THE SAME RENDER it leaves the record (state adjusted
  // during render), so React keeps the card's instance under its key: no remount of its view
  // for the fade, and a web card keeps its frame.
  const [seenContainers, setSeenContainers] = useState(containers);
  if (containers !== seenContainers) {
    const ids = new Set(containers.map((c) => c.id));
    const gone = seenContainers.flatMap((c, index) => (!ids.has(c.id) && lastPlans.current[c.id] && lastPlans.current[c.id].where !== 'others' ? [{ c, index }] : []));
    setSeenContainers(containers);
    const at = Date.now();
    setLeaving((prev) => {
      const kept = prev.filter((g) => !ids.has(g.container.id));
      return gone.length || kept.length !== prev.length
        ? [...kept, ...gone.map(({ c, index }) => ({ container: c, plan: lastPlans.current[c.id], webLive: lastLiveWeb.current.has(c.id), at, index }))]
        : prev;
    });
  }
  useEffect(() => {
    if (!leaving.length) return undefined;
    const t = setTimeout(() => setLeaving((prev) => prev.filter((g) => Date.now() - g.at < CUE_MS)), CUE_MS);
    return () => clearTimeout(t);
  }, [leaving]);
  const lastReveal = useRef(0);
  const speaking = useRef(false);
  /** A verb's cue for a card that is still held: played when it appears. */
  const owed = useRef(new Map<string, SuperCueKind>());

  useEffect(() => superSession?.onSpeaking?.((on) => { speaking.current = on; }), [superSession]);

  const typedAt = useCallback(() => superSession?.typedAt?.() ?? 0, [superSession]);

  const sound = useCallback((kind: SuperCueKind) => {
    const a = getWindowActivity();
    playSuperCue(kind, { speaking: speaking.current, typedAt: typedAt(), focused: a.focused, now: Date.now() });
  }, [typedAt]);

  const cue = useCallback((ids: readonly string[], kind: SuperCueKind) => {
    if (!ids.length) return;
    const now = Date.now();
    setCues((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, { kind, dx: 0, dy: 0, at: now });
      return next;
    });
    setTimeout(() => setCues((prev) => {
      const next = new Map(prev);
      for (const id of ids) if (next.get(id)?.at === now) next.delete(id);
      return next.size === prev.size ? prev : next;
    }), CUE_MS);
  }, []);

  // New and closed cards, against the last record this window saw.
  useLayoutEffect(() => {
    const now = new Map(containers.map((c) => [c.id, c] as const));
    const before = known.current;
    known.current = now;
    if (!before) return;
    const fresh = containers.filter((c) => !before.has(c.id)).map((c) => c.id);
    if (!fresh.length) return;
    const blocked = holdsNewCards({ dragging, typedAt: typedAt(), now: Date.now() });
    setHeld((prev) => {
      if (blocked || prev.length) return [...prev, ...fresh.filter((id) => !prev.includes(id))];
      // Not held: an automatic card (no verb announces it) gets the arrival highlight now.
      const auto = fresh.filter((id) => now.get(id)?.by === 'auto' && !owed.current.has(id));
      if (auto.length) { cue(auto, 'arrive'); sound('arrive'); }
      // A verb's cue that landed before its card did: the card plays it as it appears.
      for (const id of fresh) {
        const k = owed.current.get(id);
        if (k) { owed.current.delete(id); cue([id], k); }
      }
      return prev;
    });
  }, [containers, dragging, typedAt, cue, sound]);

  // Every render: the refs carry this render's plan by the time layout effects run.
  useLayoutEffect(() => {
    const plan = planRef.current;
    if (!plan) return;
    const next: Record<string, CardPlan> = {};
    for (const [id, cp] of Object.entries(plan.cards)) next[id] = cp;
    lastPlans.current = next;
    lastLiveWeb.current = liveWebRef.current;
  });

  // The gate opens: one held card at a time, REVEAL_GAP_MS apart.
  useEffect(() => {
    if (!held.length) return undefined;
    const step = revealStep({ pending: held, dragging, typedAt: typedAt(), lastRevealAt: lastReveal.current, now: Date.now() });
    if (step.reveal) {
      const id = step.reveal;
      lastReveal.current = Date.now();
      const kind = owed.current.get(id) ?? 'arrive';
      owed.current.delete(id);
      cue([id], kind);
      sound(kind);
      setHeld((prev) => prev.filter((x) => x !== id));
      return undefined;
    }
    // Typing holds keep moving: look again shortly even without a scheduled wake.
    const wait = step.wakeAt ? Math.max(16, step.wakeAt - Date.now()) : 250;
    const t = setTimeout(() => setHeld((prev) => [...prev]), wait);
    return () => clearTimeout(t);
  }, [held, dragging, typedAt, cue, sound]);

  // A verb landed (the server's `super_cue`): its cards play its cue, once, with its sound.
  useEffect(() => {
    if (!superSession) return undefined;
    return superSession.onSuper((sig) => {
      if (sig.kind !== 'cue') return;
      const kind = cueOf(sig.verb);
      if (!kind) return;
      const heldNow = new Set(heldRef.current);
      const seen = known.current;
      // Held cards, and cards whose state has not been drawn yet (the cue can land first), owe it.
      const shown = sig.ids.filter((id) => !heldNow.has(id) && (!seen || seen.has(id)));
      for (const id of sig.ids) if (!shown.includes(id) && kind !== 'close') owed.current.set(id, kind);
      // A close's cards are already gone: their fade is the leaving ghost.
      if (kind !== 'close') cue(shown, kind);
      if (shown.length || kind === 'close' || kind === 'merge' || kind === 'answer') sound(kind);
    });
  }, [superSession, cue, sound]);
  const heldRef = useRef(held);
  heldRef.current = held;

  // A card new in THIS render is held now, by the same rule the layout effect above applies a
  // moment later: the surface plans on it (a page put side by side while the owner types waits,
  // with the stage still floating), and no frame is laid out for a card that is not there yet.
  const before = known.current;
  const fresh = before ? containers.filter((c) => !before.has(c.id) && !held.includes(c.id)).map((c) => c.id) : [];
  const holdFresh = fresh.length > 0 && (held.length > 0 || holdsNewCards({ dragging, typedAt: typedAt(), now: Date.now() }));
  const heldSet = new Set(holdFresh ? [...held, ...fresh] : held);

  // A page the server puts side by side on its own (a dev server, a child's browser, also one
  // coming back from Others, which is not new to the record) waits the same way: while the owner
  // types or drags, the stage stays floating; it switches once he pauses (G1). The owner's and
  // the agent's own views are never held.
  const shownAuto = useRef<string | null>(autoHalf);
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  const autoHalfHeld = autoHalf !== null && autoHalf !== shownAuto.current
    && holdsNewCards({ dragging, typedAt: typedAt(), now: Date.now() });
  useEffect(() => {
    if (autoHalf === null) { shownAuto.current = null; return undefined; }
    if (autoHalf === shownAuto.current) return undefined;
    if (!autoHalfHeld) { shownAuto.current = autoHalf; return undefined; }
    const t = setTimeout(recheck, 250);
    return () => clearTimeout(t);
  });
  return { held: heldSet, autoHalfHeld, cueFor: (id) => cues.get(id), leaving };
}
