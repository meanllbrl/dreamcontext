import type { KeyboardEvent } from 'react';
import { STAGE, type Rect, type StagePlan } from './superLayout';
import type { PresentLayout, SuperStateView } from '../../../lib/superTypes';
import { useI18n } from '../../../context/I18nContext';
import type { ChatSession } from '../chatSession';
import { ChatTile, type AsksOwner } from './AgentCard';
import { chatStatus } from './SuperContainer';
import { useLiveSession } from './liveSession';
import { toneOfStatus } from './superHandover';

/** A chat in an open panel: the same tile as on the stage, live, glowing as it does there. */
export function PanelChatTile({ session, child, title, asksOwner }: { session: ChatSession | undefined; child: SuperStateView['children'][string] | undefined; title: string; asksOwner: AsksOwner }) {
  // The panel's frame follows the status; the tile inside follows its own lines.
  useLiveSession(session, () => chatStatus(session).kind);
  const status = chatStatus(session);
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
