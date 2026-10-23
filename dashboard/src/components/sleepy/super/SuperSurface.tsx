import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { isLightMode } from '../../../lib/lightMode';
import { MAX_CONTAINERS, type SuperContainer as Container, type SuperGroup, type SuperStateView, type SuperView } from '../../../lib/superTypes';
import { SleepyMascot } from '../SleepyMascot';
import type { ChatSession } from '../chatSession';
import { prefersReducedMotion } from './motionRunner';
import { TeamTile, type TeamCard } from './TeamTile';
import { OthersStack, type OthersItem } from './OthersStack';
import { GroupPanel } from './GroupPanel';
import { SuperGroupCard } from './SuperGroupCard';
import { GroupTile, KindTile, TileSheets, groupStatus, type GroupMember } from './SuperTiles';
import { StageMotion, cssEsc } from './StageMotion';
import { useStageDrag, type StageDragDeps } from './useStageDrag';
import { OrbitPath, PanelChatTile } from './StageParts';
import { JobBar, showOwnerCard, showQuestionCard } from './JobBar';
import { SuperAgenda } from './SuperAgenda';
import { onOpenJobRow, publishSuperEventContext } from './superJobsStore';
import { AgendaButton, AgendaPill } from './AgendaButton';
import { childModelChip, type AsksOwner } from './AgentCard';
import { SuperContainer, chatStatus, superCentreStatus } from './SuperContainer';
import { useLiveSession } from './liveSession';
import { TerminalsRow, type TerminalRowItem } from './TerminalsRow';
import { anchoredPos, fitsNow, isGroupId, planStage, sizeOf, stageItems, type LayoutPatch, type StagePlan } from './superLayout';
import type { ContainerSize } from '../../../lib/superTypes';
import { CardFullscreenView } from './CardFullscreenView';
import { cardTitle } from './superTitles';
import { useTasks } from '../../../hooks/useTasks';
import type { CardFullscreen } from './SuperContainer';
import { freshPending, hasOwnKey, needsOwner, ownerQueueCount, queueHead, shownChild, toneOfStatus, type JobLook } from './superHandover';
import { NewSessionButton } from './NewSessionButton';
import { MAX_LIVE_BROWSERS, liveWebIds, touchLru, dropFromLru } from './webBudget';
import { useWindowActivity } from '../../../lib/windowActivity';
import { useStageCues, withGhosts } from './useStageCues';
import './SuperSurface.css';
import './superTone.css';
import './superCentre.css';

