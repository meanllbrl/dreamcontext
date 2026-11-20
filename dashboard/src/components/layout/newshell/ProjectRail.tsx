import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { PagePlace } from '../../../lib/placeHistory';
import type { Page } from '../Sidebar';
import { slugHue } from '../../apps/AppIcon';
import { VaultLogo } from '../VaultLogo';
import type { RailMarks } from './railMarks';

/** One badge: a project of the rail, in `projectOrder` minus the hidden ones (badge N is ⌘N). */
export interface RailProject {
  name: string;
  logo: boolean;
  logoStamp: number | null;
  active: boolean;
  asleep: boolean;
  otherWindow: boolean;
  marks: RailMarks;
}

/** Hover delay before a card opens, and the grace that crosses the gap from badge to card. */
export const CARD_OPEN_MS = 300;
export const CARD_GRACE_MS = 200;
/** A press that moves this far is a drag (WKWebView has no HTML5 drag), else it is a click. */
export const DRAG_THRESHOLD_PX = 4;
/** A finger held this long on a badge opens its card (the phone strip). */
export const LONG_PRESS_MS = 450;

/** Where a badge dragged to `y` (or `x` on the strip) lands: before the badge whose middle it is
 *  above, or null = the end. `self` never counts (dropping on itself is no move). Pure. */
export function railDropBefore(rects: ReadonlyArray<{ name: string; start: number; size: number }>, at: number, self: string): string | null {
  for (const r of rects) {
    if (r.name === self) continue;
    if (at < r.start + r.size / 2) return r.name;
  }
  return null;
}

/** The rail's order after `name` moves before `before` (null = the end). Pure. */
export function railOrderAfterDrop(order: readonly string[], name: string, before: string | null): string[] {
  const rest = order.filter((n) => n !== name);
  const at = before === null ? rest.length : rest.indexOf(before);
  if (at < 0) return [...order];
  return [...rest.slice(0, at), name, ...rest.slice(at)];
}

/**
 * Where a badge click lands (D3): on a page, the same page in that project at the last item opened
 * on that page there (null: the page's own open item or its list); on Chat, Settings or a page the
 * device cannot show, the owner's switch (which carries Chat). The active project: nothing. Pure.
 */
export function railTarget(
  vault: string,
  active: string | null,
  shown: { page: Page; chat: boolean } | null,
  lastItemOn: (vault: string, page: Page) => { id: string; label: string | null } | null,
  cannotShow: (page: Page) => boolean,
): { kind: 'none' } | { kind: 'switch' } | { kind: 'place'; place: PagePlace } {
  if (!vault || vault === active) return { kind: 'none' };
  if (!shown || shown.chat || shown.page === 'settings' || cannotShow(shown.page)) return { kind: 'switch' };
  const last = lastItemOn(vault, shown.page);
  return { kind: 'place', place: { vault, kind: 'page', page: shown.page, id: last?.id ?? null, label: last?.label ?? null } };
}

/** The full `projectOrder` after the rail (which omits hidden projects) was reordered: hidden
 *  projects keep their slots, the rail's names fill the others in their new order. Pure. */
export function orderWithRail(order: readonly string[], hidden: readonly string[], rail: readonly string[]): string[] {
  const queue = rail.filter((n) => order.includes(n) && !hidden.includes(n));
  const out = order.map((n) => (hidden.includes(n) || !rail.includes(n) ? n : queue.shift() ?? n));
  return out;
}

/** The badge's face: the project's logo, else its initial on its own colour. */
export function RailFace({ p, size }: { p: Pick<RailProject, 'name' | 'logo' | 'logoStamp'>; size: number }) {
  const style = { '--rail-hue': String(slugHue(p.name)) } as CSSProperties;
  // The initial is always drawn; a logo lies over it, and one that fails to load is no logo.
  return (
    <span className="ns-prail-face" style={style} aria-hidden="true">
      <span className="ns-prail-initial">{Array.from(p.name)[0]?.toLocaleUpperCase() ?? '?'}</span>
      {p.logo && <VaultLogo key={p.logoStamp} name={p.name} hasLogo={p.logo} stamp={p.logoStamp} size={size} className="ns-prail-logo" />}
    </span>
  );
}

