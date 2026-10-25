import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { requestOpenAgents } from '../../../lib/openAgents';
import { TeamTile, teamRingKind, teamStatusOf, type TeamCard } from './TeamTile';
import { useI18n } from '../../../context/I18nContext';
import { CONTAINER_SIZES, SIZE_UNITS, type ContainerSize, type SuperChild, type SuperContainer as Container } from '../../../lib/superTypes';
import type { WidgetSize } from '../../../lib/whiteboardWidgets';
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
import { AgentCard, ChatTile, type AsksOwner } from './AgentCard';
import { InsightCard } from './InsightCard';
import { backgroundOf, toneOfStatus } from './superHandover';
import { KindTile, ResolvedTitle, TaskPageHead } from './SuperTiles';
import { LAYOUT } from './handoverMotion';
import { useLiveSession } from './liveSession';
import { cardZIndex, sizeOf, type CardPlan } from './superLayout';
import { inlineMediaKind } from '../chat/chatEntities';
import { ZoomPane } from './ZoomPane';
import { WebFrameControl } from '../../../lib/webFrameControl';
import type { WebPick } from '../../../lib/webPick';

/** What a card opens full screen (owner 2026-10-22): a picture, a project web page, a page on the
 *  web or this computer (only once its frame is allowed), a board, a PDF (the chat's full-window
 *  PdfViewer) or a clip (its own player's full screen, asked of the card's `<video>`). */
export type CardFullscreen =
  | { kind: 'image'; path: string; title: string }
  | { kind: 'pdf'; path: string; title: string }
  | { kind: 'video'; path: string; title: string }
  | { kind: 'html'; path: string; title: string }
  | { kind: 'page'; href: string; title: string }
  | { kind: 'board'; path: string; title: string };

