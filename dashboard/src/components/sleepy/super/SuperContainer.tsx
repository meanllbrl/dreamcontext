import { useEffect, useReducer, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { SuperChild, SuperContainer as Container } from '../../../lib/superTypes';
import type { WidgetSize } from '../../../lib/whiteboardWidgets';
import { InsightWidget } from '../../whiteboard/widgets/InsightWidget';
import { BoardEmbed, BoardFullscreen } from '../chat/BoardEmbed';
import { DocumentReader } from '../../appLink/DocumentReader';
import { KnowledgeWidget } from '../../whiteboard/widgets/KnowledgeWidget';
import { TaskWidget } from '../../whiteboard/widgets/TaskWidget';
import { WebWidget } from '../../whiteboard/widgets/WebWidget';
import { BrowserCard } from './BrowserCard';
import type { StageCue } from './useStageCues';
import { targetPath } from '../../whiteboard/pagePopupModel';
import '../../whiteboard/widgets/widgets.css';
import { deriveSessionStatus, type SessionStatusInfo } from '../agentStatus';
import type { ChatSession } from '../chatSession';
import { AgentCard, ChatTile } from './AgentCard';
import { toneOfStatus } from './superHandover';
import { KindTile, ResolvedTitle, TaskPageHead } from './SuperTiles';
import { LAYOUT } from './handoverMotion';
import type { CardPlan } from './superLayout';

export const KIND_GLYPH: Record<Container['kind'], string> = {
  chat: '◆', insight: '◔', task: '☐', knowledge: '¶', whiteboard: '▦', board: '▦', web: '◎', image: '▣', browser: '◉',
};

/** A whiteboard's board file, from its slug (`whiteboards/<slug>/<slug>.excalidraw.md`). */
export function whiteboardPath(slug: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(slug) ? `_dream_context/whiteboards/${slug}/${slug}.excalidraw.md` : null;
}

/**
 * Re-render on the child's session events at most once a frame (a token storm costs one
 * render per frame, never one per token). The card reads the live session; 0 requests.
 */
export function useLiveSession(session: ChatSession | undefined): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!session) return undefined;
    let raf = 0;
    const off = session.subscribe(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; force(); });
    });
    return () => { off(); if (raf) cancelAnimationFrame(raf); };
  }, [session]);
}

export function chatStatus(session: ChatSession | undefined): SessionStatusInfo {
  return deriveSessionStatus({
    dormant: !session, status: session?.status, busy: session?.busy, asking: session?.asking,
    agentsWorking: session?.agentsWorking,
  });
}

export interface SuperCardActions {
  onSideBySide: (id: string) => void;
  onToOthers: (id: string) => void;
  onAskAbout: (id: string) => void;
  onClose: (id: string) => void;
  /** A CHILD CHAT card's close: end its session (`whenDone`: once its turn ends), the same end
   *  `super end` does. Other cards close at once (`onClose`). */
  onEndSession: (id: string, whenDone: boolean) => void;
  /** "Move to Others" from that choice: the child keeps running (a pending end is dropped). */
  onKeepRunning: (id: string) => void;
  onMinimize: (id: string) => void;
  onLoadWeb: (id: string) => void;
  onOpenPage: (page: 'tasks' | 'knowledge' | 'core' | 'whiteboards', id: string) => void;
}

export interface SuperContainerProps extends SuperCardActions {
  container: Container;
  plan: CardPlan;
  /** The child behind a `chat` card (its ref is the child's session id). */
  child?: SuperChild;
  session?: ChatSession;
  title: string;
  /** Pending its hand-over flight: drawn at opacity 0 so no empty stage ever flashes (D18). */
  pending: boolean;
  /** `web`: may hold a live iframe right now (webBudget.ts). */
  webLive: boolean;
  /** `browser`: the child's `ChatSession.id` (the live frames' key), and whether this card may
   *  re-render on new frames right now (at most two, on screen, window focused). */
  browserSessionId?: string;
  browserLive?: boolean;
  /** A one-time cue playing on this card (AC16, useStageCues): `close` = a card fading out. */
  cue?: StageCue;
  /** The hand-over has landed: a non-chat card may mount its view (SuperSurface). */
  viewReady: boolean;
  asksOwner: boolean;
  /** This card hosts the shown chat's slot (the half card, or the first presented chat). */
  shownSlot: boolean;
  /** A press on a FLOATING card arms its drag (the card is one grab handle; F6, FE1). */
  onPress: (e: PointerEvent<HTMLDivElement>, id: string) => void;
  /** A card held over this one: releasing groups them (2026-10-20). */
  dropTarget?: boolean;
  /** The owner chose "end when done" for this child: it closes when its turn ends. */
  endPending?: boolean;
  /** The server did not record this child's end: it still runs, and the card says so. */
  endFailed?: boolean;
}