/**
 * The project rail (navigation B, D2): one badge per project at the far left of every page of the
 * new shell, `+` under them. A click opens the same page in that project (the window decides
 * where, D3); hovering one opens its card after {@link CARD_OPEN_MS}; dragging one reorders the
 * same `projectOrder` the drawer's drag writes. `layout="strip"` is the phone's row at the top of
 * the page: a tap is the click, a long press opens the card.
 */
export function ProjectRail({ projects, layout = 'column', onPick, onCount, onReorder, onNewProject, onCard, cardFor }: {
  projects: readonly RailProject[];
  layout?: 'column' | 'strip';
  onPick(name: string): void;
  /** The red count: the first thing waiting on the owner there. */
  onCount(name: string): void;
  /** The rail's names in their new order. */
  onReorder(names: string[]): void;
  onNewProject?: () => void;
  /** The card wants to open (name + the badge's box) or close (null). */
  onCard(open: { name: string; anchor: DOMRect } | null): void;
  /** The project whose card is open. */
  cardFor: string | null;
}) {
  const { t } = useI18n();
  const strip = layout === 'strip';
  const listRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  /* ── Drag: pointer events, a 4 px threshold, the drop shown as a gap ── */
  const press = useRef<{ name: string; x: number; y: number; id: number; dragging: boolean; long: boolean } | null>(null);
  const longTimer = useRef<number | null>(null);
  const [drag, setDrag] = useState<{ name: string; before: string | null } | null>(null);
  const suppressClick = useRef(false);

  const rects = () => {
    const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-rail-name]') ?? [])];
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.dataset.railName ?? '', start: strip ? r.left : r.top, size: strip ? r.width : r.height };
    });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, name: string) => {
    if (e.button !== 0) return;
    press.current = { name, x: e.clientX, y: e.clientY, id: e.pointerId, dragging: false, long: false };
    if (strip) {
      const anchor = e.currentTarget.getBoundingClientRect();
      longTimer.current = window.setTimeout(() => {
        if (!press.current || press.current.dragging) return;
        press.current.long = true;
        suppressClick.current = true;
        onCard({ name, anchor });
      }, LONG_PRESS_MS);
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId || p.long) return;
    if (!p.dragging) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
      p.dragging = true;
      if (longTimer.current !== null) { window.clearTimeout(longTimer.current); longTimer.current = null; }
      clearTimers();
      onCard(null);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
    }
    setDrag({ name: p.name, before: railDropBefore(rects(), strip ? e.clientX : e.clientY, p.name) });
  };
  const endPress = (e: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    if (longTimer.current !== null) { window.clearTimeout(longTimer.current); longTimer.current = null; }
    const p = press.current;
    press.current = null;
    if (!p || p.id !== e.pointerId) return;
    if (p.dragging) {
      suppressClick.current = true;
      const before = drag?.name === p.name ? drag.before : null;
      setDrag(null);
      if (cancelled) return;
      const names = projects.map((x) => x.name);
      const next = railOrderAfterDrop(names, p.name, before);
      if (next.join('\n') !== names.join('\n')) onReorder(next);
    }
  };

  const click = (name: string) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    clearTimers();
    onCard(null);
    onPick(name);
  };

  const hoverIn = (name: string, el: HTMLElement) => {
    if (strip || drag) return;
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    // A card already open moves to the next badge at once; the first one waits.
    const wait = cardFor ? 0 : CARD_OPEN_MS;
    openTimer.current = window.setTimeout(() => { openTimer.current = null; onCard({ name, anchor: el.getBoundingClientRect() }); }, wait);
  };
  const hoverOut = () => {
    if (strip) return;
    if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => { closeTimer.current = null; onCard(null); }, CARD_GRACE_MS);
  };
  /** The card's own pointer: the grace stops while the pointer is on it. */
  useEffect(() => {
    const keep = () => { if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; } };
    const leave = () => hoverOut();
    window.addEventListener('ns-prail-card-enter', keep);
    window.addEventListener('ns-prail-card-leave', leave);
    return () => { window.removeEventListener('ns-prail-card-enter', keep); window.removeEventListener('ns-prail-card-leave', leave); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Escape' && cardFor) { e.preventDefault(); clearTimers(); onCard(null); }
    else if ((e.key === 'ArrowDown' && !strip) || (e.key === 'ArrowRight' && strip)) {
      e.preventDefault();
      (e.currentTarget.parentElement?.nextElementSibling?.querySelector('button') as HTMLButtonElement | null)?.focus();
    } else if ((e.key === 'ArrowUp' && !strip) || (e.key === 'ArrowLeft' && strip)) {
      e.preventDefault();
      (e.currentTarget.parentElement?.previousElementSibling?.querySelector('button') as HTMLButtonElement | null)?.focus();
    }
  };

  return (
    <nav className="ns-prail" data-layout={layout} aria-label={t('shell.nav.rail')} data-testid={strip ? 'ns-prail-strip' : 'ns-prail'} data-no-drag>
      <div className="ns-prail-list" ref={listRef}>
        {projects.map((p, i) => {
          const n = i + 1;
          const tip = `${p.name}${!strip && n <= 9 ? ` · ⌘${n}` : ''}${p.asleep ? ` · ${t('shell.nav.asleep')}` : ''}${p.otherWindow ? ` · ${t('shell.nav.otherWindow')}` : ''}`;
          const waiting = p.marks.count > 0 ? t('shell.nav.waiting').replace('{n}', String(p.marks.count)) : '';
          return (
            <div key={p.name} className="ns-prail-cell" data-rail-name={p.name}
              data-drop-before={drag && drag.before === p.name && drag.name !== p.name ? 'true' : undefined}
              data-dragging={drag?.name === p.name ? 'true' : undefined}>
              <button type="button" className="ns-prail-badge" data-testid="ns-prail-badge" data-project={p.name}
                data-active={p.active ? 'true' : undefined} data-working={p.marks.working ? 'true' : undefined}
                data-asleep={p.asleep ? 'true' : undefined}
                aria-current={p.active ? 'page' : undefined}
                aria-label={[t('shell.nav.openProject').replace('{name}', p.name), waiting, p.marks.working ? t('shell.nav.superWorking') : ''].filter(Boolean).join(', ')}
                title={tip}
                onClick={() => click(p.name)}
                onKeyDown={onKeyDown}
                onPointerDown={(e) => onPointerDown(e, p.name)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => endPress(e, false)}
                onPointerCancel={(e) => endPress(e, true)}
                onContextMenu={strip ? (e) => e.preventDefault() : undefined}
                onMouseEnter={(e) => hoverIn(p.name, e.currentTarget)}
                onMouseLeave={hoverOut}>
                <RailFace p={p} size={strip ? 36 : 40} />
                {p.marks.fresh && !p.active && <span className="ns-prail-fresh" aria-hidden="true" />}
              </button>
              {p.marks.count > 0 && (
                <button type="button" className="ns-prail-count" data-testid="ns-prail-count" tabIndex={-1}
                  aria-label={waiting} title={waiting}
                  onClick={(e) => { e.stopPropagation(); clearTimers(); onCard(null); onCount(p.name); }}>
                  {p.marks.count > 99 ? '99+' : p.marks.count}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {onNewProject && (
        <button type="button" className="ns-prail-add" data-testid="ns-prail-add" aria-label={t('shell.nav.newProject')} title={t('shell.nav.newProject')}
          onClick={() => { clearTimers(); onCard(null); onNewProject(); }}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      )}
    </nav>
  );
}