/** The full-screen subject of a card, or null when it has none (yet). */
export function fullscreenOf(c: Container, title: string, allowedHref: string | null): CardFullscreen | null {
  if (c.kind === 'image') return { kind: 'image', path: c.ref, title };
  if (c.kind === 'pdf') return { kind: 'pdf', path: c.ref, title };
  if (c.kind === 'video') return { kind: 'video', path: c.ref, title };
  if (c.kind === 'board') return { kind: 'board', path: c.ref, title };
  if (c.kind === 'whiteboard') { const path = whiteboardPath(c.ref); return path ? { kind: 'board', path, title } : null; }
  if (c.kind !== 'web') return null;
  if (/^https?:\/\//i.test(c.ref)) return allowedHref ? { kind: 'page', href: allowedHref, title } : null;
  const lower = c.ref.toLowerCase().split(/[?#]/)[0];
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return { kind: 'html', path: c.ref, title };
  if (inlineMediaKind(c.ref) === 'image') return { kind: 'image', path: c.ref, title };
  if (lower.endsWith('.pdf')) return { kind: 'pdf', path: c.ref, title };
  return null;
}

export const KIND_GLYPH: Record<Container['kind'], string> = {
  chat: '◆', insight: '◔', task: '☐', knowledge: '¶', whiteboard: '▦', board: '▦', web: '◎', image: '▣', pdf: '▥', video: '▶', browser: '◉', team: '◈', agenda: '☰',
};

/** A whiteboard's board file, from its slug (`whiteboards/<slug>/<slug>.excalidraw.md`). */
export function whiteboardPath(slug: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(slug) ? `_dream_context/whiteboards/${slug}/${slug}.excalidraw.md` : null;
}

export { useLiveSession } from './liveSession';

/** What a card's FRAME draws from its chat: the glow and tone (the status) and whether closing
 *  it offers "end when done". A token changes none of it; the tile's own line is the tile's. */
export function frameKeyOf(session: ChatSession | undefined): string {
  return `${chatStatus(session).kind}|${session?.hasLiveWork() ? 1 : 0}`;
}

export function chatStatus(session: ChatSession | undefined): SessionStatusInfo {
  return deriveSessionStatus({
    dormant: !session, status: session?.status, busy: session?.busy, asking: session?.asking,
    // A shell it left running in the background is work still under way: its turn ended, its
    // job did not (field 2026-10-22: "done" over a 10-minute script with its own ⧉ 1 chip).
    agentsWorking: !!session?.agentsWorking || backgroundShellsRunning(session),
  });
}

function backgroundShellsRunning(session: ChatSession | undefined): boolean {
  const model = session?.getModel();
  return !!model && backgroundOf(model.subAgents).shells > 0;
}

/** The Super Agent's centre: its chat's status, `asking` while a question it put to the owner
 *  waits (deriveSessionStatus ranks asking over busy, exactly as for a chat's own card). */
export function superCentreStatus(session: ChatSession | undefined, ownerAsk: boolean): SessionStatusInfo {
  return deriveSessionStatus({
    dormant: !session, status: session?.status, busy: session?.busy, asking: !!session?.asking || ownerAsk,
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
  /** The owner sizes a card (the size menu). */
  onSize: (id: string, size: ContainerSize) => void;
  /** Inspect picked an element in a web card's page: it goes to the Super Agent's composer. */
  onPickElement?: (id: string, pick: WebPick, page: string) => void;
  /** Open what the card shows full screen. */
  onFullscreen: (id: string, subject: CardFullscreen) => void;
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
  /** `web`: holds its frame right now (webBudget.ts `keptWebIds`): on screen it is drawn; parked
   *  it lives on, hidden, so a move, a group or Others never reloads the page. */
  webLive: boolean;
  /** A web card off the stage (in Others, in a group, the stage folded) kept ALIVE: drawn hidden at
   *  its last rect, without a stage key (the motion never sees it), inert. */
  parked?: boolean;
  /** `browser`: the child's `ChatSession.id` (the live frames' key), and whether this card may
   *  re-render on new frames right now (at most two, on screen, window focused). */
  browserSessionId?: string;
  browserLive?: boolean;
  /** A one-time cue playing on this card (AC16, useStageCues): `close` = a card fading out. */
  cue?: StageCue;
  /** The hand-over has landed: a non-chat card may mount its view (SuperSurface). */
  viewReady: boolean;
  asksOwner: AsksOwner;
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
  /** `team`: the AI Team job behind the card and its status now. */
  team?: TeamCard;
  /** A floating card's side of the stage: its corner handle sits on the outer corner. */
  side?: 'left' | 'right';
  /** Whether a size can be drawn for this card now (the menu disables one that cannot). */
  canFit?: (size: ContainerSize) => boolean;
  /** The corner handle pressed (useStageDrag). */
  onPressResize?: (e: PointerEvent<HTMLElement>, id: string) => void;
  /** `agenda`: the super's agenda as this card draws it (SuperAgenda), the counts tile or the list. */
  agenda?: (variant: 'tile' | 'full', wide: boolean) => ReactNode;
  /** A web page shown big in a presentation (spotlight, review, a filmstrip's big card): laid
   *  out at a desktop width and scaled to the card (plan-r2 D8). */
  desktopViewport?: boolean;
  /** A filmstrip thumb pressed: it becomes the big card. */
  onSelectThumb?: (id: string) => void;
}

/**
 * One card on the stage (plan-r8 F5, F6, F11; owner decisions O1-O6, O10). Look, move, put
 * aside, close, ask about — never type. Two layers (§0 FE5): the outer FRAME is positioned from
 * the plan and carries the motion transform, the two glow layers (accent while working, the
 * waiting colour while asking, each fading its own opacity) and the lift shadow; the inner CLIP
 * rounds and clips the content. A floating card is one grab handle: its body is inert, a click
 * shows it side by side; content is interactive only in half and present, where a picture or a
 * page also zooms in place (ZoomPane).
 */
export function SuperContainer(props: SuperContainerProps) {
  const { container: c, plan, pending, session } = props;
  const { t } = useI18n();
  // The frame follows only its chat's status (frameKeyOf); the tile and the large card follow
  // the session's every change themselves (liveSession.ts).
  const liveChat = c.kind === 'chat' ? session : undefined;
  useLiveSession(liveChat, () => frameKeyOf(liveChat));
  const status = c.kind === 'chat' ? chatStatus(session) : null;
  const floating = plan.where === 'float';
  const large = plan.where === 'half' || plan.where === 'present' || plan.where === 'sheet';
  // A filmstrip thumb (plan-r2 D13): a static tile, never a live page, never dragged; a press
  // makes it the big card.
  const thumb = plan.where === 'thumb' && !props.parked;
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
  // A page's frame allowed and shown (its trust gate passed): from then on it may open full screen.
  const [allowedHref, setAllowedHref] = useState<string | null>(null);
  const full = fullscreenOf(c, props.title, allowedHref);
  const openFull = full ? () => (full.kind === 'video' ? videoFullscreen() : props.onFullscreen(c.id, full)) : undefined;
  // The size menu (and, on a small tile, the "more" menu that holds it). A card parked off the
  // stage closes it (a hidden menu would keep the window's arrow keys and Esc).
  const [menu, setMenu] = useState<null | 'size' | 'more'>(null);
  useEffect(() => { if (props.parked) setMenu(null); }, [props.parked]);
  const drawnSize: ContainerSize = plan.size ?? sizeOf(c);
  const frameRef = useRef<HTMLDivElement | null>(null);
  // A clip full screen is its own player's (MediaEmbed's `<video>`, no second player); a tile
  // that draws none yet shows it side by side, where it plays.
  const videoFullscreen = () => {
    const v = frameRef.current?.querySelector<HTMLVideoElement & { webkitEnterFullscreen?: () => void }>('video');
    if (!v) { props.onSideBySide(c.id); return; }
    if (v.requestFullscreen) void v.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
    else v.webkitEnterFullscreen?.();
  };
  const small = drawnSize === 'small';
  const closeLabel = asksOnClose ? t('super.close.chatLabel') : t('super.container.close');
  // The agenda is never closed: its close collapses it to its pill in the bottom-left corner.
  const closeBtn = c.kind === 'agenda'
    ? <IconButton icon="corner" label={t('super.agenda.minimize')} onClick={onCloseClick} testId="super-agenda-minimize" />
    : <IconButton icon="close" label={closeLabel} onClick={onCloseClick} testId="super-card-close" />;
  // A floating card's one action, for a click and for Enter/Space alike: a team card opens its
  // member in AI Team (where the job is), any other card shows side by side.
  const openCard = () => {
    if (c.kind === 'team') { if (props.team) requestOpenAgents({ slug: props.team.job.member }); return; }
    // The agenda's list is live on its card (its rows are the buttons): a click between them is
    // no "show side by side". Its counts tile opens like any card.
    if (c.kind === 'agenda' && !small && drawnSize !== 'medium') return;
    props.onSideBySide(c.id);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !(floating || thumb)) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (thumb) props.onSelectThumb?.(c.id); else openCard(); }
  };
  return (
    <div
      ref={frameRef}
      className={`super-card-frame${pending ? ' super-card-frame--pending' : ''}${props.parked ? ' super-card-frame--parked' : ''}`}
      data-testid={props.parked ? 'super-container-parked' : 'super-container'}
      data-stage-key={props.parked ? undefined : c.id}
      data-container-id={c.id}
      data-kind={c.kind}
      data-where={plan.where}
      data-shape={plan.shape}
      data-size={floating ? drawnSize : undefined}
      data-side={floating ? props.side : undefined}
      data-owner={plan.owner ? 'true' : undefined}
      data-status={status ? glowOf(status) : undefined}
      data-super-tone={status ? toneOfStatus(status.kind) : props.team ? toneOfStatus(teamRingKind(teamStatusOf(props.team))) : undefined}
      data-drop-target={props.dropTarget ? 'card' : undefined}
      data-cue={props.cue?.kind}
      inert={props.cue?.kind === 'close' || props.parked ? true : undefined}
      aria-hidden={props.parked ? true : undefined}
      role={thumb ? 'button' : 'group'}
      aria-label={thumb ? t('super.layout.thumb').replace('{title}', props.title) : props.title}
      tabIndex={(floating || thumb) && !props.parked ? 0 : -1}
      style={{
        left: plan.rect.x, top: plan.rect.y, width: plan.rect.width, height: plan.rect.height, zIndex: cardZIndex(plan.z, c.kind === 'agenda'),
        ...(props.cue ? { ['--cue-dx' as string]: `${props.cue.dx}px`, ['--cue-dy' as string]: `${props.cue.dy}px` } : {}),
      }}
      onPointerDown={floating && !props.parked ? (e) => { if (!inFullscreen(e.target)) props.onPress(e, c.id); } : undefined}
      onClick={thumb ? () => props.onSelectThumb?.(c.id)
        : floating && !props.parked ? (e) => { if (!(e.target as HTMLElement).closest('button') && !inFullscreen(e.target)) openCard(); } : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="super-card-lift" aria-hidden />
      <div className="super-card-clip">
        {c.kind === 'web'
          // A web card keeps ONE tree whatever the card does, so its frame never remounts: a
          // page from a server keeps what the owner did in it (owner 2026-10-22: "every reload
          // loses what I did"), a project page loads once (owner 2026-10-23: it reloaded on
          // its way to side by side, its pictures went blank and came back).
          ? <WebCardBody {...props} status={status} onFrameAllowed={setAllowedHref} large={large && !props.parked} />
          : large
            ? <LargeBody {...props} status={status} onFrameAllowed={setAllowedHref} />
            : <FloatBody {...props} status={status} onFrameAllowed={setAllowedHref} />}
      </div>
      <span className="super-drop-ring" aria-hidden />
      {props.cue && <span className="super-card-glint" aria-hidden />}
      {!thumb && <div className="super-card-actions">
        {floating ? (
          <>
            <IconButton icon="side" label={t('super.card.sideBySide')} onClick={() => props.onSideBySide(c.id)} />
            <IconButton icon="others" label={t('super.card.toOthers')} onClick={() => props.onToOthers(c.id)} />
            <IconButton icon="ask" label={t('super.card.askAbout')} onClick={() => props.onAskAbout(c.id)} testId="super-card-ask" />
            {small ? (
              // A 160 px tile has room for five buttons: size and full screen share one menu.
              <IconButton icon="more" label={t('super.card.more')} onClick={() => setMenu((m) => (m ? null : 'more'))} testId="super-card-more" expanded={!!menu} />
            ) : (
              <>
                <IconButton icon="size" label={t('super.size.label')} onClick={() => setMenu((m) => (m === 'size' ? null : 'size'))} testId="super-card-size-btn" expanded={menu === 'size'} />
                {openFull && <IconButton icon="fullscreen" label={t('super.card.fullscreen')} onClick={openFull} testId="super-card-fullscreen" />}
              </>
            )}
            {closeBtn}
          </>
        ) : (
          <>
            <IconButton icon="ask" label={t('super.card.askAbout')} onClick={() => props.onAskAbout(c.id)} testId="super-card-ask" />
            {openFull && <IconButton icon="fullscreen" label={t('super.card.fullscreen')} onClick={openFull} testId="super-card-fullscreen" />}
            <IconButton icon="minimize" label={t('super.card.minimize')} onClick={() => props.onMinimize(c.id)} testId="super-card-minimize" />
            {closeBtn}
          </>
        )}
      </div>}
      {floating && !props.parked && menu && (
        <SizeMenu
          current={sizeOf(c)}
          drawn={drawnSize}
          canFit={props.canFit ?? (() => true)}
          onPick={(size) => { setMenu(null); props.onSize(c.id, size); }}
          onFullscreen={menu === 'more' && openFull ? () => {
            // The viewer gives focus back to what had it when it opened: the ⋯ button, not the
            // menu item about to unmount (which would leave focus on <body>).
            frameRef.current?.querySelector<HTMLElement>('[data-testid="super-card-more"]')?.focus();
            setMenu(null);
            openFull();
          } : undefined}
          onClose={() => setMenu(null)}
        />
      )}
      {floating && props.onPressResize && (
        <button
          type="button"
          className="super-card-resize"
          data-testid="super-card-resize"
          tabIndex={-1}
          aria-label={t('super.size.handle')}
          title={t('super.size.handle')}
          onPointerDown={(e) => props.onPressResize!(e, c.id)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
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

/** A press inside what is full screen now (a floating clip's own player): the player's, never the
 *  card's grab or "show side by side", which would move the card or remount the player. */
function inFullscreen(target: EventTarget): boolean {
  const fs = document.fullscreenElement;
  return !!fs && target instanceof Node && fs.contains(target);
}

/** working → the accent glow rises; asking → the waiting glow; anything else fades (F5). */
function glowOf(s: SessionStatusInfo): 'working' | 'asking' | 'idle' {
  return s.kind === 'asking' ? 'asking' : s.kind === 'working' ? 'working' : 'idle';
}

type IconName = 'side' | 'others' | 'corner' | 'ask' | 'close' | 'minimize' | 'ungroup' | 'size' | 'fullscreen' | 'more';

const ICONS: Record<IconName, ReactNode> = {
  side: <><rect x="2" y="3" width="5" height="10" rx="1.4" /><rect x="9" y="3" width="5" height="10" rx="1.4" /></>,
  others: <><path d="M3.5 3.5l6 6" /><path d="M10 5v5H5" /><path d="M3 13h10" /></>,
  /** Others' mirror: to the bottom-left corner (the agenda's pill). */
  corner: <><path d="M12.5 3.5l-6 6" /><path d="M6 5v5h5" /><path d="M3 13h10" /></>,
  ask: <><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.4V11h0A1 1 0 0 1 3 10z" /></>,
  close: <><path d="M4.5 4.5l7 7" /><path d="M11.5 4.5l-7 7" /></>,
  minimize: <><path d="M9.5 3.5v3h3" /><path d="M6.5 12.5v-3h-3" /><path d="M9.5 6.5l3.5-3.5" /><path d="M6.5 9.5L3 13" /></>,
  ungroup: <><rect x="2.5" y="2.5" width="5" height="5" rx="1.2" /><rect x="8.5" y="8.5" width="5" height="5" rx="1.2" /><path d="M10 3.5h2.5V6" /><path d="M6 12.5H3.5V10" /></>,
  size: <><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="11" height="4.5" rx="1" /></>,
  fullscreen: <><path d="M3 6.5V3h3.5" /><path d="M13 6.5V3H9.5" /><path d="M3 9.5V13h3.5" /><path d="M13 9.5V13H9.5" /></>,
  more: <><circle cx="4" cy="8" r="0.9" /><circle cx="8" cy="8" r="0.9" /><circle cx="12" cy="8" r="0.9" /></>,
};

export function IconButton({ icon, label, onClick, testId, expanded }: { icon: IconName; label: string; onClick: () => void; testId?: string; expanded?: boolean }) {
  return (
    <button
      type="button"
      className="super-icon-btn"
      data-testid={testId}
      aria-expanded={expanded}
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

type BodyProps = SuperContainerProps & { status: SessionStatusInfo | null; onFrameAllowed: (href: string) => void };

const widgetSize = (p: CardPlan): WidgetSize => {
  if (p.where !== 'float') return p.rect.width >= 520 ? 'xl' : 'l';
  return p.rect.width >= 520 ? 'l' : p.rect.width >= 200 ? 'm' : 's';
};

/**
 * A floating card, what it is at a glance; the body is inert (the card is a grab handle). Small
 * (1×1) and medium (2×1) are tiles, medium with room for more; large (2×2) and wide (3×2) draw the
 * card's own view inside the tile (owner 2026-10-22: "like Apple widgets"), a web page live only
 * within the frame budget.
 */
function FloatBody(p: BodyProps): ReactNode {
  const c = p.container;
  const size = p.plan.size ?? 'small';
  if (c.kind === 'agenda' && SIZE_UNITS[size].h === 1) {
    return (
      <div className="super-card-body" data-inert="true">
        <CardHead kind={c.kind} title={p.title} />
        {p.agenda?.('tile', size === 'medium')}
      </div>
    );
  }
  if (SIZE_UNITS[size].h > 1 && c.kind !== 'chat') {
    return (
      <div className="super-card-body super-card-large" data-inert={c.kind === 'agenda' ? undefined : 'true'}>
        <CardHead kind={c.kind} title={p.title} container={c} />
        <div className="super-card-large-body">{viewFor(p)}</div>
      </div>
    );
  }
  return (
    <div className="super-card-body" data-inert="true">
      {c.kind === 'chat'
        ? (SIZE_UNITS[size].h > 1
          ? <AgentCard session={p.session} child={p.child} title={p.title} asksOwner={p.asksOwner} status={p.status!} tall />
          : <ChatTile session={p.session} child={p.child} title={p.title} asksOwner={p.asksOwner} status={p.status!} />)
        : c.kind === 'browser'
          ? <BrowserCard sessionId={p.browserSessionId} live={!!p.browserLive} large={false} />
          : c.kind === 'team' && p.team
            ? <TeamTile card={p.team} />
            : <KindTile container={c} title={p.title} viewReady={p.viewReady} wide={size === 'medium'} />}
    </div>
  );
}

/**
 * The size menu (owner 2026-10-22): the four presets as little grids, the card's own marked; one
 * that cannot be drawn on this stage now is disabled and says why. Arrow keys move, Enter picks,
 * Esc closes. On a small tile it is the "more" menu and also holds Full screen.
 */
function SizeMenu({ current, drawn, canFit, onPick, onFullscreen, onClose }: {
  current: ContainerSize; drawn: ContainerSize; canFit: (size: ContainerSize) => boolean;
  onPick: (size: ContainerSize) => void; onFullscreen?: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  // The card re-renders on every push while its agent works: the menu takes focus ONCE, when it
  // opens, and reads the latest close through a ref (a new arrow each render must not re-run it).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    (ref.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)') ?? items()[0])?.focus();
    const onClose = () => closeRef.current();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const list = items();
      if (!list.length) return;
      e.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      list[(at + step + list.length) % list.length].focus();
    };
    // Outside the menu closes it; its own card's toggle toggles it (closing here would reopen it).
    const toggle = ref.current?.parentElement?.querySelector('[data-testid="super-card-more"], [data-testid="super-card-size-btn"]') ?? null;
    const onDown = (e: globalThis.PointerEvent) => {
      const el = e.target as Node | null;
      if (!ref.current?.contains(el) && !(toggle && el && toggle.contains(el))) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, []);
  return (
    <div ref={ref} className="super-size-menu" role="menu" aria-label={t('super.size.label')} data-testid="super-card-size"
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="super-size-menu-title">{t('super.size.label')}</div>
      <div className="super-size-menu-row">
        {CONTAINER_SIZES.map((size) => {
          const fits = size === 'small' || canFit(size);
          const u = SIZE_UNITS[size];
          return (
            <button
              key={size}
              type="button"
              role="menuitemradio"
              aria-checked={current === size}
              className="super-size-option"
              data-size={size}
              data-testid={`super-size-${size}`}
              disabled={!fits}
              title={fits ? t(`super.size.${size}.hint`) : t('super.size.noRoom')}
              onClick={() => { if (size !== current || drawn !== size) onPick(size); else onClose(); }}
            >
              <svg width="30" height="20" viewBox="0 0 30 20" aria-hidden>
                {[0, 1, 2].map((x) => [0, 1].map((y) => (
                  <rect key={`${x}${y}`} x={x * 10 + 1} y={y * 10 + 1} width="8" height="8" rx="1.5"
                    className={x < u.w && y < u.h ? 'super-size-cell super-size-cell--on' : 'super-size-cell'} />
                )))}
              </svg>
              <span>{t(`super.size.${size}`)}</span>
            </button>
          );
        })}
      </div>
      {!fits(current, drawn) && <p className="super-size-menu-note">{t('super.size.drawnSmaller')}</p>}
      {onFullscreen && (
        <button type="button" role="menuitem" className="super-size-menu-item" data-testid="super-card-fullscreen" onClick={onFullscreen}>
          {t('super.card.fullscreen')}
        </button>
      )}
    </div>
  );
}

/** The record's size is drawn as is (false: the stage drew it smaller for want of room). */
const fits = (current: ContainerSize, drawn: ContainerSize) => current === drawn;

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
          : zoomsInPlace(c)
            // A picture or a live browser zooms where it is (owner 2026-10-22); a page does in WebCardBody.
            ? <ZoomPane key={c.id}>{viewFor(p)}</ZoomPane>
            : viewFor(p)}
      </div>
    </div>
  );
}

/** The size a hidden page keeps (a 1×1 tile, parked off the stage): the last size it was drawn
 *  at, so a responsive app does not re-lay itself out (and drop state) at tile width. */
const KEEP_DEFAULT = { w: 960, h: 640 };

/**
 * A web card's body (owner 2026-10-22), the same elements in every state: a tile (its KindTile
 * drawn over the hidden page), a large floating card, side by side or presented, parked off the
 * stage. The frame mounts while the card holds one (`webLive`) and is never rebuilt by a move;
 * hidden, it keeps the last size it was drawn at.
 *
 * A live page (a site, a dev server) gets the bar (Reload, Clear cache, Inspect) and its picks go
 * to the composer. A project page is read by the board's reader with its zoom bridge in EVERY
 * state (the pane reads it only while interactive), so its srcdoc never changes and the frame
 * never reloads; it is never parked (webBudget: a project file holds a frame only on screen).
 */
function WebCardBody(p: BodyProps & { large: boolean }): ReactNode {
  const c = p.container;
  const live = isLivePage(c);
  const size = p.plan.size ?? 'small';
  const tile = !p.large && !p.parked && SIZE_UNITS[size].h === 1;
  const hidden = tile || !!p.parked;
  const [control] = useState(() => new WebFrameControl());
  const onPick = p.onPickElement;
  useEffect(() => control.subscribe({ pick: (pick) => onPick?.(c.id, pick, control.pageHref() || pick.href) }), [control, onPick, c.id]);
  // The last size the page was drawn at (measured while shown).
  const keepRef = useRef<HTMLDivElement | null>(null);
  const [keep, setKeep] = useState(KEEP_DEFAULT);
  useLayoutEffect(() => {
    const el = keepRef.current;
    if (!el || hidden) return undefined;
    const measure = () => { if (el.clientWidth > 40 && el.clientHeight > 40) setKeep({ w: el.clientWidth, h: el.clientHeight }); };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hidden]);
  const keepStyle: CSSProperties | undefined = hidden
    ? { position: 'absolute', left: 0, top: 0, width: keep.w, height: keep.h, visibility: 'hidden', pointerEvents: 'none' }
    : undefined;
  // The desktop width (plan-r2 D8, R3(e)): asked while shown in spotlight or review, FROZEN while
  // the frame is parked (a thumb, Others, floating): the hidden box keeps its last size, so the
  // page keeps its width and scale and never re-lays itself out.
  const desktopRef = useRef(false);
  if (!hidden) desktopRef.current = !!p.desktopViewport && p.large;
  const desktop = desktopRef.current;
  const frame = p.webLive && p.viewReady;
  return (
    <div className={p.large ? 'super-card-large' : tile ? 'super-card-body' : 'super-card-body super-card-large'}
      data-inert={p.large ? undefined : 'true'} data-testid="super-web-card" data-web-state={p.parked ? 'parked' : tile ? 'tile' : p.large ? 'large' : 'float'}>
      {!tile && <CardHead kind={c.kind} title={p.title} container={c} />}
      <div className="super-card-large-body super-web-body">
        <div ref={keepRef} className="super-web-keep" style={keepStyle}>
          <ZoomPane live={live} interactive={p.large} control={live ? control : undefined}>
            {frame
              ? <div className="super-card-view super-card-view--web"><WebWidget elementId={`super-${c.id}`} payload={{ v: 1, kind: 'web', url: c.ref, title: c.title }} active size={widgetSize(p.plan)} onFrameAllowed={p.onFrameAllowed} control={live ? control : undefined} zoomBridge={!live} desktop={desktop} /></div>
              : null}
          </ZoomPane>
        </div>
        {/* Past the budget: its title and Load (never during the layout flight, when no view draws yet). */}
        {p.viewReady && !p.webLive && !tile && !p.parked && <WebPlaceholder title={c.title || c.ref} onLoad={() => p.onLoadWeb(c.id)} />}
        {tile && <div className="super-web-tile"><KindTile container={c} title={p.title} viewReady={p.viewReady} wide={size === 'medium'} /></div>}
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

/** The cards whose large view zooms in place: a picture, a web page or file (in WebCardBody's own
 *  pane), a live browser. */
export function zoomsInPlace(c: Container): boolean {
  return c.kind === 'image' || c.kind === 'web' || c.kind === 'browser';
}

/** A page served by a server (a site, a dev server): its frame cannot carry the zoom bridge. */
export function isLivePage(c: Container): boolean {
  return c.kind === 'web' && /^https?:\/\//i.test(c.ref);
}

/** A card's own view. A web card never comes here: it draws through {@link WebCardBody}. */
function viewFor(p: BodyProps): ReactNode {
  const c = p.container;
  // The agenda reads the pushed record only (no fetch, no layout of its own): it draws at once.
  if (c.kind === 'agenda') return p.agenda?.('full', false) ?? null;
  if (!p.viewReady) return null;
  const size = widgetSize(p.plan);
  switch (c.kind) {
    case 'insight':
      return <InsightCard container={c} size={size} elementId={`super-${c.id}`} />;
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
    case 'image':
      return <div className="super-card-view"><DocumentReader path={c.ref} onOpen={() => { /* read-only: links stay closed */ }} embedded /></div>;
    case 'pdf':
    case 'video':
      // The chat's own viewers through the shared reader: a PDF in PdfViewer (embedded), a clip in
      // MediaEmbed (controls, never autoplay). Off the stage the card is not drawn, so a clip
      // stops with it; a floating card's body is inert, so it plays once shown side by side.
      return <div className={`super-card-view super-card-view--${c.kind}`}><DocumentReader path={c.ref} onOpen={() => { /* read-only: links stay closed */ }} embedded /></div>;
    case 'browser':
      return <div className="super-card-view super-card-view--browser"><BrowserCard sessionId={p.browserSessionId} live={!!p.browserLive} large /></div>;
    case 'team':
      return p.team ? <div className="super-card-view super-card-view--team"><TeamTile card={p.team} /></div> : null;
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
