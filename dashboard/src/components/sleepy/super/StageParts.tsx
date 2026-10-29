import type { KeyboardEvent } from 'react';
import { STAGE, type Rect, type StagePlan, type StripPlan } from './superLayout';
import { KindTile } from './SuperTiles';
import type { PresentLayout, SuperContainer, SuperStateView } from '../../../lib/superTypes';
import { useI18n } from '../../../context/I18nContext';
import type { ChatSession } from '../chatSession';
import { ChatTile, type AsksOwner } from './AgentCard';
import { chatStatus, type RemoteRow } from './SuperContainer';
import { useLiveSession } from './liveSession';
import { toneOfStatus } from './superHandover';

/** A chat in an open panel: the same tile as on the stage, live, glowing as it does there. */
export function PanelChatTile({ session, child, title, asksOwner, remoteChild }: { session: ChatSession | undefined; child: SuperStateView['children'][string] | undefined; title: string; asksOwner: AsksOwner; remoteChild?: RemoteRow | null }) {
  // The panel's frame follows the status; the tile inside follows its own lines.
  useLiveSession(session, () => chatStatus(session).kind);
  const status = chatStatus(session, remoteChild);
  return (
    <div className="super-panel-tile" data-status={status.kind === 'asking' ? 'asking' : status.kind === 'working' ? 'working' : 'idle'} data-super-tone={toneOfStatus(status.kind)}>
      <div className="super-panel-clip"><ChatTile session={session} child={child} title={title} asksOwner={asksOwner} status={status} /></div>
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
export const PRESENT_KEY_OWNERS = '.image-viewer, .pdf-viewer:not(.pdf-viewer--embedded), .fullscreen-overlay, .quest-receipt-scrim, .agent-composer-menu, .cmd-modal, .agent-tab-menu, .agent-new-menu';

/**
 * A presentation's controls at the top band's right end (plan-r2 D11, D12): the layouts these
 * cards can take (only when there is a choice), then the way back to the floating stage.
 */
export function StageControls({ rect, layouts, current, onPick, onExit, toGroup = false }: {
  rect: Rect; layouts: readonly PresentLayout[]; current: PresentLayout; onPick: (l: PresentLayout) => void; onExit: () => void;
  /** The presentation shows one group whole: leaving it goes back to that group's panel. */
  toGroup?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="super-stage-controls" data-testid="super-stage-controls" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      {layouts.length > 1 && (
        <div className="super-layout-switch" role="group" aria-label={t('super.layout.switch')} data-testid="super-layout-switch">
          {layouts.map((l) => (
            <button key={l} type="button" className="super-layout-seg" aria-pressed={l === current} data-layout={l}
              data-testid={`super-layout-${l}`} onClick={() => { if (l !== current) onPick(l); }}>
              {t(`super.layout.${l}`)}
            </button>
          ))}
        </div>
      )}
      <button type="button" className="super-stage-exit" data-testid="super-stage-exit" data-to-group={toGroup ? 'true' : undefined} onClick={onExit} title="Esc">{t(toGroup ? 'super.stage.backToGroup' : 'super.stage.exit')}</button>
    </div>
  );
}

/** A narrow sheet's tab row: one tab per presented card, the shown one pressed; arrows move. */
export function SheetTabs({ rect, ids, selected, titleOf, onSelect }: {
  rect: Rect; ids: readonly string[]; selected: string; titleOf: (id: string) => string; onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = ids.indexOf(selected);
    const next = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    onSelect(next);
    // Focus follows the selected tab (the roving tabindex leaves the old one at -1).
    const row = e.currentTarget;
    requestAnimationFrame(() => row.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next)}"]`)?.focus());
  };
  return (
    <div className="super-sheet-tabs" role="tablist" aria-label={t('super.layout.tab')} data-testid="super-sheet-tabs" onKeyDown={onKey}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      {ids.map((id) => (
        <button key={id} type="button" role="tab" className="super-sheet-tab" aria-selected={id === selected} tabIndex={id === selected ? 0 : -1}
          data-testid="super-sheet-tab" data-tab-id={id} onClick={() => onSelect(id)}>
          {titleOf(id)}
        </button>
      ))}
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
