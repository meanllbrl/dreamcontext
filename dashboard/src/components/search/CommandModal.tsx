import { useCallback, useEffect, useState } from 'react';
import { pushOverlay, popOverlay, isTopOverlay } from '../../lib/overlayStack';
import './CommandModal.css';

/**
 * Shared shell for the app's centered command surfaces (⌘K palette, ⌘P switcher).
 *
 * Owns ONLY the chrome that both surfaces reproduce identically:
 *   - the dim scrim + centered dialog box, entrance animation, reduced-motion opt-out,
 *   - overlay-stack registration + topmost-aware Escape (capture-phase +
 *     stopImmediatePropagation, so Esc closes the front-most overlay and never leaks
 *     to a background overlay's Esc handler — e.g. the agent overlay's collapse),
 *   - scrim-mousedown-to-close and dialog-mousedown-stop.
 *
 * Per-surface bits (the input row, list rows, footer, and any mode toggles) are
 * rendered by the caller as `children`. Per-surface visual tuning (top offset,
 * max-width/height, entrance transform) is expressed as CSS custom properties set
 * by the caller's `className` — which the shell applies to BOTH the scrim (so the
 * top-offset var resolves there) and the dialog (so a caller class like
 * `.command-palette` keeps matching existing `closest()` guards).
 */
interface CommandModalProps {
  /** Overlay-stack id — must be stable and unique (e.g. 'command-palette'). */
  id: string;
  open: boolean;
  onClose: () => void;
  /** Dialog aria-label. */
  ariaLabel: string;
  /** Per-surface variant class (sets CSS vars + carries any JS-guard hook class). */
  className?: string;
  children: React.ReactNode;
}

export function CommandModal({ id, open, onClose, ariaLabel, className, children }: CommandModalProps) {
  // Esc closes — capture-phase so it pre-empts other window Esc handlers, and
  // topmost-only (via the overlay stack) so an overlay opened on top of this one
  // gets the Esc instead of this (background) one closing out from under it.
  // stopImmediatePropagation makes the "this overlay owns Esc" contract explicit
  // regardless of listener registration order.
  useEffect(() => {
    if (!open) return;
    pushOverlay(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopOverlay(id)) {
        e.preventDefault(); e.stopImmediatePropagation(); onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      popOverlay(id);
    };
  }, [open, onClose, id]);

  if (!open) return null;

  const variant = className ? ` ${className}` : '';
  return (
    <div className={`cmd-modal-scrim${variant}`} onMouseDown={onClose}>
      <div
        className={`cmd-modal${variant}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Shared keyboard-list navigation for the command surfaces: ↑/↓ move the focused
 * index (clamped), Enter fires `onEnter(focused)`. Also re-clamps `focused` when
 * `length` shrinks (e.g. results filtered down) so it never points past the end.
 *
 * Esc is intentionally NOT handled here — it's owned globally by <CommandModal>
 * (topmost-aware) so it works even when focus has left the input.
 */
export function useListKeyboardNav({ length, onEnter }: { length: number; onEnter: (index: number) => void }) {
  const [focused, setFocused] = useState(0);

  useEffect(() => { setFocused((f) => Math.min(f, Math.max(0, length - 1))); }, [length]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocused((f) => Math.min(length - 1, f + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocused((f) => Math.max(0, f - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); onEnter(focused); }
  }, [length, onEnter, focused]);

  return { focused, setFocused, onKeyDown };
}
