import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { AgentAvatar } from './AgentAvatar';
import { useI18n } from '../../context/I18nContext';
import { useDismissOnOutside } from '../../lib/useDismissOnOutside';
import './AgentsFeedFilters.css';

/**
 * THE CHANNEL'S FILTER ROW — and it never hides an agent.
 *
 * All / Unread / Needs you / Failed, a hairline, then one chip per agent. The row used to
 * scroll sideways under a fade, so with nine agents "Haftal…" was cut at the edge and the ones
 * past it (and their counts) were simply not on screen. Now the agents that do not fit fold into
 * a "+N agents" chip whose menu lists each of them with its count: every agent is either a
 * whole chip or a counted row, and no chip is ever painted clipped.
 *
 * THE MENU IS THE PAGE'S, the rows are Chat's. Chat's `Popover` always opens upward (it is
 * built for a composer at the bottom of a pane), and from a row near the top of the page that
 * put the menu above the window. So the panel is placed here, BELOW its trigger, with the
 * app's shared outside-click / Esc arbitration (`useDismissOnOutside`) and Chat's menu-list
 * rows (`.chat-cmp-menu-list`) inside it.
 */

export type FeedFilter = { kind: 'all' } | { kind: 'unread' } | { kind: 'needs' } | { kind: 'failed' } | { kind: 'agent'; slug: string };

export function sameFilter(a: FeedFilter, b: FeedFilter): boolean {
  return a.kind === b.kind && (a.kind !== 'agent' || b.kind !== 'agent' || a.slug === b.slug);
}

/** One chip: a status filter (no `slug`) or an agent (with one). */
export interface FeedChip {
  id: string;
  label: string;
  count: number;
  filter: FeedFilter;
  slug?: string;
  title?: string;
  hasPhoto?: boolean;
}

/** The "+N agents" chip's key in the width cache. */
const MORE_ID = '__more';
/** Keeps the menu off the window's edge, in px. */
const EDGE_PAD = 8;

/**
 * Which agent chips are shown for a row that holds `k` of them: the first `k`, except that an
 * ACTIVE agent that would fold takes the last visible slot. The tablist then always carries the
 * selected tab, and the "+N" chip never has to stand in for it.
 */
function pickVisible(agents: FeedChip[], k: number, activeId: string | null): FeedChip[] {
  const head = agents.slice(0, k);
  if (!activeId || head.some((c) => c.id === activeId)) return head;
  const active = agents.find((c) => c.id === activeId);
  if (!active) return head;
  return k === 0 ? [active] : [...head.slice(0, k - 1), active];
}

