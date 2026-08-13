import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import type { SessionStatusKind } from '../sleepy/agentStatus';
import './ProjectTabs.css';

/**
 * The centre-aligned project chip strip — the one place a window says which projects it is
 * holding and which of them needs you.
 *
 * Every chip is a LIVE project: switching chips hides an instance, it never unmounts one, so
 * the strip is a visibility control, not a router. A chip therefore has to carry state that
 * belongs to a surface you are not currently looking at — the dot's colour, the count of
 * conversations actually running, and a one-shot bounce when one of them starts waiting on
 * an answer.
 *
 * Presentational on purpose: it owns its own geometry (the two layout rules below) and
 * nothing else. `WindowChrome` owns which projects exist, which is active, and the ceiling.
 */

/** One project's chip. `worst`/`live`/`waiting` come straight from `rollupProject()`. */
export interface ProjectChip {
  vault: string;
  active: boolean;
  /** Torn down to free a slot at the instance ceiling; the chip stays, the instance is gone. */
  cold: boolean;
  /** Worst-of session state across the project — drives the dot and badge colour. */
  worst: SessionStatusKind;
  /** Live conversations. The badge NUMBER; the badge is omitted entirely at 0. */
  live: number;
  /**
   * Sessions blocked on the user. Its own 0→>0 edge is the ONE bounce trigger, detected in
   * this component and nowhere else — see the bounce effect below.
   */
  waiting: number;
  /**
   * ACCEPTED AND IGNORED — do not reach for this.
   *
   * An earlier shape had the chrome count the `waiting` edges and hand the strip a nonce to
   * replay. That is a second edge detector for an edge `waiting` already carries, and two
   * places deciding when a chip bounces is exactly how one ends up bouncing twice for one
   * question. The strip derives it, so the field has no reader left; it stays declared only
   * because the chrome's chip builder still sets it, and both lines should go together.
   */
  bounceNonce?: number;
}

interface ProjectTabsProps {
  chips: ProjectChip[];
  onActivate(vault: string): void;
  onClose(vault: string): void;
  onAdd(): void;
  onDetach(vault: string): void;
}

/**
 * The strip's geometry, captured the moment the pointer entered it (Rule 1).
 * `order` is the chip order AT FREEZE TIME, which is what lets a closed chip leave an empty
 * slot behind instead of pulling its neighbour under the cursor.
 */
interface FrozenLayout {
  lead: number;
  order: string[];
  widths: Record<string, number>;
}

interface ChipMenu {
  vault: string;
  x: number;
  y: number;
}

/** Keep a context menu fully on screen when a chip is right-clicked near an edge. */
const MENU_WIDTH = 200;
const MENU_MARGIN = 8;

/** Whether the user has asked the OS for less movement. Queried at fire time, not at mount,
 *  so flipping the system setting mid-session takes effect on the very next question. */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false; // no matchMedia (test env) — the stylesheet's own guard still applies
  }
}

/**
 * What the chip's dot and badge SAY, in words. WCAG's "never by colour alone" applies twice
 * over here: the dot's hue is the only visual carrier of `asking`, and the bounce that
 * accompanies it is removed outright under `prefers-reduced-motion`.
 */
function describeChip(chip: ProjectChip): string {
  const parts = [chip.vault];
  if (chip.cold) parts.push('sleeping, click to reopen');
  if (chip.worst === 'asking') parts.push('needs you');
  else {
    if (chip.worst === 'working') parts.push('working');
    // `waiting` with no question on screen: a backgrounded session finished or rang the bell.
    // It is what makes the chip bounce, so it has to be readable as words too.
    if (chip.waiting > 0) parts.push('wants a look');
  }
  if (chip.live > 0) parts.push(`${chip.live} live`);
  return parts.join(' — ');
}

