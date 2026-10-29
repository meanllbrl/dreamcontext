import { useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { CONTAINER_SIZES, nextGroupName, type ContainerSize, type SuperContainer as Container, type SuperGroup, type SuperStateView } from '../../../lib/superTypes';
import { armPointerDrag } from '../tabDrag';
import type { Rect } from './handoverMotion';
import {
  dropTargetAt, isGroupId, overCentre, overOthersZone, posFromRect, sizeOf, sizePx, type LayoutPatch, type StagePlan,
} from './superLayout';

/**
 * The preset a corner drag asks for (owner 2026-10-22): the card's size grown by the pointer's
 * travel (away from the centre on the left side, so `dx` counts negative there), snapped to the
 * nearest preset that can be drawn now. Pure, so the gesture and its test agree.
 */
export function snapSize(
  from: { width: number; height: number }, dx: number, dy: number, side: 'left' | 'right', fits: (size: ContainerSize) => boolean,
): ContainerSize {
  const w = from.width + (side === 'left' ? -dx : dx);
  const h = from.height + dy;
  let best: ContainerSize = 'small';
  let bestD = Infinity;
  for (const size of CONTAINER_SIZES) {
    if (size !== 'small' && !fits(size)) continue;
    const px = sizePx(size);
    const d = Math.abs(px.width - w) + Math.abs(px.height - h);
    if (d < bestD) { bestD = d; best = size; }
  }
  return best;
}

export interface DragState {
  id: string;
  /** The card's rect when the drag began (stage coordinates). */
  rect: Rect;
  /** The record the drag began over: a push that changes it pins the card (D1). */
  base: readonly Container[];
  /** Dragged out of an open panel (a ghost follows the pointer, not the card). */
  fromOthers: boolean;
}

/** A new group's id (the server keeps it): never a container id, those start with their kind. */
const newGroupId = () => `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export type Hot = 'centre' | 'others' | null;

/** What the gestures read at the moment they happen: the surface refreshes it on every render. */
export interface StageDragDeps {
  rootRef: RefObject<HTMLDivElement | null>;
  layerRef: RefObject<HTMLDivElement | null>;
  planRef: RefObject<StagePlan>;
  stateRef: RefObject<SuperStateView>;
  byId: ReadonlyMap<string, Container>;
  groupsById: ReadonlyMap<string, SuperGroup>;
  titleOf: (c: Container) => string;
  onLayout: (patch: LayoutPatch) => void;
  actions: { onAskAbout: (id: string) => void };
  liftOnTop: (id: string) => void;
  setOpenGroup: (id: string | null) => void;
  /** "Group" in the owner's language: a new group's default name is "<word> N". */
  groupWord: string;
  /** The owner's size for a card (the menu and the corner handle). */
  /** `pin`: the corner gesture, the card grows where it is drawn (its inner top corner held). */
  onSize: (id: string, size: ContainerSize, pin?: boolean) => void;
  /** Whether a size can be drawn for this card on the stage now (`pin`: grown where it is drawn). */
  canFit: (id: string, size: ContainerSize, pin?: boolean) => boolean;
  /** The resize outline's words when the size it reaches cannot be drawn (owner's language). */
  noRoom: string;
}

/**
 * The stage's two gestures (F6, FE1, D1, 2026-10-20 groups): a FLOATING card (or group) held and
 * moved, and a card pressed in an open panel. Both release on the centre (ask), the Others corner,
 * another tile (group) or the stage (a drop). Hit tests are arithmetic on the plan, never
 * `elementFromPoint`; the held card moves by transform only.
 */
export function useStageDrag(depsRef: RefObject<StageDragDeps | null>) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hot, setHot] = useState<Hot>(null);
  const [target, setTarget] = useState<string | null>(null);
  // A card dragged out of the open panel: the panel stays MOUNTED (the dragged item holds the
  // pointer capture; unmounting it would cancel the drag), drawn invisible until the release.
  const [panelDrag, setPanelDrag] = useState(false);
  const deps = () => depsRef.current!;

  /** A card released on another: a new group standing where the target stood, or into a group. */
  const groupOnto = (held: string, onto: string) => {
    const { byId, stateRef, onLayout, groupWord } = deps();
    // A card brought out of Others stops being put aside: if its group ever dissolves it floats.
    const out = byId.get(held)?.place === 'others' ? { cards: [{ id: held, place: 'float' as const }] } : {};
    if (isGroupId(onto)) onLayout({ ...out, group: { id: onto, cards: [held] } });
    else onLayout({ ...out, group: { id: newGroupId(), cards: [onto, held], name: nextGroupName(stateRef.current.groups, groupWord) } });
  };

  /** Where a release lands: the centre (ask), the Others corner, or the stage (a drop). */
  const hotAt = (p: StagePlan, x: number, y: number): Hot => (overCentre(p, x, y) ? 'centre' : overOthersZone(p, x, y) ? 'others' : null);


  const onPressCard = (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
    const { rootRef, planRef, stateRef, onLayout, actions, liftOnTop } = deps();
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input, textarea, select')) return;
    const el = e.currentTarget;
    const root = rootRef.current;
    const card = planRef.current.cards[id];
    if (!root || !card || card.where !== 'float') return;
    let origin = root.getBoundingClientRect();
    let last: Hot = null;
    let lastTarget: string | null = null;
    let ddx = 0;
    let ddy = 0;
    armPointerDrag({ pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY }, el, {
      win: window,
      onBegin: () => {
        origin = root.getBoundingClientRect();
        // A settle still running on this card gives way to the hand that took it.
        for (const a of el.getAnimations?.() ?? []) a.cancel();
        el.dataset.lifted = 'true';
        flushSync(() => setDrag({ id, rect: card.rect, base: stateRef.current.containers, fromOthers: false }));
      },
      onRemeasure: () => { origin = root.getBoundingClientRect(); },
      onFrame: (x, y, dx, dy) => {
        ddx = dx;
        ddy = dy;
        const h = hotAt(planRef.current, x - origin.left, y - origin.top);
        // Over another tile it would group with: the held card shrinks a little toward it.
        // Outside the float view a tile is a live job's rail tile: no group target there.
        const tg = h || planRef.current.mode !== 'float' ? null : dropTargetAt(planRef.current, x - origin.left, y - origin.top, id);
        // A slight lift, kept centred on the card (origin top-left, F6).
        const k = tg ? 0.94 : 1.02;
        el.style.transform = `translate(${dx - (card.rect.width * (k - 1)) / 2}px, ${dy - (card.rect.height * (k - 1)) / 2}px) scale(${k})`;
        if (h !== last) { last = h; setHot(h); }
        if (tg !== lastTarget) { lastTarget = tg; setTarget(tg); }
      },
      onEnd: (drop, x, y) => {
        setHot(null);
        setTarget(null);
        const p = planRef.current;
        const h = drop ? hotAt(p, x - origin.left, y - origin.top) : null;
        // A live job's rail tile beside a page or a presentation (superLayout): only the centre
        // and Others take its drop; a drop elsewhere is no move (no hidden position, no group).
        const floatView = p.mode === 'float';
        const tg = drop && !h && floatView ? dropTargetAt(p, x - origin.left, y - origin.top, id) : null;
        if (drop && h === 'centre') actions.onAskAbout(id);
        else if (drop && h === 'others') onLayout({ cards: [{ id, place: 'others' }] });
        else if (drop && tg) groupOnto(id, tg);
        else if (drop && floatView) {
          const r = { ...card.rect, x: card.rect.x + ddx, y: card.rect.y + ddy };
          onLayout({ cards: [{ id, pos: posFromRect(p.free, r), place: 'float' }] });
          liftOnTop(id);
        }
        // The same batch clears the drag: StageMotion swaps the lift for the settle (FE2).
        setDrag(null);
      },
    });
  };

  /**
   * A card pressed in an open panel (a group's or Others'): a ghost the size of a tile follows the
   * pointer, the panel closes so the stage is the target. Released on the stage it floats there
   * (and leaves its group); on the centre it asks; on another tile it groups; in the Others corner
   * it goes (or stays) aside. A group in Others is dragged out the same way.
   */
  const onPressPanelItem = (e: ReactPointerEvent<HTMLElement>, id: string, from: string) => {
    const { rootRef, layerRef, planRef, stateRef, byId, groupsById, titleOf, onLayout, actions, liftOnTop, setOpenGroup } = deps();
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const root = rootRef.current;
    const layer = layerRef.current;
    const c = byId.get(id);
    const g = groupsById.get(id);
    if (!root || !layer || (!c && !g)) return;
    let origin = root.getBoundingClientRect();
    let ghost: HTMLElement | null = null;
    let last: Hot = null;
    let lastTarget: string | null = null;
    // The ghost is the card's own drawn size (a sized card dropped from a panel lands where it is
    // drawn); a group is one tile.
    const box = sizePx(c ? sizeOf(c) : 'small');
    const at = (x: number, y: number): Rect => ({ x: x - origin.left - box.width / 2, y: y - origin.top - box.height / 2, ...box });
    const targetAt = (x: number, y: number) => {
      // Outside the float view a tile is a live job's rail tile: no group target there (as onPressCard).
      if (planRef.current.mode !== 'float') return null;
      const tg = dropTargetAt(planRef.current, x - origin.left, y - origin.top, id);
      return tg && tg !== from ? tg : null;
    };
    armPointerDrag({ pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY }, el, {
      win: window,
      onBegin: () => {
        origin = root.getBoundingClientRect();
        setPanelDrag(true);
        ghost = document.createElement('div');
        ghost.className = 'super-standin super-standin--card super-drag-ghost';
        ghost.textContent = c ? titleOf(c) : g!.name;
        ghost.style.width = `${box.width}px`;
        ghost.style.height = `${box.height}px`;
        layer.appendChild(ghost);
        flushSync(() => setDrag({ id, rect: at(e.clientX, e.clientY), base: stateRef.current.containers, fromOthers: true }));
      },
      onRemeasure: () => { origin = root.getBoundingClientRect(); },
      onFrame: (x, y) => {
        const r = at(x, y);
        if (ghost) ghost.style.transform = `translate(${r.x}px, ${r.y}px)`;
        const h = hotAt(planRef.current, x - origin.left, y - origin.top);
        const tg = h ? null : targetAt(x, y);
        if (h !== last) { last = h; setHot(h); }
        if (tg !== lastTarget) { lastTarget = tg; setTarget(tg); }
      },
      onEnd: (drop, x, y) => {
        ghost?.remove();
        ghost = null;
        setHot(null);
        setTarget(null);
        setPanelDrag(false);
        setOpenGroup(null);
        const p = planRef.current;
        const h = drop ? hotAt(p, x - origin.left, y - origin.top) : null;
        const tg = drop && !h ? targetAt(x, y) : null;
        // A card out of Others or the rail's "more" tile (owner 2026-10-28) is in no group: nothing to leave.
        const leave = from !== 'others' && from !== 'more' ? { leave: [id] } : {};
        if (drop && h === 'centre') actions.onAskAbout(id);
        else if (drop && h === 'others') { if (from !== 'others') onLayout({ ...leave, cards: [{ id, place: 'others' }] }); }
        else if (drop && tg) groupOnto(id, tg);
        // A job out of the rail's "more" tile exists only beside a page or a presentation: a drop
        // elsewhere there is no move (no hidden position for when the view ends).
        else if (drop && from === 'more' && p.mode !== 'float') { /* no move */ }
        else if (drop && dropTargetAt(p, x - origin.left, y - origin.top, id) !== from) {
          onLayout({ ...leave, cards: [{ id, place: 'float', pos: posFromRect(p.free, at(x, y)) }] });
          liftOnTop(id);
        }
        setDrag(null);
      },
    });
  };

  /**
   * A floating card's corner handle (owner 2026-10-22): drag to a size. An outline at the snapped
   * preset follows, grown from the card's inner top corner (the one toward the centre); release
   * writes the size only when it changed. Esc, a cancel or a lost pointer writes nothing.
   * A preset the stage cannot draw now (the centre chat would lose its floor) is still where the
   * outline goes, marked "no room", and its release writes nothing (owner 2026-10-29: "Agenda
   * büyümüyor?", the outline stuck at the card's own size said nothing).
   */
  const onPressResize = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    const { rootRef, layerRef, planRef, byId, onSize, canFit, noRoom } = deps();
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget;
    const root = rootRef.current;
    const layer = layerRef.current;
    const card = planRef.current.cards[id];
    const c = byId.get(id);
    if (!root || !layer || !c || !card || card.where !== 'float') return;
    const side: 'left' | 'right' = card.rect.x + card.rect.width / 2 < planRef.current.centre.x + planRef.current.centre.width / 2 ? 'left' : 'right';
    const from = card.size ?? sizeOf(c);
    let snapped: ContainerSize = from;
    let fits = true;
    let outline: HTMLElement | null = null;
    // What can be drawn does not change during the gesture: asked once (a plan per size), not
    // on every pointer frame.
    let fitting = new Set<ContainerSize>();
    const place = (size: ContainerSize) => {
      if (!outline) return;
      const px = sizePx(size);
      const x = side === 'left' ? card.rect.x + card.rect.width - px.width : card.rect.x;
      outline.style.transform = `translate(${x}px, ${card.rect.y}px)`;
      outline.style.width = `${px.width}px`;
      outline.style.height = `${px.height}px`;
      outline.dataset.size = size;
      outline.dataset.fits = fits ? 'true' : 'false';
      outline.dataset.side = side;
      // The note sits at the outline's inner edge (toward the centre), which stays on the stage.
      outline.replaceChildren();
      if (!fits) {
        const note = document.createElement('span');
        note.className = 'super-resize-note';
        note.setAttribute('role', 'status');
        note.textContent = noRoom;
        // As wide as the part of the outline still on the stage (a left card grows off its edge).
        const onStage = side === 'left' ? Math.min(px.width, x + px.width) : Math.min(px.width, layer.clientWidth - x);
        note.style.maxWidth = `${Math.max(96, onStage - 24)}px`;
        outline.appendChild(note);
      }
    };
    armPointerDrag({ pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY }, el, {
      win: window,
      onBegin: () => {
        fitting = new Set(CONTAINER_SIZES.filter((size) => size === 'small' || canFit(id, size, true)));
        // The surface's own Esc (AgentSurface) yields while a resize is held, as it does to a drag.
        root.dataset.resizing = 'true';
        outline = document.createElement('div');
        outline.className = 'super-resize-outline';
        outline.setAttribute('data-testid', 'super-resize-outline');
        layer.appendChild(outline);
        place(from);
      },
      onRemeasure: () => {},
      onFrame: (_x, _y, dx, dy) => {
        const next = snapSize(card.rect, dx, dy, side, () => true);
        const ok = next === 'small' || fitting.has(next);
        if (next !== snapped || ok !== fits) { snapped = next; fits = ok; place(next); }
      },
      onEnd: (drop) => {
        delete root.dataset.resizing;
        outline?.remove();
        outline = null;
        if (drop && fits && snapped !== from) onSize(id, snapped, true);
      },
    });
  };

  return { drag, hot, target, panelDrag, onPressCard, onPressPanelItem, onPressResize };
}
