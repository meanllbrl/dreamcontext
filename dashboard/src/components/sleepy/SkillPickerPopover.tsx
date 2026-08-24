import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutside } from '../../lib/useDismissOnOutside';
import {
  SKILL_GROUPS,
  type SkillTrigger,
} from '../../lib/agentComposer';

/**
 * `Popover` (a trigger + a viewport-clamped, `<body>`-portaled menu) and `SkillBrowser`
 * (the two-pane "what it is / how it works" skill picker), extracted verbatim from
 * `AgentComposerBar.tsx` so the Agent Chat (beta) redesign's composer can mount the
 * SAME skill picker the terminal composer uses (task_nQb0y85X's redesign brief, rule
 * 3: "Skill picker = the terminal composer's existing one, reused") instead of
 * reimplementing it. Styled by `AgentTerminal.css`'s `agent-*` classes, which
 * `AgentSurface.tsx` imports globally — so any component rendered under the surface
 * (terminal composer or chat composer alike) inherits them without a separate import.
 */

// ── A tiny popover: a trigger button + a menu that closes on outside-click / Esc ──────
// The menu PORTALS to <body>: each pane clips its children (overflow:hidden) and its
// `container: agentpane` makes it the containing block even for position:fixed, so a menu
// rendered in-pane can never out-grow a narrow or right-edge pane. From <body> it is placed
// above the trigger and clamped to the viewport, so it always fits — in any pane, any split.
export function Popover({
  trigger, align = 'right', children,
}: {
  trigger: (open: boolean, toggle: () => void) => React.ReactNode;
  /** Which trigger edge the menu prefers to grow from (it clamps to the viewport either way). */
  align?: 'left' | 'right';
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Esc/outside-click arbitration lives in `lib/useDismissOnOutside` — extracted from HERE so
  // the redesigned composer's own menus share one implementation rather than a second copy of
  // the overlay-stack rules (⌘K palette, ⌘P switcher, …). Behaviour is unchanged: the
  // portaled menu is a global overlay, so its Esc arbitrates LIFO — it never swallows an Esc
  // meant for a surface stacked on top, and never loses one to a background panel's
  // earlier-registered listener.
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutside(open, close, [anchorRef, menuRef]);

  // Place the menu above the trigger, clamped inside the viewport. Anchoring via `bottom`
  // keeps the trigger edge fixed; menus are fixed-height while open (see
  // .agent-skill-browser) so content changes never move what's under the cursor.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const m = menuRef.current;
      if (!a || !m) return;
      const PAD = 8;
      const w = m.offsetWidth;
      let left = align === 'left' ? a.left : a.right - w;
      left = Math.max(PAD, Math.min(left, window.innerWidth - w - PAD));
      const bottom = window.innerHeight - a.top + 6;
      m.style.left = `${Math.round(left)}px`;
      m.style.bottom = `${Math.round(bottom)}px`;
      m.style.maxHeight = `${Math.max(120, window.innerHeight - bottom - PAD)}px`;
      m.style.visibility = 'visible';
    };
    place();
    // The trigger can move without any window resize/scroll event: ⌘D pane splits, the
    // overlay's `left` transition on sidebar toggle, tab reflows — and xterm viewports
    // fire captured scrolls constantly while streaming, which made a scroll listener
    // both leaky (misses the above) and busy (re-placing on every output chunk). One
    // rAF watcher covers everything: a single getBoundingClientRect read per frame,
    // style writes only when the anchor actually moved.
    let last: DOMRect | undefined;
    let raf = requestAnimationFrame(function watch() {
      const a = anchorRef.current?.getBoundingClientRect();
      if (a && last && (a.left !== last.left || a.top !== last.top || a.width !== last.width)) place();
      last = a ?? last;
      raf = requestAnimationFrame(watch);
    });
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
    };
  }, [open, align]);

  return (
    <div className="agent-composer-pop" ref={anchorRef}>
      {trigger(open, () => setOpen((v) => !v))}
      {open && createPortal(
        // Hidden until the layout effect measures + places it — no first-frame flash at 0,0.
        <div className="agent-composer-menu" role="menu" ref={menuRef} style={{ visibility: 'hidden' }}>
          {children(() => setOpen(false))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── The Skills popover body: a two-pane "skill browser" ──────────────────────────────
// Left: our capability chips, grouped. Right: a live detail card that spells out WHAT the
// hovered/focused skill is and HOW it works (its phase flow + the sub-agents it dispatches).
// Clicking a chip drops its trigger into the terminal and closes the popover.
export function SkillBrowser({ onInsert, close }: { onInsert: (snippet: string) => void; close: () => void }) {
  // Default the detail card to the very first skill so the panel is never empty.
  const [active, setActive] = useState<SkillTrigger>(SKILL_GROUPS[0].triggers[0]);
  // The detail card scrolls internally (its height is FIXED so hover never resizes the
  // popover — see .agent-skill-browser); start each skill's card from the top.
  const detailRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { detailRef.current?.scrollTo(0, 0); }, [active]);

  return (
    <div className="agent-skill-browser">
      <div className="agent-skill-list">
        {SKILL_GROUPS.map((group) => (
          <div className="agent-skill-group" key={group.id}>
            <span className="agent-skill-group-label">{group.label}</span>
            <div className="agent-skill-chips">
              {group.triggers.map((t) => (
                <button
                  key={t.insert}
                  type="button"
                  className={`agent-skill-chip${t.insert === active.insert ? ' on' : ''}`}
                  title={t.hint}
                  onMouseEnter={() => setActive(t)}
                  onFocus={() => setActive(t)}
                  onClick={() => { onInsert(t.insert); close(); }}
                >{t.label}</button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Live detail — the "very clearly convey what it is and how it works" panel. */}
      <div className="agent-skill-detail" aria-live="polite" ref={detailRef}>
        <div className="agent-skill-detail-head">
          <span className="agent-skill-detail-title">{active.label}</span>
          <code className="agent-skill-detail-trigger">{active.insert.trim()}</code>
        </div>
        <p className="agent-skill-detail-what">{active.what}</p>

        <span className="agent-skill-detail-h">How it works</span>
        <ol className="agent-skill-detail-flow">
          {active.how.map((step, i) => (
            <li key={i}><span className="agent-skill-detail-step-n">{i + 1}</span>{step}</li>
          ))}
        </ol>

        {active.agents && active.agents.length > 0 && (
          <>
            <span className="agent-skill-detail-h">Dispatches {active.agents.length} sub-agents</span>
            <div className="agent-skill-detail-agents">
              {active.agents.map((a) => (
                <span className="agent-skill-detail-agent" key={a}>{a}</span>
              ))}
            </div>
          </>
        )}

        <p className="agent-skill-detail-foot">Click to drop <code>{active.insert.trim()}</code> into the terminal — you finish the prompt.</p>
      </div>
    </div>
  );
}
