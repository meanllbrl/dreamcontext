import { useState, type KeyboardEvent } from 'react';
import { STAGE, type Rect, type StagePlan, type StripPlan } from './superLayout';
import { KindTile } from './SuperTiles';
import type { PresentLayout, SuperContainer, SuperQueueItem, SuperStateView } from '../../../lib/superTypes';
import { useI18n } from '../../../context/I18nContext';
import type { ChatSession } from '../chatSession';
import { ChatTile, type AsksOwner } from './AgentCard';
import { chatStatus, type RemoteRow } from './SuperContainer';
import { useLiveSession } from './liveSession';
import { toneOfStatus } from './superHandover';

/** A chat in an open panel: the same tile as on the stage, live, glowing as it does there. */
export function PanelChatTile({ session, child, title, asksOwner, askItem, remoteChild }: { session: ChatSession | undefined; child: SuperStateView['children'][string] | undefined; title: string; asksOwner: AsksOwner; askItem?: SuperQueueItem | null; remoteChild?: RemoteRow | null }) {
  // The panel's frame follows the status; the tile inside follows its own lines.
  useLiveSession(session, () => chatStatus(session).kind);
  const status = chatStatus(session, remoteChild);
  return (
    <div className="super-panel-tile" data-status={status.kind === 'asking' ? 'asking' : status.kind === 'working' ? 'working' : 'idle'} data-super-tone={toneOfStatus(status.kind)}>
      <div className="super-panel-clip"><ChatTile session={session} child={child} title={title} asksOwner={asksOwner} askItem={askItem} status={status} /></div>
    </div>
  );
}

/**
 * The orbit (owner 2026-10-20): a faint dashed arc through each side's inner tiles, fading at its
 * ends, under the centre (its ends slip behind it). Static: it is redrawn with the plan, never
 * animated.
 */
export function OrbitPath({ plan }: { plan: StagePlan }) {
  const T = STAGE.TILE;
  return (
    <svg className="super-orbit" width={plan.width} height={plan.height} aria-hidden>
      {plan.orbit.map((a) => {
        const span = a.ymax + T / 2 + STAGE.GAP + 40;
        const pts: string[] = [];
        for (let y = a.cy - span; y <= a.cy + span + 0.01; y += 6) {
          const k = (y - a.cy) / a.ymax;
          pts.push(`${(a.x0 + a.dir * a.depth * (1 - k * k)).toFixed(1)},${y.toFixed(1)}`);
        }
        const id = `super-orbit-fade-${a.side}`;
        return (
          <g key={a.side}>
            <defs>
              <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1={a.cy - span} x2="0" y2={a.cy + span}>
                <stop offset="0" className="super-orbit-stop" stopOpacity="0" />
                <stop offset="0.25" className="super-orbit-stop" stopOpacity="0.45" />
                <stop offset="0.75" className="super-orbit-stop" stopOpacity="0.45" />
                <stop offset="1" className="super-orbit-stop" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polyline points={pts.join(' ')} fill="none" stroke={`url(#${id})`} strokeWidth={1.2} strokeDasharray="2 6" strokeLinecap="round" />
          </g>
        );
      })}
    </svg>
  );
}



/** Open overlays that own Esc and the arrows over a presentation. A PDF card draws the chat's
 *  PdfViewer embedded (`.pdf-viewer--embedded`): that is a card, not a window over the stage, so a
 *  presentation showing a PDF still leaves on Esc (owner 2026-10-28, "every kind of group"). */
export const PRESENT_KEY_OWNERS = '.image-viewer, .pdf-viewer:not(.pdf-viewer--embedded), .fullscreen-overlay, .quest-receipt-scrim, .agent-composer-menu, .cmd-modal, .agent-tab-menu, .agent-new-menu, .app-popup-scrim';

/** The presentation frame's icons (outline, 16 px on a 32 px button; owner 2026-11-15, option C). */
const PATHS: Record<string, string> = {
  spotlight: 'M3 5h18v14H3z',
  compare: 'M3 5h8v14H3zM13 5h8v14h-8z',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  filmstrip: 'M3 3h18v12H3zM3 18h4v3H3zM10 18h4v3h-4zM17 18h4v3h-4z',
  review: 'M3 4h11v16H3zM17 4h4v16h-4z',
  ask: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  close: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  minimize: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  exit: 'M18 6 6 18M6 6l12 12',
};
export function StageIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? PATHS.exit} />
    </svg>
  );
}

/**
 * A presentation's actions as icons at the top band's right end (owner 2026-11-15, option C
 * "Çerçeve"): the layouts these cards can take (only when there is a choice), then the way out.
 * Every icon names itself on hover and focus (`data-tip`) and to a screen reader (`aria-label`).
 * The box is exactly as wide as superLayout's `controlsWidth` plans it.
 */