/**
 * One card on the stage (plan-r8 F5, F6, F11; owner decisions O1-O6, O10). Look, move, put
 * aside, close, ask about — never type. Two layers (§0 FE5): the outer FRAME is positioned from
 * the plan and carries the motion transform, the two glow layers (accent while working, the
 * waiting colour while asking, each fading its own opacity) and the lift shadow; the inner CLIP
 * rounds and clips the content. A floating card is one grab handle: its body is inert, a click
 * shows it side by side; content is interactive only in half and present.
 */
export function SuperContainer(props: SuperContainerProps) {
  const { container: c, plan, pending, session } = props;
  const { t } = useI18n();
  useLiveSession(c.kind === 'chat' ? session : undefined);
  const status = c.kind === 'chat' ? chatStatus(session) : null;
  const floating = plan.where === 'float';
  const large = plan.where === 'half' || plan.where === 'present' || plan.where === 'sheet';
  // A child chat's close asks first (owner 2026-10-21): end the session, or keep it running in
  // Others. A working or asking child offers "end when done" instead of cutting its turn.
  const [closeAsk, setCloseAsk] = useState(false);
  const asksOnClose = c.kind === 'chat';
  const childBusy = !!session && (status?.kind === 'working' || status?.kind === 'asking' || session.hasLiveWork());
  useEffect(() => {
    if (!closeAsk) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setCloseAsk(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeAsk]);
  const onCloseClick = () => (asksOnClose ? setCloseAsk((v) => !v) : props.onClose(c.id));
  const closeLabel = asksOnClose ? t('super.close.chatLabel') : t('super.container.close');
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !floating) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSideBySide(c.id); }
  };
  return (
    <div
      className={`super-card-frame${pending ? ' super-card-frame--pending' : ''}`}
      data-testid="super-container"
      data-stage-key={c.id}
      data-container-id={c.id}
      data-kind={c.kind}
      data-where={plan.where}
      data-shape={plan.shape}
      data-owner={plan.owner ? 'true' : undefined}
      data-status={status ? glowOf(status) : undefined}
      data-super-tone={status ? toneOfStatus(status.kind) : undefined}
      data-drop-target={props.dropTarget ? 'card' : undefined}
      data-cue={props.cue?.kind}
      inert={props.cue?.kind === 'close' ? true : undefined}
      role="group"
      aria-label={props.title}
      tabIndex={floating ? 0 : -1}
      style={{
        left: plan.rect.x, top: plan.rect.y, width: plan.rect.width, height: plan.rect.height, zIndex: 10 + plan.z,
        ...(props.cue ? { ['--cue-dx' as string]: `${props.cue.dx}px`, ['--cue-dy' as string]: `${props.cue.dy}px` } : {}),
      }}
      onPointerDown={floating ? (e) => props.onPress(e, c.id) : undefined}
      onClick={floating ? (e) => { if (!(e.target as HTMLElement).closest('button')) props.onSideBySide(c.id); } : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="super-card-lift" aria-hidden />
      <div className="super-card-clip">
        {large ? <LargeBody {...props} status={status} /> : <FloatBody {...props} status={status} />}
      </div>
      <span className="super-drop-ring" aria-hidden />
      {props.cue && <span className="super-card-glint" aria-hidden />}
      <div className="super-card-actions">
        {floating ? (
          <>
            <IconButton icon="side" label={t('super.card.sideBySide')} onClick={() => props.onSideBySide(c.id)} />
            <IconButton icon="others" label={t('super.card.toOthers')} onClick={() => props.onToOthers(c.id)} />
            <IconButton icon="ask" label={t('super.card.askAbout')} onClick={() => props.onAskAbout(c.id)} testId="super-card-ask" />
            <IconButton icon="close" label={closeLabel} onClick={onCloseClick} testId="super-card-close" />
          </>
        ) : (
          <>
            <IconButton icon="ask" label={t('super.card.askAbout')} onClick={() => props.onAskAbout(c.id)} testId="super-card-ask" />
            <IconButton icon="minimize" label={t('super.card.minimize')} onClick={() => props.onMinimize(c.id)} testId="super-card-minimize" />
            <IconButton icon="close" label={closeLabel} onClick={onCloseClick} testId="super-card-close" />
          </>
        )}
      </div>
      {closeAsk && (
        <div className="super-close-choice" role="group" aria-label={t('super.close.ask')} data-testid="super-close-choice"
          onPointerDown={(e) => e.stopPropagation()}>
          <span className="super-close-choice-q">{t('super.close.ask')}</span>
          <button type="button" className="super-close-choice-btn super-close-choice-btn--end" data-testid="super-close-end"
            onClick={() => { setCloseAsk(false); props.onEndSession(c.id, childBusy); }}>
            {childBusy ? t('super.close.endWhenDone') : t('super.close.end')}
          </button>
          <button type="button" className="super-close-choice-btn" data-testid="super-close-others"
            onClick={() => { setCloseAsk(false); props.onKeepRunning(c.id); props.onToOthers(c.id); }}>
            {t('super.close.toOthers')}
          </button>
        </div>
      )}
      {props.endPending && !closeAsk && (
        <span className="super-close-pending" data-testid="super-close-pending">{t('super.close.pending')}</span>
      )}
      {props.endFailed && !props.endPending && !closeAsk && (
        <span className="super-close-pending super-close-pending--failed" role="alert" data-testid="super-close-failed">{t('super.close.failed')}</span>
      )}
    </div>
  );
}

