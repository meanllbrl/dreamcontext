import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CONTEXT_TIGHT_PCT, fmtCost, fmtTokens } from '../../../lib/agentComposer';

/**
 * The session's context/cost gauge — and the hover card that carries its detail.
 *
 * The gauge is the composer toolbar's only ELASTIC child: everything else in that row is a
 * control, this is a status. So it is the piece that gives way as the pane narrows, in
 * stages driven by the `chatcmp` size container (see composer.css):
 *
 *   wide      ▭▭▭░░  33%  66k/200k   $0.58
 *   ≤660px    ▭▭▭░░  33%             $0.58     (raw counts drop — the % says the same thing)
 *   ≤560px    ▭▭▭░░  33%                       (the cost chip moves into the card)
 *   ≤470px    ▭░                               (a bare 22px gauge — "how full am I", nothing else)
 *
 * The rule the stages exist to enforce: the toolbar is ONE ROW at every width. It used to
 * `flex-wrap`, which on a ~430px pane split it into an asymmetric two-line block (controls
 * on top, gauge + model + Send below) — the readout is not important enough to buy a second
 * line with, and an off-balance split reads as broken rather than as responsive.
 *
 * Whatever the stage drops is still one hover away: the card below always shows the full
 * reading. It is PORTALED to <body> because `.chat-cmp` is a size-query container, which
 * makes it the containing block even for `position: fixed` descendants — the same reason
 * `Popover`'s menu portals (see SkillPickerPopover.tsx).
 *
 * The `/compact` button is deliberately NOT folded into the card: at ≥90% the action is the
 * point, and burying a control behind hover would put it out of reach of the keyboard (the
 * portaled card is at the end of <body>, so Tab from the gauge never enters it). It stays in
 * the toolbar and goes icon-only instead.
 */

export type ContextUsage = { used: number; limit: number; pct: number };

export function ContextReadout({
  ctx, costUsd, onCompact, compactEnabled,
}: {
  ctx: ContextUsage | null;
  costUsd: number | null;
  onCompact: () => void;
  compactEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const show = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  }, []);
  // Closing is DELAYED: the card sits 8px above the gauge, and a pointer travelling into it
  // to read (or select) the numbers crosses that gap — an immediate close would flicker it
  // away mid-reach.
  const hide = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 140);
  }, []);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Placed above the anchor and clamped to the viewport — the same shape as `Popover`'s
  // placement, including the rAF anchor watcher: the toolbar moves without any resize or
  // scroll event (an attachment chip appearing grows the composer body, ⌘D splits the pane).
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const card = cardRef.current;
      if (!a || !card) return;
      const PAD = 8;
      const w = card.offsetWidth;
      const left = Math.max(PAD, Math.min(a.left, window.innerWidth - w - PAD));
      card.style.left = `${Math.round(left)}px`;
      card.style.bottom = `${Math.round(window.innerHeight - a.top + 8)}px`;
      card.style.visibility = 'visible';
    };
    place();
    let last: DOMRect | undefined;
    let raf = requestAnimationFrame(function watch() {
      const a = anchorRef.current?.getBoundingClientRect();
      if (a && last && (a.left !== last.left || a.top !== last.top)) place();
      last = a ?? last;
      raf = requestAnimationFrame(watch);
    });
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  if (!ctx && costUsd == null) return null;

  const isTight = !!ctx && ctx.pct >= CONTEXT_TIGHT_PCT;
  const free = ctx ? Math.max(0, ctx.limit - ctx.used) : 0;
  const valueText = ctx
    ? `${ctx.pct} percent — ${fmtTokens(ctx.used)} of ${fmtTokens(ctx.limit)} used, ${fmtTokens(free)} free`
    : '';

  return (
    <div
      className="chat-cmp-readout"
      ref={anchorRef}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {ctx && (
        // Focusable so the detail is reachable without a pointer, and a real `meter` so a
        // screen reader gets the reading rather than three loose spans.
        <span
          className="chat-cmp-ctx"
          data-tight={isTight}
          role="meter"
          tabIndex={0}
          aria-label="Context window"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={ctx.pct}
          aria-valuetext={valueText}
        >
          <span className="chat-cmp-ctx-track" aria-hidden>
            <span className="chat-cmp-ctx-fill" style={{ width: `${ctx.pct}%` }} />
          </span>
          <span className="chat-cmp-ctx-pct">{ctx.pct}%</span>
          <span className="chat-cmp-ctx-count">{fmtTokens(ctx.used)}/{fmtTokens(ctx.limit)}</span>
        </span>
      )}

      {costUsd != null && (
        <span className="chat-cmp-ctx-cost">{fmtCost(costUsd)}</span>
      )}

      {isTight && (
        <button
          type="button"
          className="chat-cmp-compact-btn"
          onClick={onCompact}
          disabled={!compactEnabled}
          title="Ask Claude to compact the conversation"
        >
          <span aria-hidden>⚠</span>
          <span className="chat-cmp-compact-label">/compact</span>
        </button>
      )}

      {open && createPortal(
        // Hidden until the layout effect measures + places it — no first-frame flash at 0,0.
        <div
          className="chat-cmp-ctxcard"
          ref={cardRef}
          role="tooltip"
          style={{ visibility: 'hidden' }}
          onPointerEnter={show}
          onPointerLeave={hide}
        >
          {ctx && (
            <>
              <div className="chat-cmp-ctxcard-head">
                <span className="chat-cmp-ctxcard-title">Context window</span>
                <span className="chat-cmp-ctxcard-pct" data-tight={isTight}>{ctx.pct}%</span>
              </div>
              <span className="chat-cmp-ctxcard-track" aria-hidden>
                <span className="chat-cmp-ctxcard-fill" data-tight={isTight} style={{ width: `${ctx.pct}%` }} />
              </span>
              <div className="chat-cmp-ctxcard-row">
                <span>{fmtTokens(ctx.used)} / {fmtTokens(ctx.limit)} used</span>
                <span className="chat-cmp-ctxcard-free">{fmtTokens(free)} free</span>
              </div>
            </>
          )}

          {costUsd != null && (
            <div className="chat-cmp-ctxcard-cost">
              <div className="chat-cmp-ctxcard-row">
                <span>Estimated cost</span>
                <span className="chat-cmp-ctxcard-costval">{fmtCost(costUsd)}</span>
              </div>
              <p className="chat-cmp-ctxcard-note">
                At public API rates. A Max/Pro plan is flat-rate, so this is a what-if.
              </p>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
