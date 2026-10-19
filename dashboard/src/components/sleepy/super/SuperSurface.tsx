import {
  Component, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { isLightMode } from '../../../lib/lightMode';
import { MAX_CONTAINERS, type SuperContainer as Container, type SuperStateView } from '../../../lib/superTypes';
import { SleepyMascot } from '../SleepyMascot';
import { armPointerDrag } from '../tabDrag';
import type { ChatSession } from '../chatSession';
import { planLayoutMotion, type Rect, type StageBox } from './handoverMotion';
import { prefersReducedMotion, runLayoutMotion, type LayoutRun } from './motionRunner';
import { OthersStack, type OthersItem } from './OthersStack';
import { QueueStrip } from './QueueStrip';
import { SuperContainer, chatStatus, useLiveSession } from './SuperContainer';
import { TerminalsRow, type TerminalRowItem } from './TerminalsRow';
import {
  STAGE, heightOf, overCentre, overOthersZone, planStage, posFromRect,
  type LayoutPatch, type StagePlan,
} from './superLayout';
import { needsOwner, ownerQueueCount, queueHead, shownChild } from './superHandover';
import { liveWebIds, touchLru, dropFromLru } from './webBudget';
import './SuperSurface.css';

export { runFlights, prefersReducedMotion, type FlightRun } from './motionRunner';

export interface SuperSurfaceProps {
  state: SuperStateView;
  /** The surface's size at the press: the first render's guess (it measures itself before paint). */
  initialWidth: number;
  initialHeight: number;
  /** The overlay is expanded and the window not hidden: motion runs and web cards may hold a frame. */
  visible: boolean;
  /** Landing targets still waiting for their hand-over flight (`'centre'` or a card id). */
  pending: ReadonlySet<string>;
  motion: 'running' | 'idle';
  superSession: ChatSession | undefined;
  vault: string;
  sessionFor: (claudeId: string) => ChatSession | undefined;
  titleFor: (claudeId: string) => string;
  terminals: readonly TerminalRowItem[];
  /** The owner's gesture, as the server's patch (F3, §0 C3). */
  onLayout: (patch: LayoutPatch) => void;
  onTerminal: (sid: string) => void;
  onReplyToSuper: () => void;
  onOpenPage: (page: 'tasks' | 'knowledge' | 'core' | 'whiteboards', id: string) => void;
  /** The slots the surface homes sessions into were (re)created: re-run the placement. */
  onSlotsChanged: () => void;
  /** The stage measured itself (at the folded width) and drew the plan the flights land on (FE4). */
  onStageReady: (stage: { origin: DOMRect; plan: StagePlan }) => void;
  /** O11: the owner dropped a card on the centre (or pressed its "Ask about this"). */
  onAskAbout: (id: string, title: string) => void;
}

interface DragState {
  id: string;
  /** The card's rect when the drag began (stage coordinates). */
  rect: Rect;
  /** The record the drag began over: a push that changes it pins the card (D1). */
  base: readonly Container[];
  /** Dragged out of the Others fan (a ghost follows the pointer, not the card). */
  fromOthers: boolean;
}

type Hot = 'centre' | 'others' | null;

/**
 * The hand-over screen (plan-r8, owner decisions O1-O11): Claude in the cape EXACTLY in the
 * centre — the Super Agent's own chat, homed into `[data-super-slot="centre"]` by AgentSurface's
 * placement, as a pane homes a session — every other card floating around it, the queue pill
 * above, the terminals dock and the Others stack below. Everything is placed absolutely from
 * `planStage`; `StageMotion` animates every change of that plan.
 *
 * Nothing polls: the state is pushed (`super_state`) and handed down; the cards read the
 * children's live sessions. The owner's gestures go up through `onLayout` as patches.
 */
export function SuperSurface(props: SuperSurfaceProps) {
  const { state, pending, motion, superSession, onLayout, onSlotsChanged } = props;
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const underRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLButtonElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── The stage's size: measured before the first paint; resizes SNAP (FE4) ──
  const [size, setSize] = useState({ width: props.initialWidth, height: props.initialHeight });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const read = () => ({ width: el.clientWidth, height: el.clientHeight });
    const differs = (m: { width: number; height: number }) => m.width !== sizeRef.current.width || m.height !== sizeRef.current.height;
    const first = read();
    if (differs(first)) setSize(first);
    if (typeof ResizeObserver === 'undefined') return undefined;
    // One callback per frame at most (the observer's own cadence), flushed before that frame
    // paints, so the stage never shows a frame laid out for the old size.
    const ro = new ResizeObserver(() => { const m = read(); if (differs(m)) flushSync(() => setSize(m)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── The drag (F6, FE1, D1) ──
  const [drag, setDrag] = useState<DragState | null>(null);
  // The card dropped last paints on top of the other dropped cards, for this window's session.
  // (A drop never reorders the record: that would move every other card to the other side.)
  const [topped, setTopped] = useState<string[]>([]);
  const liftOnTop = (id: string) => setTopped((prev) => [...prev.filter((x) => x !== id), id]);
  const [hot, setHot] = useState<Hot>(null);
  const pinned = useMemo(
    () => (drag && !drag.fromOthers && state.containers !== drag.base ? { id: drag.id, rect: drag.rect } : null),
    [drag, state.containers],
  );

  // ── The plan ──
  const prevCentre = useRef<number | null>(null);
  const plan = useMemo(
    () => planStage(state.containers, state.view, size, { dragging: pinned, prevCentre: prevCentre.current }),
    [state.containers, state.view, size, pinned],
  );
  const planRef = useRef(plan);
  planRef.current = plan;
  useLayoutEffect(() => { prevCentre.current = plan.centreWidth; }, [plan]);

  // ── Stage ready: the flights land on THIS plan, measured at the folded width (FE4) ──
  const readyRef = useRef(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (readyRef.current || !el || el.clientWidth <= 0) return;
    if (el.clientWidth !== size.width || el.clientHeight !== size.height) return;  // a re-render with the measured size follows
    readyRef.current = true;
    props.onStageReady({ origin: el.getBoundingClientRect(), plan });
  });

  // ── Card views wait for the hand-over to land ──
  // A card's view (a whiteboard's Excalidraw, a web page's frame, a task, a note, an image)
  // fetches and lays itself out as it mounts; one Excalidraw mount restyles the whole document
  // (35-54 ms measured with a 300-task board in the project). Under a flight that is a dropped
  // frame, so the views mount once the choreography is over; until then a card shows its head.
  // Latched: a view that mounted stays mounted.
  const [viewsReady, setViewsReady] = useState(motion === 'idle');
  useEffect(() => { if (motion === 'idle') setViewsReady(true); }, [motion]);

  const byId = useMemo(() => new Map(state.containers.map((c) => [c.id, c] as const)), [state.containers]);
  const titleOf = useCallback((c: Container) => (c.kind === 'chat' ? props.titleFor(c.ref) : c.title || c.ref), [props.titleFor]);

  // ── The shown slot: the ONE child chat mounted besides the centre (F11, D10) ──
  const shownRef = shownChild(state);
  const shownCard = shownRef
    ? state.containers.find((c) => c.kind === 'chat' && c.ref === shownRef && ['half', 'present', 'sheet'].includes(plan.cards[c.id]?.where ?? ''))
    : undefined;
  const shownKey = shownCard ? `${shownCard.id}:${plan.cards[shownCard.id].where}` : '';
  useLayoutEffect(() => { onSlotsChanged(); }, [shownKey, onSlotsChanged]);

  // ── The web budget: at most two live frames, most recently loaded first ──
  const [lru, setLru] = useState<string[]>([]);
  const webOnScreen = props.visible
    ? state.containers.filter((c) => c.kind === 'web' && plan.cards[c.id] && plan.cards[c.id].where !== 'others').map((c) => c.id)
    : [];
  const liveWeb = liveWebIds(lru, webOnScreen);
  useEffect(() => {
    setLru((prev) => (prev.every((id) => byId.has(id)) ? prev : prev.filter((id) => byId.has(id))));
  }, [byId]);

  // ── The owner's gestures ──
  /** After a card leaves the stage, focus goes to the next card or the stack, never <body>. */
  const focusAfter = (id: string) => {
    const order = planRef.current.order.filter((k) => k !== id && planRef.current.cards[k]?.where !== 'others');
    const at = Math.max(0, planRef.current.order.indexOf(id));
    const next = order.find((k) => planRef.current.order.indexOf(k) > at) ?? order[0];
    requestAnimationFrame(() => {
      const el = next ? rootRef.current?.querySelector<HTMLElement>(`[data-stage-key="${cssEsc(next)}"]`) : null;
      if (el) el.focus();
      else stackRef.current?.focus();
    });
  };
  const actions = {
    onSideBySide: (id: string) => {
      const c = byId.get(id);
      if (!c) return;
      if (c.kind === 'web') setLru((prev) => touchLru(prev, id));
      onLayout(c.place === 'others' ? { cards: [{ id, place: 'float' }], view: { mode: 'half', card: id } } : { view: { mode: 'half', card: id } });
    },
    onToOthers: (id: string) => { onLayout({ cards: [{ id, place: 'others' }] }); focusAfter(id); },
    onAskAbout: (id: string) => { const c = byId.get(id); if (c) props.onAskAbout(id, titleOf(c)); },
    onClose: (id: string) => { setLru((prev) => dropFromLru(prev, id)); onLayout({ closed: [id] }); focusAfter(id); },
    onMinimize: (id: string) => {
      onLayout({ view: { mode: 'float' } });
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-stage-key="${cssEsc(id)}"]`)?.focus());
    },
    onLoadWeb: (id: string) => setLru((prev) => touchLru(prev, id)),
    onOpenPage: props.onOpenPage,
  };

  /** Where a release lands: the centre (ask), the Others corner, or the stage (a drop). */
  const hotAt = (p: StagePlan, x: number, y: number): Hot => (overCentre(p, x, y) ? 'centre' : overOthersZone(p, x, y) ? 'others' : null);

  const onPressCard = (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input, textarea, select')) return;
    const el = e.currentTarget;
    const root = rootRef.current;
    const card = planRef.current.cards[id];
    if (!root || !card || card.where !== 'float') return;
    let origin = root.getBoundingClientRect();
    let last: Hot = null;
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
        // A slight lift, kept centred on the card (origin top-left, F6).
        el.style.transform = `translate(${dx - card.rect.width * 0.01}px, ${dy - card.rect.height * 0.01}px) scale(1.02)`;
        const h = hotAt(planRef.current, x - origin.left, y - origin.top);
        if (h !== last) { last = h; setHot(h); }
      },
      onEnd: (drop, x, y) => {
        setHot(null);
        const p = planRef.current;
        const h = drop ? hotAt(p, x - origin.left, y - origin.top) : null;
        if (drop && h === 'centre') actions.onAskAbout(id);
        else if (drop && h === 'others') onLayout({ cards: [{ id, place: 'others' }] });
        else if (drop) {
          const r = { ...card.rect, x: card.rect.x + ddx, y: card.rect.y + ddy };
          onLayout({ cards: [{ id, pos: posFromRect(p.free, r), place: 'float' }] });
          liftOnTop(id);
        }
        // The same batch clears the drag: StageMotion swaps the lift for the settle (FE2).
        setDrag(null);
      },
    });
  };

  const onPressOthersItem = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const root = rootRef.current;
    const layer = layerRef.current;
    const c = byId.get(id);
    if (!root || !layer || !c) return;
    let origin = root.getBoundingClientRect();
    let ghost: HTMLElement | null = null;
    let last: Hot = null;
    const u = Math.max(planRef.current.unit.left, planRef.current.unit.right) || STAGE.U_MAX;
    const box = { width: u, height: heightOf(c.shape, u) };
    const at = (x: number, y: number): Rect => ({ x: x - origin.left - box.width / 2, y: y - origin.top - box.height / 2, ...box });
    armPointerDrag({ pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY }, el, {
      win: window,
      onBegin: () => {
        origin = root.getBoundingClientRect();
        ghost = document.createElement('div');
        ghost.className = 'super-standin super-standin--card super-drag-ghost';
        ghost.textContent = titleOf(c);
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
        if (h !== last) { last = h; setHot(h); }
      },
      onEnd: (drop, x, y) => {
        ghost?.remove();
        ghost = null;
        setHot(null);
        const p = planRef.current;
        const h = drop ? hotAt(p, x - origin.left, y - origin.top) : null;
        if (drop && h === 'centre') actions.onAskAbout(id);
        else if (drop && h !== 'others') { onLayout({ cards: [{ id, place: 'float', pos: posFromRect(p.free, at(x, y)) }] }); liftOnTop(id); }
        setDrag(null);
      },
    });
  };

  // ── The centre ──
  useLiveSession(superSession);
  const status = chatStatus(superSession);
  // The cape goes on WITH the hand-over (D18, AC13): the face mounts with the surface — inside
  // the centre, still at opacity 0 while its stand-in grows in — so the 400 ms entrance starts
  // on the choreography's first frame and is over before its end (≥ 440 ms). Decided once, at
  // mount: a surface that mounts with nothing flying (a reload, a take-back reversed back here)
  // and the crossfade (Light mode, reduced motion) have the cape simply on.
  const [capeOn] = useState(() => motion === 'running' && !prefersReducedMotion() && !isLightMode());

  const head = queueHead(state);
  const asking = useMemo(() => new Set(state.queue.filter(needsOwner).map((q) => q.sessionId)), [state.queue]);
  const othersItems: OthersItem[] = plan.others.map((id) => {
    const c = byId.get(id)!;
    const st = c.kind === 'chat' ? chatStatus(props.sessionFor(c.ref)).kind : null;
    return { id, title: titleOf(c), kind: c.kind, status: st === 'asking' ? 'asking' : st === 'working' ? 'working' : st ? 'idle' : undefined };
  });

  return (
    <div
      ref={rootRef}
      className="super-surface"
      data-testid="super-surface"
      data-super-motion={motion}
      data-mode={plan.mode}
      data-narrow={plan.narrow ? 'true' : undefined}
      data-dragging={drag ? 'true' : undefined}
    >
      <div ref={underRef} className="super-stage-under" aria-hidden />
      <StageMotion plan={plan} dragId={drag?.id ?? null} animate={props.visible && motion === 'idle'} rootRef={rootRef} layerRef={layerRef} underRef={underRef}>
        <div
          className={`super-centre${pending.has('centre') ? ' super-centre--pending' : ''}`}
          data-stage-key="centre"
          data-status={status.kind === 'asking' ? 'asking' : status.kind === 'working' ? 'working' : 'idle'}
          data-ask-target={hot === 'centre' ? 'true' : undefined}
          style={{ left: plan.centre.x, top: plan.centre.y, width: plan.centre.width, height: plan.centre.height }}
        >
          <div className="super-centre-bg" aria-hidden />
          <div className="super-centre-clip">
            <div className="super-centre-head">
              <SleepyMascot size={28} compact mood={status.mood} mode="super" capeOn={capeOn} />
              <span className="super-centre-name">{t('super.centre.name')}</span>
              <span className="super-centre-sub">{t('super.centre.sub')}</span>
            </div>
            <div className="super-slot" data-super-slot="centre" />
          </div>
          {hot === 'centre' && <div className="super-ask-target" data-testid="super-ask-target" aria-hidden>{t('super.card.askAbout')}</div>}
        </div>
        {state.containers.map((c) => {
          const cp = plan.cards[c.id];
          if (!cp || cp.where === 'others') return null;
          return (
            <SuperContainer
              key={c.id}
              container={c}
              plan={topped.includes(c.id) ? { ...cp, z: cp.z + 2 * MAX_CONTAINERS + topped.indexOf(c.id) } : cp}
              child={c.kind === 'chat' ? state.children[c.ref] : undefined}
              session={c.kind === 'chat' ? props.sessionFor(c.ref) : undefined}
              title={titleOf(c)}
              pending={pending.has(c.id)}
              webLive={liveWeb.has(c.id)}
              viewReady={viewsReady}
              asksOwner={c.kind === 'chat' && asking.has(c.ref)}
              shownSlot={shownCard?.id === c.id}
              onPress={onPressCard}
              {...actions}
            />
          );
        })}
      </StageMotion>
      <QueueStrip
        head={head}
        waiting={ownerQueueCount(state)}
        vault={props.vault}
        rect={plan.queue}
        sessionFor={props.sessionFor}
        titleFor={props.titleFor}
        onReplyToSuper={props.onReplyToSuper}
      />
      {state.containers.length === 0 && props.terminals.length === 0 && (
        <div className="super-empty-hint" data-testid="super-empty-hint" style={{ left: plan.centre.x, top: plan.dock.y, width: plan.centre.width, height: plan.dock.height }}>
          {t('super.stage.empty')}
        </div>
      )}
      <TerminalsRow terminals={props.terminals} rect={plan.dock} onOpen={props.onTerminal} />
      {drag && (
        <div
          className="super-others-zone"
          data-testid="super-others-zone"
          data-lit={hot === 'others' ? 'true' : undefined}
          style={{ left: plan.othersZone.x, top: plan.othersZone.y, width: plan.othersZone.width, height: plan.othersZone.height }}
          aria-hidden
        />
      )}
      <OthersStack items={othersItems} rect={plan.othersRect} onOpen={actions.onSideBySide} onPressItem={onPressOthersItem} stackRef={stackRef} />
      <div ref={layerRef} className="super-stage-layer" aria-hidden />
    </div>
  );
}

const cssEsc = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, ''));

// ─── The layout motion (F8, FE2-FE4, D1) ───────────────────────────────────────

interface StageMotionProps {
  plan: StagePlan;
  /** The card under the owner's hand: the motion never touches it. */
  dragId: string | null;
  /** Visible, and no hand-over flight running: changes animate; otherwise they snap. */
  animate: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  layerRef: RefObject<HTMLDivElement | null>;
  underRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

type Snapshot = { snap: true } | { snap: false; before: Map<string, StageBox> };

const rectIn = (el: Element, origin: DOMRect): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
};

const sameRect = (a: Rect, b: Rect) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/** Two plans that draw the same screen: a re-render that changed nothing on the stage (a POST's
 *  echo, a slot epoch) must not cancel and restart a motion that is running. */
export function samePlan(a: StagePlan, b: StagePlan): boolean {
  if (a.width !== b.width || a.height !== b.height || !sameRect(a.centre, b.centre)) return false;
  const ka = Object.keys(a.cards);
  if (ka.length !== Object.keys(b.cards).length) return false;
  for (const k of ka) {
    const x = a.cards[k];
    const y = b.cards[k];
    if (!y || x.where !== y.where || x.shape !== y.shape || x.z !== y.z || !sameRect(x.rect, y.rect)) return false;
  }
  return true;
}

/**
 * Animates every change of the plan (FE2): `getSnapshotBeforeUpdate` reads the centre's and
 * every card's rect BEFORE the commit touches the DOM (a running transform included, so an
 * interrupted motion starts where the card really is; a card flying as a stand-in is read off
 * its stand-in); `componentDidUpdate` (before paint) cancels what runs, swaps a dropped card's
 * lift for its settle in the same commit, takes the LAST rects from the plan (pure, never the
 * homed chat's DOM) and starts the motion. A change of the stage's size snaps (FE4), as does
 * anything while the surface is hidden or the hand-over flights run.
 */
class StageMotion extends Component<StageMotionProps> {
  private run: LayoutRun | null = null;

  getSnapshotBeforeUpdate(prev: StageMotionProps): Snapshot | null {
    if (prev.dragId === this.props.dragId && (prev.plan === this.props.plan || samePlan(prev.plan, this.props.plan))) return null;
    const root = this.props.rootRef.current;
    if (!root || !this.props.animate || !prev.animate) return { snap: true };
    if (prev.plan.width !== this.props.plan.width || prev.plan.height !== this.props.plan.height) return { snap: true };
    const origin = root.getBoundingClientRect();
    const before = new Map<string, StageBox>();
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-stage-key]'))) {
      const key = el.dataset.stageKey ?? '';
      if (!key) continue;
      const where = key === 'centre' ? 'centre' : prev.plan.cards[key]?.where ?? 'float';
      before.set(key, { rect: this.run?.standInRect(key, origin) ?? rectIn(el, origin), where });
    }
    for (const id of prev.plan.others) before.set(id, { rect: prev.plan.othersRect, where: 'others' });
    return { snap: false, before };
  }

  componentDidUpdate(prev: StageMotionProps, _state: unknown, snap: Snapshot | null) {
    if (!snap) return;
    const root = this.props.rootRef.current;
    // A dropped (or cancelled) card loses its lift in this same commit (FE2).
    for (const el of Array.from(root?.querySelectorAll<HTMLElement>('[data-lifted]') ?? [])) {
      if (el.dataset.stageKey === this.props.dragId) continue;
      el.style.transform = '';
      delete el.dataset.lifted;
    }
    this.run?.cancel();
    this.run = null;
    if (snap.snap || !root) return;
    const p = this.props.plan;
    const after = new Map<string, StageBox>([['centre', { rect: p.centre, where: 'centre' }]]);
    for (const c of Object.values(p.cards)) after.set(c.id, { rect: c.rect, where: c.where });
    const reduced = prefersReducedMotion();
    const light = isLightMode();
    const skip = [this.props.dragId];
    // A drop settle snaps under reduced motion and Light mode (dragging itself follows the pointer).
    if ((reduced || light) && prev.dragId && !this.props.dragId) skip.push(prev.dragId);
    for (const k of skip) if (k) { snap.before.delete(k); after.delete(k); }
    const motion = planLayoutMotion(snap.before, after, { reduced, light, othersRect: p.othersRect });
    const layer = this.props.layerRef.current;
    const under = this.props.underRef.current;
    if (motion.kind === 'none' || !layer || !under) return;
    const run = runLayoutMotion(motion, {
      layer,
      under,
      elFor: (key) => root.querySelector<HTMLElement>(`[data-stage-key="${cssEsc(key)}"]`),
    });
    this.run = run;
    void run.finished.then(() => { if (this.run === run) this.run = null; });
  }

  componentWillUnmount() {
    this.run?.cancel();
    this.run = null;
  }

  render() {
    return this.props.children;
  }
}

/** Re-render on a bumped nonce (a tiny helper AgentSurface uses for the flight request). */
export function useNonce(): [number, () => void] {
  const [n, bump] = useReducer((x: number) => x + 1, 0);
  return [n, bump];
}
