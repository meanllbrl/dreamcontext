import { useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutside } from '../../../lib/useDismissOnOutside';

/**
 * A menu or small form anchored under a trigger: portaled to `body` (a card
 * clips its content, a menu must not be clipped with it), right-aligned to
 * the trigger and clamped inside the window, hidden until placed so it never
 * paints at 0,0 first. Esc and an outside pointerdown close it through the
 * app's overlay stack (`useDismissOnOutside`), so it queues with ⌘K and the
 * slide-overs. Arrow keys walk its `[role="menuitem"]` rows.
 *
 * Browser dialogs (`prompt`, `confirm`) are silent no-ops in the desktop
 * app's WebView, so New / Rename / Delete ask inside one of these instead.
 */

/** Keeps the popover off the window's edge, in px. */
const EDGE_PAD = 8;

export interface BoardPopoverProps {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  /** `menu` = rows of `role="menuitem"`; `dialog` = a small form. */
  role?: 'menu' | 'dialog';
  className?: string;
  children: ReactNode;
}

export function BoardPopover({ anchor, onClose, label, role = 'menu', className = '', children }: BoardPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutside(true, onClose, [anchor, ref]);

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const m = ref.current;
      if (!a || !m) return;
      const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-1')) || 0;
      const below = a.bottom + gap;
      // Flip above the trigger when there is more room there.
      const flip = below + m.offsetHeight > window.innerHeight - EDGE_PAD && a.top - gap > window.innerHeight - below;
      const top = flip ? Math.max(EDGE_PAD, a.top - gap - m.offsetHeight) : below;
      const left = Math.max(EDGE_PAD, Math.min(a.right - m.offsetWidth, window.innerWidth - m.offsetWidth - EDGE_PAD));
      m.style.top = `${Math.round(top)}px`;
      m.style.left = `${Math.round(left)}px`;
      m.style.maxHeight = `${Math.max(0, Math.round((flip ? a.top - gap : window.innerHeight - below) - EDGE_PAD))}px`;
      m.style.visibility = 'visible';
    };
    place();
    const first = ref.current?.querySelector<HTMLElement>(role === 'menu' ? '[role="menuitem"]:not(:disabled)' : 'input, textarea, button');
    first?.focus();
    // Content that grows after mount (a range picker opening) re-places too.
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, role]);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (role !== 'menu') return;
    const rows = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => { e.preventDefault(); rows[(i + rows.length) % rows.length]?.focus(); };
    switch (e.key) {
      case 'ArrowDown': go(at + 1); break;
      case 'ArrowUp': go(at - 1); break;
      case 'Home': go(0); break;
      case 'End': go(rows.length - 1); break;
      case 'Tab': onClose(); break;
    }
  };

  return createPortal(
    <div
      ref={ref}
      className={`board-popover ${className}`.trim()}
      role={role}
      aria-label={label}
      style={{ visibility: 'hidden' }}
      onKeyDown={onKey}
      // A menu over a card must never start that card's drag or open its detail.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

/** One menu row. `submenu` rows show a trailing ▸ and open a second level in place. */
export function MenuItem({
  onSelect, disabled = false, submenu = false, danger = false, children, hook,
}: {
  onSelect: () => void;
  disabled?: boolean;
  submenu?: boolean;
  danger?: boolean;
  children: ReactNode;
  /** An extra `data-lab-menu-item` value for the verify script. */
  hook?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`board-menu-item${danger ? ' board-menu-item--danger' : ''}`}
      disabled={disabled}
      aria-haspopup={submenu ? 'menu' : undefined}
      data-lab-menu-item={hook}
      onClick={onSelect}
    >
      <span className="board-menu-item-label">{children}</span>
      {submenu && <span className="board-menu-item-more" aria-hidden="true">▸</span>}
    </button>
  );
}