export function StageControls({ rect, layouts, current, onPick, onExit, toGroup = false, closable = 0, onCloseGroup, onAsk, leaveQueue = false }: {
  rect: Rect; layouts: readonly PresentLayout[]; current: PresentLayout; onPick: (l: PresentLayout) => void; onExit: () => void;
  /** The presentation shows one group whole: "Minimize" goes back to that group's panel, "Close group" closes its cards. */
  toGroup?: boolean;
  /** How many of the group's cards a close would end (running jobs stay); 0 draws the button off. */
  closable?: number;
  onCloseGroup?: () => void;
  /** "Ask about this" on the group (owner 2026-11-14): the same about-card chip a group tile's ask puts in the Super composer. */
  onAsk?: () => void;
  /** A queued presentation of 2+ is shown: the exit leaves the queue (the rest keep waiting). */
  leaveQueue?: boolean;
}) {
  const { t } = useI18n();
  const [ask, setAsk] = useState(false);
  const icon = (name: string, label: string, onClick: () => void, extra: { testid: string; pressed?: boolean; disabled?: boolean; expanded?: boolean; layout?: string; title?: string }) => (
    <button key={extra.testid} type="button" className="super-icon-btn" data-testid={extra.testid} data-tip={label} aria-label={label}
      aria-pressed={extra.pressed} aria-expanded={extra.expanded} disabled={extra.disabled} data-layout={extra.layout} title={extra.title} onClick={onClick}>
      <StageIcon name={name} />
    </button>
  );
  return (
    <div className="super-stage-controls" data-testid="super-stage-controls" data-asking={ask && toGroup ? "true" : undefined} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <div className="super-icon-bar">
        {layouts.length > 1 && (
          <>
            <div className="super-layout-switch" role="group" aria-label={t('super.layout.switch')} data-testid="super-layout-switch">
              {layouts.map((l) => icon(l, t(`super.layout.${l}`), () => { if (l !== current) onPick(l); }, { testid: `super-layout-${l}`, pressed: l === current, layout: l }))}
            </div>
            <span className="super-icon-sep" aria-hidden />
          </>
        )}
        {toGroup ? (
          <>
            {onAsk && icon('ask', t('super.card.askAbout'), onAsk, { testid: 'super-stage-group-ask' })}
            {icon('close', t('super.stage.closeGroup'), () => setAsk((v) => !v), { testid: 'super-stage-group-close', disabled: closable < 1 || !onCloseGroup, expanded: ask })}
            {icon('minimize', t('super.card.minimize'), onExit, { testid: 'super-stage-group-minimize', title: 'Esc' })}
          </>
        ) : icon(leaveQueue ? 'minimize' : 'exit', t(leaveQueue ? 'super.stage.leaveQueue' : 'super.stage.exit'), onExit, { testid: 'super-stage-exit', title: leaveQueue ? undefined : 'Esc' })}
      </div>
      {toGroup && ask && closable > 0 && (
        <div className="super-close-choice super-stage-group-ask" role="group" aria-label={t('super.group.closeAsk')} data-testid="super-stage-group-close-choice">
          <span className="super-close-choice-q">{t('super.group.closeAsk')}</span>
          <button type="button" className="super-close-choice-btn super-close-choice-btn--end" data-testid="super-stage-group-close-end"
            onClick={() => { setAsk(false); onCloseGroup?.(); }}>
            {t('super.group.closeEnd').replace('{n}', String(closable))}
          </button>
        </div>
      )}
    </div>
  );
}

/** One tab of the presentation frame: what is shown, what comes next, what waits after it. */
export interface PresentTab { key: string; name: string; count: number; kind: 'current' | 'next' | 'later' }

/**
 * The presentation's frame and its tab strip (owner 2026-11-15, option C "Çerçeve"): the shown
 * presentation is the open tab, joined to the frame; the next one sits beside it and opens on a
 * click; the rest wait as quiet tabs. Tabs shrink and truncate like browser tabs, so the strip
 * never reaches the icons whatever the width.
 */