export function ProjectTabs({ chips, onActivate, onClose, onAdd, onDetach }: ProjectTabsProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [frozen, setFrozen] = useState<FrozenLayout | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [bouncing, setBouncing] = useState<Record<string, true>>({});
  const [menu, setMenu] = useState<ChipMenu | null>(null);
  const seenWaitingRef = useRef<Record<string, number>>({});

  // The last chip is the window's only project — closing or detaching it would leave an
  // empty window, so the control is disabled rather than silently refusing on click.
  const canClose = chips.length > 1;

  // ⌃Tab only means something once there is a second chip, and that is also the only moment
  // it is worth naming in a tooltip — see the shortcut's own reasoning in `WindowChrome`.
  const cycleHint = chips.length > 1 ? ' · ⌃Tab to switch' : '';

  /* ── Rule 2: publish whether the track has outgrown the strip ─────────────────────
     The CENTRING itself is pure CSS (`margin-inline: auto` on the track collapses to 0 the
     moment the content is wider than its scroll container, which left-aligns it at exactly
     the right width). This observer only decides whether to draw the edge fades that say
     "there is more strip off-screen" — so the layout can never be a frame out of step with
     the flag that describes it. */
  useLayoutEffect(() => {
    const host = hostRef.current;
    const track = trackRef.current;
    if (!host || !track) return;
    const measure = () => setOverflowing(track.scrollWidth > host.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    ro.observe(track);
    return () => ro.disconnect();
  }, [chips]);

  /* ── Rule 1: freeze the layout while the pointer is inside the strip ───────────────
     Centre-aligned means every add and every close shifts every chip sideways — so closing
     one puts its neighbour directly under the cursor and invites a second, unintended
     close. On enter we snapshot the leading gap and each chip's width and hold them; a
     closed chip's slot stays empty until the pointer leaves. Same reason Chrome freezes tab
     widths while you are closing tabs. */
  const freeze = useCallback(() => {
    const host = hostRef.current;
    const track = trackRef.current;
    if (!host || !track) return;
    const hostLeft = host.getBoundingClientRect().left;
    const order: string[] = [];
    const widths: Record<string, number> = {};
    for (const node of track.querySelectorAll<HTMLElement>('[data-vault]')) {
      const vault = node.dataset.vault;
      if (!vault) continue;
      order.push(vault);
      widths[vault] = node.getBoundingClientRect().width;
    }
    setFrozen({
      lead: track.getBoundingClientRect().left - hostLeft + host.scrollLeft,
      order,
      widths,
    });
  }, []);

  const release = useCallback(() => setFrozen(null), []);

  /* ── One-shot bounce: a background project just started waiting on an answer ──────
     The EDGE, not the level. A chip sitting at `waiting: 2` across a re-render has not asked
     a second question, and re-running the animation every time the strip re-renders reads as
     a chip that never settles — so the previous count is held per vault and only a genuine
     0→>0 crossing fires. This is the single place in the app that decides a chip bounces:
     `attention.ts` deliberately exposes no subscriber to bounce off (it already raises the
     chime, banner and Dock bounce for the same question), and one edge with two detectors is
     how a chip ends up jumping twice for one interruption.

     Three chips never fire, each for its own reason:
      · the ACTIVE one — the question is already on screen in front of the user; motion that
        says "come here" is wrong for the place they already are;
      · one seen for the FIRST time — opening a project that happens to be mid-question is
        the user's own click, not an interruption;
      · any chip, when the user asked for reduced motion. Read at fire time rather than at
        mount so a mid-session change is honoured. The colour and the badge still change, so
        nothing is carried by the animation alone (the stylesheet suppresses the keyframes
        too — this arm is what also keeps the flag below from latching with no `animationend`
        ever coming to clear it). */
  useEffect(() => {
    const started: string[] = [];
    const next: Record<string, number> = {};
    for (const chip of chips) {
      const seen = seenWaitingRef.current[chip.vault];
      next[chip.vault] = chip.waiting;
      if (seen === 0 && chip.waiting > 0 && !chip.active) started.push(chip.vault);
    }
    seenWaitingRef.current = next; // drops vaults whose chip is gone
    if (started.length === 0 || prefersReducedMotion()) return;
    setBouncing((prev) => {
      const merged = { ...prev };
      for (const vault of started) merged[vault] = true;
      return merged;
    });
  }, [chips]);

  const endBounce = useCallback((vault: string) => {
    setBouncing((prev) => {
      if (!prev[vault]) return prev;
      const next = { ...prev };
      delete next[vault];
      return next;
    });
  }, []);

  /* ── Context menu lifecycle ─────────────────────────────────────────────────────
     A transient popover, not a modal: it is dismissed by anything that moves the page
     underneath it, and it deliberately does NOT enter the overlay stack, which exists to
     arbitrate Escape between stacked MODALS. */
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMenu(null);
      }
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  const openMenu = useCallback((e: ReactMouseEvent, vault: string) => {
    e.preventDefault();
    setMenu({
      vault,
      x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH - MENU_MARGIN),
      y: e.clientY,
    });
  }, []);

  // While frozen, render the freeze-time order so a closed chip leaves its slot behind;
  // anything opened since (rare — it needs the switcher while hovering the strip) is
  // appended at its natural width.
  const byVault = new Map(chips.map((c) => [c.vault, c]));
  const order = frozen
    ? [...frozen.order, ...chips.filter((c) => !frozen.order.includes(c.vault)).map((c) => c.vault)]
    : chips.map((c) => c.vault);

  return (
    <div
      className="project-tabs"
      ref={hostRef}
      data-overflow={overflowing ? 'true' : 'false'}
      data-frozen={frozen ? 'true' : 'false'}
      onPointerEnter={freeze}
      onPointerLeave={release}
    >
      <div
        className="project-tabs-track"
        ref={trackRef}
        style={frozen ? ({ '--tabs-lead': `${frozen.lead}px` } as CSSProperties) : undefined}
      >
        {order.map((vault) => {
          const chip = byVault.get(vault);
          const width = frozen?.widths[vault];

          // A chip that closed while the layout is frozen: its slot is held open and empty.
          if (!chip) {
            return <div key={vault} className="project-tab-ghost" style={{ width }} aria-hidden="true" />;
          }

          return (
            <div
              key={vault}
              className="project-tab"
              data-vault={vault}
              data-active={chip.active ? 'true' : 'false'}
              data-cold={chip.cold ? 'true' : 'false'}
              data-kind={chip.worst}
              data-bouncing={bouncing[vault] ? 'true' : 'false'}
              style={width !== undefined ? { width } : undefined}
              // Animation events bubble, so name-check it: any finite animation added to a
              // descendant later would otherwise cut the bounce short.
              onAnimationEnd={(e) => { if (e.animationName === 'projectTabBounce') endBounce(vault); }}
              onContextMenu={(e) => openMenu(e, vault)}
            >
              <button
                type="button"
                className="project-tab-main"
                aria-current={chip.active ? 'true' : undefined}
                title={(chip.cold ? `${vault} — sleeping, click to reopen` : vault) + cycleHint}
                // The dot and the badge are colour and a bare number; the label is where the
                // same information is available to anyone not reading the pixels.
                aria-label={describeChip(chip)}
                onClick={() => onActivate(vault)}
              >
                <span className="project-tab-dot" aria-hidden="true" />
                <span className="project-tab-name">{vault}</span>
                {/* Omitted at 0: a "0" badge is noise on a project with nothing running. */}
                {chip.live > 0 && (
                  <span className="project-tab-badge" aria-hidden="true">{chip.live}</span>
                )}
              </button>
              <button
                type="button"
                className="project-tab-close"
                disabled={!canClose}
                title={canClose ? `Close ${vault}` : 'The window must keep one project open'}
                aria-label={`Close ${vault}`}
                onClick={() => onClose(vault)}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}

        <button
          type="button"
          className="project-tabs-add"
          title="Open another project"
          aria-label="Open another project"
          onClick={onAdd}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {menu && (
        <div
          className="project-tab-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="project-tab-menu-item"
            onClick={() => {
              const { vault } = menu;
              setMenu(null);
              onDetach(vault);
            }}
          >
            Open in New Window
          </button>
        </div>
      )}
    </div>
  );
}