/** working → the accent glow rises; asking → the waiting glow; anything else fades (F5). */
function glowOf(s: SessionStatusInfo): 'working' | 'asking' | 'idle' {
  return s.kind === 'asking' ? 'asking' : s.kind === 'working' ? 'working' : 'idle';
}

type IconName = 'side' | 'others' | 'ask' | 'close' | 'minimize' | 'ungroup';

const ICONS: Record<IconName, ReactNode> = {
  side: <><rect x="2" y="3" width="5" height="10" rx="1.4" /><rect x="9" y="3" width="5" height="10" rx="1.4" /></>,
  others: <><path d="M3.5 3.5l6 6" /><path d="M10 5v5H5" /><path d="M3 13h10" /></>,
  ask: <><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.4V11h0A1 1 0 0 1 3 10z" /></>,
  close: <><path d="M4.5 4.5l7 7" /><path d="M11.5 4.5l-7 7" /></>,
  minimize: <><path d="M9.5 3.5v3h3" /><path d="M6.5 12.5v-3h-3" /><path d="M9.5 6.5l3.5-3.5" /><path d="M6.5 9.5L3 13" /></>,
  ungroup: <><rect x="2.5" y="2.5" width="5" height="5" rx="1.2" /><rect x="8.5" y="8.5" width="5" height="5" rx="1.2" /><path d="M10 3.5h2.5V6" /><path d="M6 12.5H3.5V10" /></>,
};

export function IconButton({ icon, label, onClick, testId }: { icon: IconName; label: string; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      className="super-icon-btn"
      data-testid={testId}
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {ICONS[icon]}
      </svg>
    </button>
  );
}

type BodyProps = SuperContainerProps & { status: SessionStatusInfo | null };

const widgetSize = (p: CardPlan): WidgetSize => {
  if (p.where !== 'float') return p.rect.width >= 520 ? 'xl' : 'l';
  return p.rect.width >= 200 ? 'm' : 's';
};

/** A floating card: one 1:1 tile, what it is at a glance; the body is inert (the card is a grab
 *  handle). A web page or a board is live only side by side (2026-10-20). */
function FloatBody(p: BodyProps): ReactNode {
  const c = p.container;
  return (
    <div className="super-card-body" data-inert="true">
      {c.kind === 'chat'
        ? <ChatTile session={p.session} child={p.child} title={p.title} asksOwner={p.asksOwner} status={p.status!} />
        : c.kind === 'browser'
          ? <BrowserCard sessionId={p.browserSessionId} live={!!p.browserLive} large={false} />
          : <KindTile container={c} title={p.title} viewReady={p.viewReady} />}
    </div>
  );
}

/** Half page, presented or a narrow sheet: the large view, interactive. A shown chat mounts its
 *  full read-only chat in the shown slot (homed by AgentSurface, the same mechanics as a pane). */
function LargeBody(p: BodyProps): ReactNode {
  const { t } = useI18n();
  const c = p.container;
  if (c.kind === 'chat' && p.shownSlot) {
    return (
      <div className="super-card-large" data-testid="super-shown">
        <div className="super-card-large-head">
          <span className="super-card-glyph" aria-hidden>{KIND_GLYPH.chat}</span>
          <span className="super-card-large-title">{p.title}</span>
          <span className="super-card-large-note">{t('super.focus.readOnly')}</span>
        </div>
        <div className="super-slot" data-super-slot="shown" />
      </div>
    );
  }
  return (
    <div className="super-card-large" data-testid={c.kind === 'chat' ? 'super-shown-card' : undefined}>
      <CardHead kind={c.kind} title={p.title} container={c} />
      <div className="super-card-large-body">
        {c.kind === 'chat'
          ? <AgentCard session={p.session} child={p.child} title={p.title} asksOwner={p.asksOwner} status={p.status!} tall />
          : viewFor(p)}
      </div>
    </div>
  );
}