export function AgentsFeedFilters({
  chips,
  filter,
  onSelect,
}: {
  chips: FeedChip[];
  filter: FeedFilter;
  onSelect: (f: FeedFilter) => void;
}) {
  const { t } = useI18n();
  const statuses = useMemo(() => chips.filter((c) => !c.slug), [chips]);
  const agents = useMemo(() => chips.filter((c) => c.slug), [chips]);
  const activeId = agents.find((c) => sameFilter(filter, c.filter))?.id ?? null;

  // ── Fitting ──────────────────────────────────────────────────────────────
  //
  // Natural widths, cached by chip id, measured with EVERY chip on the row: a pass that renders
  // them all runs whenever the set of chips or any count changes (a count's digits change a
  // chip's width), before paint, and the row is then cut to what fits. A resize re-fits from the
  // cache without re-rendering them all. Chips are `flex: none`, so a measured width is never a
  // squeezed one.
  const rowRef = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const signature = chips.map((c) => `${c.id}:${c.count}`).join('|');
  const [measuredSig, setMeasuredSig] = useState<string | null>(null);
  const measuring = measuredSig !== signature;
  const [fit, setFit] = useState(agents.length);

  const refit = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const cs = getComputedStyle(row);
    const avail = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    const w = (id: string) => widths.current.get(id) ?? 0;
    const total = (visible: FeedChip[], folded: boolean) => {
      const items = [
        ...statuses.map((c) => w(c.id)),
        ...(agents.length > 0 ? [1] : []), // the hairline
        ...visible.map((c) => w(c.id)),
        ...(folded ? [w(MORE_ID)] : []),
      ];
      return items.reduce((a, b) => a + b, 0) + gap * Math.max(0, items.length - 1);
    };
    let k = agents.length;
    while (k > 0 && total(pickVisible(agents, k, activeId), k < agents.length) > avail) k--;
    setFit(k);
  }, [statuses, agents, activeId]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    if (measuring) {
      for (const el of row.querySelectorAll<HTMLElement>('[data-chip-id]')) {
        widths.current.set(el.dataset.chipId as string, el.offsetWidth);
      }
      setMeasuredSig(signature);
    }
    refit();
  }, [measuring, signature, refit]);

  // The row only: its width is the one thing a resize changes. Read through a ref so the
  // observer is subscribed once, not once per poll.
  const refitRef = useRef(refit);
  refitRef.current = refit;
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const ro = new ResizeObserver(() => refitRef.current());
    ro.observe(row);
    return () => ro.disconnect();
  }, []);

  // The menu and its trigger always follow the LAST fit, never the measuring pass: a poll that
  // changes a count re-measures the tablist, and an open menu (with focus in it) must not be
  // unmounted under the reader for that one frame.
  const fitted = pickVisible(agents, fit, activeId);
  const hidden = agents.filter((c) => !fitted.includes(c));
  const visible = measuring ? agents : fitted;
  const moreLabel = (n: number) => (n === 1 ? t('agents.filter.more.one') : t('agents.filter.more.many').replace('{n}', String(n)));

  // ── The "+N agents" menu ─────────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Closing from inside the menu hands focus back to the chip that opened it. */
  const close = useCallback(() => {
    const inside = !!menuRef.current?.contains(document.activeElement);
    setOpen(false);
    if (inside) triggerRef.current?.focus();
  }, []);
  useDismissOnOutside(open, close, [triggerRef, menuRef]);
  // A menu with nothing left in it (the window grew) goes with its chip.
  useEffect(() => { if (open && hidden.length === 0) setOpen(false); }, [open, hidden.length]);

  // Below the trigger, right-aligned to it, clamped inside the window; followed on resize and
  // on any scroll while open. Hidden until placed, so it never flashes at 0,0.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = triggerRef.current?.getBoundingClientRect();
      const m = menuRef.current;
      if (!a || !m) return;
      const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-1')) || 0;
      const top = a.bottom + gap;
      const left = Math.max(EDGE_PAD, Math.min(a.right - m.offsetWidth, window.innerWidth - m.offsetWidth - EDGE_PAD));
      m.style.top = `${Math.round(top)}px`;
      m.style.left = `${Math.round(left)}px`;
      m.style.maxHeight = `${Math.max(0, Math.round(window.innerHeight - top - EDGE_PAD))}px`;
      m.style.visibility = 'visible';
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, hidden.length]);

  // Focus the checked row on open, else the first.
  useEffect(() => {
    if (!open) return;
    const rows = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    if (!rows?.length) return;
    ([...rows].find((r) => r.getAttribute('aria-checked') === 'true') ?? rows[0]).focus();
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => { e.preventDefault(); rows[(i + rows.length) % rows.length]?.focus(); };
    switch (e.key) {
      case 'ArrowDown': go(at + 1); break;
      case 'ArrowUp': go(at - 1); break;
      case 'Home': go(0); break;
      case 'End': go(rows.length - 1); break;
      // Tab leaves the menu where the browser would take it; the menu does not follow.
      case 'Tab': setOpen(false); break;
    }
  };

  const pick = (c: FeedChip) => {
    onSelect(c.filter);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const chip = (c: FeedChip) => {
    const on = sameFilter(filter, c.filter);
    return (
      <button
        key={c.id}
        type="button"
        role="tab"
        aria-selected={on}
        data-chip-id={c.id}
        data-chip-slug={c.slug}
        className={`agents-chip${on ? ' agents-chip--on' : ''}${c.count === 0 ? ' agents-chip--zero' : ''}`}
        onClick={() => onSelect(c.filter)}
        // The label is capped and ellipsised (a long agent name), so the whole name rides on it.
        title={c.label}
      >
        {c.slug && <AgentAvatar slug={c.slug} title={c.title ?? c.slug} hasPhoto={c.hasPhoto ?? false} size={20} />}
        <span className="agents-chip-label">{c.label}</span>
        <span className="agents-chip-count">{c.count}</span>
      </button>
    );
  };

  return (
    <div className="agents-chips" ref={rowRef}>
      <div className="agents-chips-tabs" role="tablist" aria-label="Filter the channel">
        {statuses.map(chip)}
        {agents.length > 0 && <span className="agents-chips-rule" aria-hidden="true" />}
        {visible.map(chip)}
      </div>

      {/* The "+N" chip's width is measured on a stand-in, at the widest count it could carry, out
          of the flow and never focusable; the real trigger below is never re-mounted or blurred
          by a measuring pass. */}
      {measuring && (
        <span
          data-chip-id={MORE_ID}
          className="agents-chip"
          style={{ position: 'absolute', visibility: 'hidden' }}
          aria-hidden="true"
        >
          {moreLabel(agents.length)}
        </span>
      )}
      {hidden.length > 0 && (
        <button
          ref={triggerRef}
          type="button"
          className="agents-chip agents-chip--more"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${t('agents.filter.moreAria')}: ${moreLabel(hidden.length)}`}
          onClick={() => setOpen((v) => !v)}
        >
          {moreLabel(hidden.length)}
        </button>
      )}

      {open && hidden.length > 0 && createPortal(
        <div
          ref={menuRef}
          className="chat-cmp-menu-list agents-chips-menu"
          role="menu"
          aria-label={t('agents.filter.moreAria')}
          style={{ visibility: 'hidden' }}
          onKeyDown={onMenuKey}
        >
          {hidden.map((c) => {
            const on = sameFilter(filter, c.filter);
            return (
              <button
                key={c.id}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                tabIndex={-1}
                title={c.label}
                onClick={() => pick(c)}
              >
                <AgentAvatar slug={c.slug as string} title={c.title ?? c.label} hasPhoto={c.hasPhoto ?? false} size={20} />
                <span className="agents-chips-menu-label">{c.label}</span>
                <span className="agents-chip-count">{c.count}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