export function PresentFrame({ frame, strip, tabs, onNext }: { frame?: Rect; strip: Rect; tabs: readonly PresentTab[]; onNext: () => void }) {
  const { t } = useI18n();
  return (
    <>
      {frame && <div className="super-present-frame" data-testid="super-present-frame" aria-hidden style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }} />}
      <div className="super-present-tabs" role="group" aria-label={t('super.pq.label')} data-testid="super-present-tabs" style={{ left: strip.x, top: strip.y, width: strip.width, height: strip.height }}>
        {tabs.map((tab) => {
          const label = tab.kind === 'next' ? t('super.pq.next').replace('{name}', tab.name) : tab.name;
          return (
            <button key={tab.key} type="button" className="super-present-tab" data-kind={tab.kind} aria-current={tab.kind === 'current' ? 'true' : undefined}
              data-testid={tab.kind === 'next' ? 'super-pq-next' : `super-present-tab-${tab.kind}`} disabled={tab.kind === 'later'} title={label}
              tabIndex={tab.kind === 'later' ? -1 : 0} onClick={tab.kind === 'next' ? onNext : undefined}>
              {tab.kind === 'current' && <span className="super-present-tab-dot" aria-hidden />}
              <span className="super-present-tab-name">{tab.name}</span>
              {tab.count > 1 && <span className="super-present-tab-count">{tab.count}</span>}
              {tab.kind === 'next' && <span className="super-present-tab-badge">{t('super.pq.nextBadge')}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** A narrow stage's tab row over the chat (owner 2026-11-17): one tab per card the view shows.
 *  Folded, every tab is closed and the chat runs full height under the row; the open one is
 *  expanded, pressing it again or the row's × folds it. Arrows move between the tabs. */
export function SheetTabs({ rect, ids, open, titleOf, onSelect, onFold }: {
  rect: Rect; ids: readonly string[]; open: string | null; titleOf: (id: string) => string; onSelect: (id: string) => void; onFold: () => void;
}) {
  const { t } = useI18n();
  // ←/→ walk the tabs' focus while folded; Enter or a press opens one (the open one folds). Open,
  // the stage's own arrow keys move the open card instead.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const row = e.currentTarget;
    const tabs = [...row.querySelectorAll<HTMLElement>('[data-tab-id]')];
    const i = tabs.findIndex((el) => el === document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]?.focus();
  };
  return (
    <div className="super-sheet-tabs" role="group" aria-label={t('super.layout.tab')} data-testid="super-sheet-tabs" data-folded={open ? undefined : 'true'} onKeyDown={onKey}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      {ids.map((id) => {
        const title = titleOf(id);
        const isOpen = id === open;
        return (
          <button key={id} type="button" className="super-sheet-tab" aria-expanded={isOpen}
            aria-label={t(isOpen ? 'super.layout.foldTab' : 'super.layout.openTab').replace('{title}', title)}
            data-testid="super-sheet-tab" data-tab-id={id} onClick={() => onSelect(id)}>
            <span className="super-sheet-tab-name">{title}</span>
            <span className="super-sheet-tab-chev" aria-hidden>{isOpen ? '▴' : '▾'}</span>
          </button>
        );
      })}
      {open && (
        <button type="button" className="super-sheet-fold" data-testid="super-sheet-fold" aria-label={t('super.layout.fold')} title={t('super.layout.fold')} onClick={onFold}>×</button>
      )}
    </div>
  );
}

/**
 * A filmstrip's own marks (owner 2026-10-29: "the selected one must also show in the strip"):
 * the big card's slot, in its fixed place, drawn as its tile and marked current; the scroll
 * buttons while the strip holds more than fit. The other slots are the cards themselves.
 */
export function StripMarks({ strip, big, title, viewReady, onScroll }: {
  strip: StripPlan; big: SuperContainer | undefined; title: string; viewReady: boolean; onScroll: (start: number) => void;
}) {
  const { t } = useI18n();
  const at = strip.ids.indexOf(strip.big);
  const step = Math.max(1, strip.visible - 1);
  const last = strip.ids.length - strip.visible;
  return (
    <>
      {strip.current && big && (
        <div className="super-strip-current" data-testid="super-strip-current" data-card-id={big.id} aria-current="true"
          aria-label={t('super.layout.current').replace('{title}', title).replace('{n}', String(at + 1)).replace('{total}', String(strip.ids.length))}
          style={{ left: strip.current.x, top: strip.current.y, width: strip.current.width, height: strip.current.height }}>
          <div className="super-card-clip"><div className="super-card-body" data-inert="true"><KindTile container={big} title={title} viewReady={viewReady} /></div></div>
        </div>
      )}
      {strip.prev && (
        <button type="button" className="super-strip-nav" data-testid="super-strip-prev" aria-label={t('super.layout.stripPrev')} disabled={strip.start <= 0}
          style={{ left: strip.prev.x, top: strip.prev.y, width: strip.prev.width, height: strip.prev.height }}
          onClick={() => onScroll(Math.max(0, strip.start - step))}>‹</button>
      )}
      {strip.next && (
        <button type="button" className="super-strip-nav" data-testid="super-strip-next" aria-label={t('super.layout.stripNext')} disabled={strip.start >= last}
          style={{ left: strip.next.x, top: strip.next.y, width: strip.next.width, height: strip.next.height }}
          onClick={() => onScroll(Math.min(last, strip.start + step))}>›</button>
      )}
    </>
  );
}

/** The strip's first slot that keeps `index` in view (a selection moved by the keys or the Super). */
export function stripStartFor(start: number, visible: number, index: number): number {
  if (index < 0) return start;
  if (index < start) return index;
  if (index >= start + visible) return index - visible + 1;
  return start;
}