export { runFlights, prefersReducedMotion, type FlightRun } from './motionRunner';
export { samePlan } from './StageMotion';

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
  /** A child's job NAME for the agenda: its tab title (the brief is its second line). */
  nameFor?: (claudeId: string) => string;
  terminals: readonly TerminalRowItem[];
  /** The owner's gesture, as the server's patch (F3, §0 C3). */
  onLayout: (patch: LayoutPatch) => void;
  onTerminal: (sid: string) => void;
  onReplyToSuper: () => void;
  /** The owner's "New session" (POST /api/super/fresh): true = queued; a refusal throws. */
  onNewSession: () => Promise<boolean>;
  onOpenPage: (page: 'tasks' | 'knowledge' | 'core' | 'whiteboards', id: string) => void;
  /** The slots the surface homes sessions into were (re)created: re-run the placement. */
  onSlotsChanged: () => void;
  /** The stage measured itself (at the folded width) and drew the plan the flights land on (FE4). */
  onStageReady: (stage: { origin: DOMRect; plan: StagePlan }) => void;
  /** O11: the owner dropped a card on the centre (or pressed its "Ask about this"). */
  onAskAbout: (id: string, title: string) => void;
  /** The owner ended a child from its card (`whenDone`: once its turn ends). */
  onEndChild: (child: string, whenDone: boolean) => void;
  /** The owner chose to keep a child running after all (a pending "end when done" is dropped). */
  onKeepChild: (child: string) => void;
  /** Children waiting to be ended when their turn ends. */
  endPending: ReadonlySet<string>;
  /** Children whose end the server did not record (still running; the card says so). */
  endFailed: ReadonlySet<string>;
}

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
    // A hidden stage (the overlay collapsed: 0 x 0) keeps the size it was last seen at. Planned
    // at 0 px, the centre's chat re-laid out at width 0 inside this observer's own pass (its
    // transcript 16 000 px tall) and its observers fired in the same pass: WebKit reported
    // "ResizeObserver loop completed with undelivered notifications". Shown again, it is at the
    // same size, so nothing moves.
    const differs = (m: { width: number; height: number }) =>
      m.width > 0 && m.height > 0 && (m.width !== sizeRef.current.width || m.height !== sizeRef.current.height);
    const first = read();
    if (differs(first)) setSize(first);
    if (typeof ResizeObserver === 'undefined') return undefined;
    // One callback per frame at most (the observer's own cadence), flushed before that frame
    // paints, so the stage never shows a frame laid out for the old size.
    const ro = new ResizeObserver(() => { const m = read(); if (differs(m)) flushSync(() => setSize(m)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── The drag (F6, FE1, D1): the gestures live in useStageDrag; what they read at the moment of
  // the gesture is refreshed below, once everything it names exists. ──
  const dragDeps = useRef<StageDragDeps | null>(null);
  const { drag, hot, target, panelDrag, onPressCard, onPressPanelItem, onPressResize } = useStageDrag(dragDeps);
  // The card dropped last paints on top of the other dropped cards, for this window's session.
  // (A drop never reorders the record: that would move every other card to the other side.)
  const [topped, setTopped] = useState<string[]>([]);
  const liftOnTop = (id: string) => setTopped((prev) => [...prev.filter((x) => x !== id), id]);
  const pinned = useMemo(
    () => (drag && !drag.fromOthers && state.containers !== drag.base ? { id: drag.id, rect: drag.rect } : null),
    [drag, state.containers],
  );

  // ── Cues and the reveal gate (G1, AC16): new cards wait while the owner drags or types,
  //    every verb's cards play their one-time cue, closed cards fade out. Before the plan: a
  //    page put side by side that is still held keeps the stage floating until it appears. ──
  const cuesPlanRef = useRef<StagePlan | null>(null);
  const cuesLiveWebRef = useRef<ReadonlySet<string>>(new Set());
  const autoHalf = state.view.mode === 'half' && state.view.auto && state.view.card ? state.view.card : null;
  const stageCues = useStageCues({ containers: state.containers, planRef: cuesPlanRef, liveWebRef: cuesLiveWebRef, superSession, dragging: !!drag, autoHalf });
  const halfHeld = state.view.mode === 'half' && !!state.view.card && (stageCues.held.has(state.view.card) || stageCues.autoHalfHeld);
  // While held, the stage keeps the view it last drew (another page side by side stays there),
  // or floats when that view names no card any more: nothing moves until the gate opens.
  const drawnView = useRef<SuperView>(state.view);
  const view = useMemo<SuperView>(() => (halfHeld ? heldFallback(drawnView.current, state.view, state.containers) : state.view), [halfHeld, state.view, state.containers]);
  useLayoutEffect(() => { drawnView.current = view; });

  // ── The plan ──
  const items = useMemo(() => stageItems(state.containers, state.groups, view), [state.containers, state.groups, view]);
  // The agenda minimised to its corner pill (owner 2026-10-22 23:44): not a card on the stage
  // (stageItems leaves it out) unless the view shows it side by side or presented.
  const agendaPill = useMemo(() => {
    const a = state.containers.find((c) => c.kind === 'agenda');
    return a?.min && !items.some((i) => i.id === a.id) ? a.id : null;
  }, [state.containers, items]);
  const plan = useMemo(
    () => planStage(items, view, size, { dragging: pinned, terminals: props.terminals.length, agendaPill }),
    [items, view, size, pinned, props.terminals.length, agendaPill],
  );
  cuesPlanRef.current = plan;
  const planRef = useRef(plan);
  planRef.current = plan;

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
  const groupsById = useMemo(() => new Map(state.groups.map((g) => [g.id, g] as const)), [state.groups]);
  // Every card's readable name (superTitles.ts): a task by its title, a file by its name, never a path or slug.
  const { data: tasks } = useTasks();
  const titleOf = useCallback((c: Container) => c.kind === 'agenda' ? t('super.agenda.label') : cardTitle(c, {
    chat: props.titleFor,
    team: (ref) => state.team.find((j) => j.id === ref)?.member,
    task: (slug) => tasks?.find((x) => x.slug === slug)?.name,
  }), [props.titleFor, state.team, tasks, t]);
  /** A team card's job and its status now (the view's `teamLive`); undefined when the job is gone. */
  const teamCardOf = useCallback((c: Container): TeamCard | undefined => {
    if (c.kind !== 'team') return undefined;
    const job = state.team.find((j) => j.id === c.ref);
    if (!job) return undefined;
    const live = state.teamLive?.[job.id];
    return { job, status: live?.status ?? null, lastLine: live?.lastLine ?? '' };
  }, [state.team, state.teamLive]);
  /** A group's cards as its tile shows them: kind, title and (a chat's) live state. */
  const membersOf = (g: SuperGroup): GroupMember[] => g.cards.flatMap((id) => {
    const c = byId.get(id);
    return c ? [{ id, kind: c.kind, title: titleOf(c), ...(c.kind === 'chat' ? { status: chatStatus(props.sessionFor(c.ref)).kind } : {}) }] : [];
  });

  // ── Groups (2026-10-20): the one open panel (a group's, or Others'), and the drop target ──
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  useEffect(() => {
    // A panel whose group left the stage (dissolved, put in Others, a view change) closes.
    if (!openGroup) return;
    if (openGroup === 'others' ? !plan.others.length : plan.cards[openGroup]?.where !== 'float') setOpenGroup(null);
  }, [openGroup, plan]);
  const closePanel = useCallback(() => setOpenGroup(null), []);
  // The owner opened a group (its panel): touched, so the stage's tidying leaves it (tidy.ts).
  useEffect(() => { if (openGroup && openGroup !== 'others') onLayout({ touch: [openGroup] }); }, [openGroup]); // eslint-disable-line react-hooks/exhaustive-deps
  // A stage that is no longer on screen (the overlay folded by a click or the hotkey) closes its
  // panel: a hidden panel would keep Escape and focus for the whole app.
  useEffect(() => { if (!props.visible) setOpenGroup(null); }, [props.visible]);

  // ── The shown slot: the ONE child chat mounted besides the centre (F11, D10) ──
  const shownRef = shownChild(state);
  const shownCard = shownRef
    ? state.containers.find((c) => c.kind === 'chat' && c.ref === shownRef && ['half', 'present', 'sheet'].includes(plan.cards[c.id]?.where ?? ''))
    : undefined;
  const shownKey = shownCard ? `${shownCard.id}:${plan.cards[shownCard.id].where}` : '';
  useLayoutEffect(() => { onSlotsChanged(); }, [shownKey, onSlotsChanged]);

  // ── The web budget: at most two live frames, most recently loaded first ──
  const [lru, setLru] = useState<string[]>([]);
  // What is open full screen (one at a time); its card gives up its own frame meanwhile.
  const [full, setFull] = useState<{ id: string; subject: CardFullscreen } | null>(null);
  // A card opened full screen is touched too (tidy.ts).
  useEffect(() => { if (full) onLayout({ touch: [full.id] }); }, [full?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const webOnScreen = props.visible
    // A small or medium floating tile shows a page's title; the frame lives side by side,
    // presented, or in a large/wide floating card (owner 2026-10-22), within the same budget.
    ? state.containers.filter((c) => {
      const cp = c.kind === 'web' ? plan.cards[c.id] : undefined;
      if (!cp || cp.where === 'others' || full?.id === c.id) return false;
      return cp.where !== 'float' || cp.size === 'large' || cp.size === 'wide';
    }).map((c) => c.id)
    : [];
  const liveWeb = liveWebIds(lru, webOnScreen);
  cuesLiveWebRef.current = liveWeb;

  // ── The live browser budget: at most two cards re-render on frames, only while this window is
  //    visible and focused; the rest keep their last frame (AC7). ──
  const activity = useWindowActivity();
  const browserOnScreen = props.visible && activity.focused
    ? state.containers.filter((c) => c.kind === 'browser' && plan.cards[c.id] && plan.cards[c.id].where !== 'others').map((c) => c.id)
    : [];
  const liveBrowser = liveWebIds(lru, browserOnScreen, MAX_LIVE_BROWSERS);
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
    onAskAbout: (id: string) => {
      const c = byId.get(id);
      const g = groupsById.get(id);
      if (c) props.onAskAbout(id, titleOf(c));
      else if (g) props.onAskAbout(id, g.name);
    },
    onClose: (id: string) => {
      // The agenda's close collapses it to its corner pill (owner 2026-10-22 23:44); never removed.
      if (byId.get(id)?.kind === 'agenda') {
        onLayout({ agenda: 'min' });
        requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('[data-testid="super-agenda-pill-btn"]')?.focus());
        return;
      }
      setLru((prev) => dropFromLru(prev, id)); onLayout({ closed: [id] }); focusAfter(id);
    },
    onEndSession: (id: string, whenDone: boolean) => {
      const c = byId.get(id);
      if (c?.kind !== 'chat') return;
      props.onEndChild(c.ref, whenDone);
      if (!whenDone) focusAfter(id);
    },
    onKeepRunning: (id: string) => {
      const c = byId.get(id);
      if (c?.kind === 'chat') props.onKeepChild(c.ref);
    },
    onMinimize: (id: string) => {
      onLayout({ view: { mode: 'float' } });
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-stage-key="${cssEsc(id)}"]`)?.focus());
    },
    onLoadWeb: (id: string) => setLru((prev) => touchLru(prev, id)),
    onOpenPage: props.onOpenPage,
    /** The owner's size (the menu, the corner handle): his choice, written once. A card he
     *  placed keeps its inner top corner (anchoredPos), so it grows away from the centre. */
    onSize: (id: string, next: ContainerSize) => {
      const c = byId.get(id);
      const cp = planRef.current.cards[id];
      if (!c || !cp) return;
      if (sizeOf(c) === next && c.sizeBy === 'owner') return;
      const side = c.pos ? (c.pos.x < 0.5 ? 'left' : 'right') : null;
      const pos = side && cp.where === 'float' ? anchoredPos(planRef.current.free, cp.rect, next, side) : undefined;
      if (next === 'large' || next === 'wide') { if (c.kind === 'web') setLru((prev) => touchLru(prev, id)); }
      onLayout({ cards: [{ id, size: next, ...(pos ? { pos } : {}) }] });
    },
    onFullscreen: (id: string, subject: CardFullscreen) => setFull({ id, subject }),
  };
  const canFit = (id: string, next: ContainerSize) => fitsNow(items, view, size, id, next, { terminals: props.terminals.length });
  // A card closed meanwhile takes its full-screen view with it.
  useEffect(() => { if (full && !byId.has(full.id)) setFull(null); }, [byId, full]);

  const onUngroup = (id: string) => { setOpenGroup(null); onLayout({ ungroup: [id] }); };
  dragDeps.current = {
    rootRef, layerRef, planRef, stateRef, byId, groupsById, titleOf, onLayout, actions, liftOnTop, setOpenGroup,
    groupWord: t('super.group.word'), onSize: actions.onSize, canFit,
  };
  /** A card clicked in a panel: side by side; a group in Others: back on the stage. */
  const openFromPanel = (id: string) => {
    setOpenGroup(null);
    if (isGroupId(id)) onLayout({ cards: [{ id, place: 'float' }] });
    else actions.onSideBySide(id);
  };
  const returnFocusTo = useCallback((key: string) => () => requestAnimationFrame(() => {
    const el = key === 'others' ? stackRef.current : rootRef.current?.querySelector<HTMLElement>(`[data-stage-key="${cssEsc(key)}"]`);
    el?.focus();
  }), []);
  const returnFocus = useMemo(() => returnFocusTo(openGroup ?? 'others'), [returnFocusTo, openGroup]);

  /** A card as it sits in a panel: the same tile it is on the stage. */
  const renderPanelItem = (id: string) => {
    const g = groupsById.get(id);
    if (g) {
      return (
        <div className="super-panel-tile super-panel-tile--group">
          <TileSheets />
          <div className="super-panel-clip"><GroupTile group={g} members={membersOf(g)} /></div>
        </div>
      );
    }
    const c = byId.get(id);
    if (!c) return null;
    if (c.kind === 'chat') {
      return <PanelChatTile session={props.sessionFor(c.ref)} child={state.children[c.ref]} title={titleOf(c)} asksOwner={asking.get(c.ref) ?? false} />;
    }
    const team = teamCardOf(c);
    if (team) return <div className="super-panel-tile"><div className="super-panel-clip"><TeamTile card={team} /></div></div>;
    return <div className="super-panel-tile"><div className="super-panel-clip"><KindTile container={c} title={titleOf(c)} viewReady={viewsReady} /></div></div>;
  };

  // ── The centre ──
  // The stage follows the Super Agent's STATUS (the centre's glow and the mascot), never its every
  // token: its transcript re-renders itself (liveSession.ts).
  useLiveSession(superSession, () => { const s = chatStatus(superSession); return `${s.kind}|${s.mood}`; });
  // A question the Super Agent put to the owner (its own `ask`, a child's question it escalated,
  // an AI Team approval) is ITS question while it waits, like an AskUserQuestion is a chat's: the
  // centre asks, not spins (owner, 2026-10-22). A child's permission stays on the child's card.
  const ownerAsk = state.queue.some((q) => needsOwner(q) && q.kind !== 'permission');
  const status = superCentreStatus(superSession, ownerAsk);
  // The cape goes on WITH the hand-over (D18, AC13): the face mounts with the surface — inside
  // the centre, still at opacity 0 while its stand-in grows in — so the 400 ms entrance starts
  // on the choreography's first frame and is over before its end (≥ 440 ms). Decided once, at
  // mount: a surface that mounts with nothing flying (a reload, a take-back reversed back here)
  // and the crossfade (Light mode, reduced motion) have the cape simply on.
  const [capeOn] = useState(() => motion === 'running' && !prefersReducedMotion() && !isLightMode());

  const head = queueHead(state);
  // What each child's card says it waits on the owner for: a question it asks, or something only he can do.
  const asking = useMemo(() => {
    const m = new Map<string, AsksOwner>();
    for (const q of state.queue.filter(needsOwner)) if (m.get(q.sessionId) !== 'owner') m.set(q.sessionId, q.kind === 'owner' ? 'owner' : 'ask');
    return m;
  }, [state.queue]);
  // The centre's event lines read the children's titles and which batches render full: published
  // for the super session, notified only when one of them changes (superJobsStore).
  const superId = superSession?.claudeId ?? null;
  const titleKey = Object.keys(state.children).map((sid) => `${sid}=${props.titleFor(sid)}`).join('\u0001');
  const batchKey = state.ownerBatches.join(',');
  const titleForRef = useRef(props.titleFor);
  titleForRef.current = props.titleFor;
  // Published once the stage has landed, never mid-flight: a change re-renders the centre's
  // transcript, which must not cost a frame of the hand-over. Kept across a take-back (only the
  // super session's own chat reads it), so the next hand-over re-renders nothing.
  useEffect(() => {
    if (!superId || motion === 'running') return;
    publishSuperEventContext(superId, { ownerBatches: state.ownerBatches, titleFor: (c) => titleForRef.current(c) }, `${batchKey}\u0002${titleKey}`);
  }, [superId, batchKey, titleKey, state.ownerBatches, motion]);
  // The agenda and the question band read the same record and the children's live sessions (0 requests).
  const jobLook: JobLook = {
    live: (sid) => { const cs = props.sessionFor(sid); return cs ? chatStatus(cs).kind : null; },
    titleFor: props.titleFor,
    nameFor: props.nameFor,
    modelFor: (sid) => childModelChip(props.sessionFor(sid), hasOwnKey(state.children, sid) ? state.children[sid] : undefined),
    superTitle: t('super.centre.name'),
  };
  // A child the agenda points at (a permission waiting on the owner) shows beside the centre,
  // and the agenda stays with it (presented together, the agenda last): a page side by side
  // would send the agenda to Others, and the owner reads on from it.
  const showChild = (sid: string) => {
    const c = state.containers.find((k) => k.kind === 'chat' && k.ref === sid);
    if (!c) return;
    // A child waiting on the owner: the card it waits on comes into view with it.
    const wait = state.queue.find((q) => q.sessionId === sid && q.kind === 'owner' && q.state !== 'done');
    const agenda = state.containers.find((k) => k.kind === 'agenda');
    const agendaShown = !!agenda && !!plan.cards[agenda.id] && plan.cards[agenda.id].where !== 'others';
    if (!agenda || !agendaShown) actions.onSideBySide(c.id);
    else onLayout({ ...(c.place === 'others' ? { cards: [{ id: c.id, place: 'float' as const }] } : {}), view: { mode: 'present', cards: [c.id, agenda.id] } });
    if (wait) showOwnerCard(wait.wait);
  };
  // The super's own question (or an approval) in the agenda: its card in the centre chat.
  const showQuestion = (item: string) => {
    if (showQuestionCard(item)) return;
    document.querySelector<HTMLElement>('[data-testid="super-queue-head"]')?.scrollIntoView({ block: 'center' });
  };
  // The agenda card (owner 2026-10-22: a card on the stage, not a column; the super's notepad):
  // drawn by SuperAgenda inside the card's own chrome. Off the stage (closed, in Others, hidden
  // by a page side by side), the centre's head offers it back.
  const agendaCard = state.containers.find((k) => k.kind === 'agenda');
  const agendaOnStage = !!agendaCard && !!plan.cards[agendaCard.id] && plan.cards[agendaCard.id].where !== 'others';
  // The owner's press always shows it (end review r1): closed, in Others or in a group, the
  // server brings it back floating, out of its group (and a page side by side or a presentation,
  // which keeps every other card in Others, gives way to the floating stage); on a stage too
  // narrow to float cards, or one too full to draw it, it opens side by side instead.
  const viewMode = state.view.mode;
  const agendaGrouped = !!agendaCard && state.groups.some((g) => g.cards.includes(agendaCard.id));
  const openAgenda = () => {
    // Floating already but not drawn (a stage too full): side by side. Minimised: restored where it stood.
    if (agendaCard && (plan.narrow || (agendaCard.place === 'float' && !agendaCard.min && !agendaGrouped && viewMode === 'float'))) {
      actions.onSideBySide(agendaCard.id);
      return;
    }
    onLayout(viewMode === 'float' ? { agenda: 'open' } : { agenda: 'open', view: { mode: 'float' } });
    // Focus follows the card back (the pill that held it is gone).
    if (agendaCard) requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-stage-key="${cssEsc(agendaCard.id)}"]`)?.focus());
  };
  // A child's name in an event line: that child side by side.
  const showChildRef = useRef(actions.onSideBySide);
  showChildRef.current = actions.onSideBySide;
  useEffect(() => onOpenJobRow((row) => {
    if (!row.startsWith('c:')) return;
    const c = stateRef.current.containers.find((k) => k.kind === 'chat' && k.ref === row.slice(2));
    if (c) showChildRef.current(c.id);
  }), []);
  const renderAgenda = (variant: 'tile' | 'full', wide: boolean) => (
    <SuperAgenda
      state={state}
      look={jobLook}
      variant={variant}
      wide={wide}
      canShowChild={(sid) => state.containers.some((k) => k.kind === 'chat' && k.ref === sid)}
      onShowChild={showChild}
      onShowQuestion={showQuestion}
    />
  );
  const othersItems: OthersItem[] = plan.others.map((id) => {
    const g = groupsById.get(id);
    if (g) {
      const gs = groupStatus(membersOf(g));
      return { id, title: g.name, kind: 'group' as const, status: gs === 'asking' ? 'asking' as const : gs === 'working' ? 'working' as const : 'idle' as const };
    }
    const c = byId.get(id)!;
    const st = c.kind === 'chat' ? chatStatus(props.sessionFor(c.ref)).kind : null;
    const tone = st ? toneOfStatus(st) : null;
    return { id, title: titleOf(c), kind: c.kind, status: tone === null ? undefined : tone === 'starting' ? 'idle' : tone };
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
      {plan.mode === 'float' && !plan.narrow && plan.orbit.length > 0 && <OrbitPath plan={plan} />}
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
              {!agendaOnStage && <AgendaButton state={state} look={jobLook} onOpen={openAgenda} />}
              <NewSessionButton pending={freshPending(state)} onPress={props.onNewSession} />
            </div>
            <div className="super-slot" data-super-slot="centre" />
          </div>
          {hot === 'centre' && <div className="super-ask-target" data-testid="super-ask-target" aria-hidden>{t('super.card.askAbout')}</div>}
        </div>
        {withGhosts(state.containers, stageCues.leaving.map((g) => ({ card: g.container, index: g.index }))).map((c) => {
          // A closed card fades as itself: the SAME key, so React keeps its view mounted (no
          // Excalidraw or transcript remount for a 360 ms fade), at its last spot.
          const ghost = byId.has(c.id) ? undefined : stageCues.leaving.find((g) => g.container.id === c.id);
          const cp = ghost ? ghost.plan : plan.cards[c.id];
          if (!cp || cp.where === 'others') return null;
          const cue = ghost ? { kind: 'close' as const } : stageCues.cueFor(c.id);
          const rect = cp.rect;
          return (
            <SuperContainer
              key={c.id}
              container={c}
              cue={cue ? {
                ...cue,
                // Where a delegated card flies in from, measured on the plan being drawn.
                dx: plan.centre.x + plan.centre.width / 2 - (rect.x + rect.width / 2),
                dy: plan.centre.y + plan.centre.height / 2 - (rect.y + rect.height / 2),
                at: 0,
              } : undefined}
              plan={topped.includes(c.id) ? { ...cp, z: cp.z + 2 * MAX_CONTAINERS + topped.indexOf(c.id) } : cp}
              child={c.kind === 'chat' ? state.children[c.ref] : undefined}
              session={c.kind === 'chat' ? props.sessionFor(c.ref) : undefined}
              title={titleOf(c)}
              pending={pending.has(c.id) || stageCues.held.has(c.id)}
              webLive={liveWeb.has(c.id) || !!ghost?.webLive}
              browserSessionId={c.kind === 'browser' ? props.sessionFor(c.ref)?.id : undefined}
              browserLive={liveBrowser.has(c.id)}
              viewReady={viewsReady}
              asksOwner={c.kind === 'chat' ? asking.get(c.ref) ?? false : false}
              shownSlot={shownCard?.id === c.id}
              onPress={onPressCard}
              dropTarget={target === c.id}
              endPending={c.kind === 'chat' && props.endPending.has(c.ref)}
              endFailed={c.kind === 'chat' && props.endFailed.has(c.ref)}
              team={teamCardOf(c)}
              side={cp.rect.x + cp.rect.width / 2 < plan.centre.x + plan.centre.width / 2 ? 'left' : 'right'}
              canFit={(next) => canFit(c.id, next)}
              onPressResize={ghost ? undefined : onPressResize}
              agenda={c.kind === 'agenda' ? renderAgenda : undefined}
              {...actions}
            />
          );
        })}
        {state.groups.map((g) => {
          const cp = plan.cards[g.id];
          if (!cp || cp.where === 'others') return null;
          const members = membersOf(g);
          return (
            <SuperGroupCard
              key={g.id}
              group={g}
              plan={topped.includes(g.id) ? { ...cp, z: cp.z + 2 * MAX_CONTAINERS + topped.indexOf(g.id) } : cp}
              members={members}
              sessions={members.map((m) => { const c = byId.get(m.id); return c?.kind === 'chat' ? props.sessionFor(c.ref) : undefined; })}
              pending={pending.has(g.id)}
              dropTarget={target === g.id}
              onPress={onPressCard}
              onOpen={setOpenGroup}
              onToOthers={actions.onToOthers}
              onAskAbout={actions.onAskAbout}
              onUngroup={onUngroup}
            />
          );
        })}
      </StageMotion>
      {target && plan.cards[target] && (
        <div
          className="super-drop-label"
          data-testid="super-drop-label"
          style={{ left: plan.cards[target].rect.x + plan.cards[target].rect.width / 2, top: plan.cards[target].rect.y - 12 }}
          aria-hidden
        >
          {isGroupId(target) ? t('super.drop.join').replace('{name}', groupsById.get(target)?.name ?? '') : t('super.drop.group')}
        </div>
      )}
      <JobBar
        state={state}
        head={head}
        waiting={ownerQueueCount(state)}
        vault={props.vault}
        rect={plan.queue}
        look={jobLook}
        superSession={superSession}
        sessionFor={props.sessionFor}
        titleFor={props.titleFor}
        onReplyToSuper={props.onReplyToSuper}
        onShowChild={showChild}
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
      {agendaPill && <AgendaPill state={state} look={jobLook} rect={plan.agendaPill} onOpen={openAgenda} />}
      <OthersStack items={othersItems} rect={plan.othersRect} open={openGroup === 'others'} onToggle={() => setOpenGroup((o) => (o === 'others' ? null : 'others'))} stackRef={stackRef} />
      {openGroup && (() => {
        const system = openGroup === 'others';
        const g = system ? undefined : groupsById.get(openGroup);
        const ids = system ? plan.others : (g?.cards ?? []).filter((id) => byId.has(id));
        const anchor = system ? plan.othersRect : plan.cards[openGroup]?.rect;
        if (!anchor || !ids.length || (!system && !g)) return null;
        return (
          <GroupPanel
            key={openGroup}
            title={g ? g.name : t('super.others.name')}
            ids={ids}
            anchor={anchor}
            stage={size}
            system={system}
            onClose={closePanel}
            onUngroup={g ? () => onUngroup(g.id) : undefined}
            onOpenItem={openFromPanel}
            onPressItem={(e, id) => onPressPanelItem(e, id, openGroup)}
            renderItem={renderPanelItem}
            itemTestId={system ? 'super-others-item' : 'super-group-item'}
            returnFocus={returnFocus}
            hidden={panelDrag}
          />
        );
      })()}
      <div ref={layerRef} className="super-stage-layer" aria-hidden />
      {full && <CardFullscreenView subject={full.subject} onClose={() => setFull(null)} />}
    </div>
  );
}

/** Re-render on a bumped nonce (a tiny helper AgentSurface uses for the flight request). */
export function useNonce(): [number, () => void] {
  const [n, bump] = useReducer((x: number) => x + 1, 0);
  return [n, bump];
}

/** The view drawn while a new half page waits (SuperSurface): the one drawn before it when its
 *  cards are still there (never the waiting card itself), else float. Pure. */
export function heldFallback(drawn: SuperView, wanted: SuperView, containers: readonly { id: string }[]): SuperView {
  const live = new Set(containers.map((c) => c.id));
  if (drawn.mode === 'half' && drawn.card && drawn.card !== wanted.card && live.has(drawn.card)) return { mode: 'half', card: drawn.card };
  if (drawn.mode === 'present') {
    const cards = (drawn.cards ?? []).filter((id) => live.has(id) && id !== wanted.card);
    if (cards.length) return { mode: 'present', cards };
  }
  return { mode: 'float' };
}