function CardHead({ kind, title, container }: { kind: Container['kind']; title: string; container?: Container }) {
  return (
    <div className="super-card-head">
      <span className="super-card-glyph" aria-hidden>{KIND_GLYPH[kind]}</span>
      {container ? <ResolvedTitle container={container} fallback={title} /> : <span className="super-card-title" title={title}>{title}</span>}
    </div>
  );
}

function viewFor(p: BodyProps): ReactNode {
  const c = p.container;
  if (!p.viewReady) return null;
  const size = widgetSize(p.plan);
  switch (c.kind) {
    case 'insight':
      // The whiteboard's insight widget IS the Lab card at this size (a funnel set opens as its
      // explorer, a chart fills the card, a table or an app scrolls): one drawing, not a copy.
      return <div className="super-card-view super-card-view--insight"><InsightWidget elementId={`super-${c.id}`} payload={{ v: 1, kind: 'insight', ref: c.ref, title: '' }} active size={size} /></div>;
    case 'task':
    case 'knowledge': {
      // Large (side by side, presented, a sheet): the page itself, read the way a whiteboard's
      // page popup reads it, so a task shows its criteria and to-dos and a note its body
      // (owner 2026-10-20: the widget showed a title and two chips over an empty card).
      const path = targetPath({ kind: c.kind, ref: c.ref });
      if (path) {
        return (
          <div className="super-card-view super-card-view--page">
            {c.kind === 'task' && <TaskPageHead container={c} />}
            <AfterLayoutMotion>
              <DocumentReader key={path} path={path} onOpen={() => { /* read-only */ }} embedded vaultReads variant="page" />
            </AfterLayoutMotion>
          </div>
        );
      }
      return c.kind === 'task'
        ? <div className="super-card-view"><TaskWidget elementId={`super-${c.id}`} payload={{ v: 1, kind: 'task', ref: c.ref, title: c.title }} active={false} size={size} /></div>
        : <div className="super-card-view"><KnowledgeWidget elementId={`super-${c.id}`} payload={{ v: 1, kind: 'knowledge', ref: c.ref, title: c.title }} active={false} size={size} /></div>;
    }
    case 'web':
      return p.webLive
        ? <div className="super-card-view super-card-view--web"><WebWidget elementId={`super-${c.id}`} payload={{ v: 1, kind: 'web', url: c.ref, title: c.title }} active size={size} /></div>
        : <WebPlaceholder title={c.title || c.ref} onLoad={() => p.onLoadWeb(c.id)} />;
    case 'image':
      return <div className="super-card-view"><DocumentReader path={c.ref} onOpen={() => { /* read-only: links stay closed */ }} embedded /></div>;
    case 'browser':
      return <div className="super-card-view super-card-view--browser"><BrowserCard sessionId={p.browserSessionId} live={!!p.browserLive} large /></div>;
    case 'board':
      return <div className="super-card-view super-card-view--board"><BoardContainer path={c.ref} /></div>;
    case 'whiteboard': {
      const path = whiteboardPath(c.ref);
      return path ? <div className="super-card-view super-card-view--board"><BoardEmbed path={path} onOpenBoard={() => p.onOpenPage('whiteboards', c.ref)} /></div> : null;
    }
    default:
      return null;
  }
}

/** The longest a layout switch runs (the last staggered arrival, then its content fade). */
const LAYOUT_SETTLE_MS = LAYOUT.duration + (LAYOUT.maxStaggered - 1) * LAYOUT.stagger + LAYOUT.contentFade;

/**
 * A page body (a task's or a note's markdown) mounts once the layout switch that opened its card
 * has run (motion r9: a view never lays itself out under a flight). Until then the card shows its
 * head; one timer, never a poll.
 */
function AfterLayoutMotion({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), LAYOUT_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return ready ? <>{children}</> : null;
}

/** Past the iframe budget: the page's title and a Load button (which makes it the most
 *  recently focused, so another web card gives up its frame). Live even on a floating card. */
function WebPlaceholder({ title, onLoad }: { title: string; onLoad: () => void }) {
  const { t } = useI18n();
  return (
    <div className="super-web-placeholder">
      <span className="super-web-title">{title}</span>
      <button type="button" className="super-queue-btn super-web-load" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onLoad(); }}>
        {t('super.container.loadWeb')}
      </button>
    </div>
  );
}

/** A board by path: the read-only preview, and its own full screen. */
function BoardContainer({ path }: { path: string }) {
  const [full, setFull] = useState(false);
  return (
    <>
      <BoardEmbed path={path} onOpenBoard={() => setFull(true)} />
      {full && <BoardFullscreen path={path} onClose={() => setFull(false)} />}
    </>
  );
}
