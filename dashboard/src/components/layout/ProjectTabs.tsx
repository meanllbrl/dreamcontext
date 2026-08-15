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

/** One project's chip. Every count comes straight from `rollupProject()`. */
export interface ProjectChip {
  vault: string;
  active: boolean;
  /**
   * Where a ⌥Tab pick is currently POINTING — not where the user is. At most one chip carries
   * it, and only while Control is physically held; releasing Control is what turns it into
   * `active`. Two separate claims, drawn as two separate things (see the CSS).
   */
  preview: boolean;
  /** Torn down to free a slot at the instance ceiling; the chip stays, the instance is gone. */
  cold: boolean;
  /** Worst-of session state across the project. Nothing on the chip is DRAWN from this any
   *  more — the bubbles carry state now — but it is what `describeChip` says in words. */
  worst: SessionStatusKind;
  /** Live conversations, i.e. `asking + working + idle`. Read only as the "does this chip
   *  have anything at all" test and in the spoken label; the bubbles show the breakdown. */
  live: number;
  /**
   * Sessions blocked on the user. Its own 0→>0 edge is the ONE bounce trigger, detected in
   * this component and nowhere else — see the bounce effect below.
   */
  waiting: number;
  /*
   * The three status bubbles, in the order they are drawn. A count of 0 draws NOTHING, so a
   * project holding ten chats still spends at most three bubbles on saying so — that ceiling
   * is the whole reason the strip is handed counts instead of a list of sessions.
   */
  /** Blocked on you RIGHT NOW — a question, a permission prompt, a plan. Magenta, filled,
   *  always leftmost. Strictly the live status: a chat that merely finished something unseen
   *  is `flagged` below, and drawing it here is what once left a working chat sitting magenta
   *  until it was clicked. */
  asking: number;
  /** Mid-turn or connecting. Green, and the only bubble that carries the loading ring. */
  working: number;
  /** Open and idle. Grey and silent. */
  idle: number;
  /** Live chats with something you have not seen yet. NOT a fourth bubble — one small dot
   *  after the three, exactly like the dock tile's badge, because it rides ALONGSIDE a chat's
   *  live state rather than replacing it (a chat can be working and unseen at once). */
  flagged: number;
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
 * The bubbles, in draw order: most urgent first, and the order never depends on the counts.
 * A row that re-sorted itself as numbers moved would make the eye re-read the whole chip on
 * every status flip, which is the opposite of what a glanceable strip is for.
 */
const BUBBLES = [
  { state: 'asking', label: 'needs you' },
  { state: 'working', label: 'working' },
  { state: 'idle', label: 'idle' },
] as const;

/**
 * What the chip's bubbles SAY, in words — the same three counts, spoken.
 *
 * WCAG's "never by colour alone" is why this exists at all: a bubble carries its meaning in
 * its hue, and the ring that marks `working` is removed outright under `prefers-reduced-
 * motion`. The number inside each bubble is a second visual channel, but only the label makes
 * the mapping (magenta = needs you) available to anyone not reading the pixels.
 */
function describeChip(chip: ProjectChip): string {
  const parts = [chip.vault];
  if (chip.cold) parts.push('sleeping, click to reopen');
  for (const { state, label } of BUBBLES) {
    const n = chip[state];
    if (n > 0) parts.push(`${n} ${label}`);
  }
  // The dot, in words. Said separately from the bubbles because it is a separate fact: "2
  // working" and "1 of them finished something you haven't seen" are both true at once, and
  // the count above deliberately no longer swallows the second one.
  if (chip.flagged > 0) parts.push(`${chip.flagged} unseen`);
  // `waiting` counts shells too, so it can be non-zero with every bubble AND the dot at 0: a
  // background terminal rang its bell. That is what makes the chip bounce, so it has to be
  // sayable — but only when nothing more specific already said it.
  else if (chip.waiting > 0 && chip.asking === 0) parts.push('wants a look');
  if (chip.live === 0 && !chip.cold) parts.push('no chats');
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

  // ⌥Tab only means something once there is a second chip, and that is also the only moment
  // it is worth naming in a tooltip — see the shortcut's own reasoning in `WindowChrome`.
  const cycleHint = chips.length > 1 ? ' · hold ⌥ and press Tab to switch' : '';

  // A pick is in flight: Control is down and the cursor is sitting on one of these chips.
  // Derived rather than passed, because a second prop saying the same thing as this field is
  // a second source of truth for one state, and they drift.
  const previewed = chips.find((c) => c.preview) ?? null;

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

  /* ── Two motions, one rule: match the MOTION to the shape of the event ────────────
     A moment gets a one-shot, a STATE gets a repeating one. Both live here, and a chip is
     never doing both — the split is what keeps the strip from looking like it is twitching at
     random.

     · A QUESTION IS PENDING (`asking > 0`) → the chip nudges every 2.4s for as long as it is
       true, and stops the instant the question is answered. A pending question is not an
       event that happened, it is a condition that PERSISTS: a one-shot bounce fired at the
       moment it arrived is over in half a second, and a user who was looking elsewhere then
       has nothing left to find. This is the same shake, on the same 2.4s beat, that the dock
       anchor already runs for the same signal (`agentChipNudge`), because one signal drawn
       two different ways sends you looking for a difference that isn't there.

       Driven off the LIVE `asking` count, so it can never latch: it is derived from the
       session's real status, not from a sticky flag, which is exactly the distinction that
       once left these chips stuck magenta.

     · ANYTHING ELSE WORTH A LOOK (`waiting` crossing 0→>0 with no question) → one bounce.
       A background build ringing its bell, a chat finishing unseen: real, but over. The EDGE,
       not the level — a chip sitting at `waiting: 2` across a re-render has not asked a second
       question, so the previous count is held per vault and only a genuine crossing fires.
       This is the single place in the app that decides a chip bounces: `attention.ts`
       deliberately exposes no subscriber to bounce off (it already raises the chime, banner
       and Dock bounce for the same question), and one edge with two detectors is how a chip
       ends up jumping twice for one interruption.

     The bounce additionally skips three chips, each for its own reason:
      · the ACTIVE one — whatever it is announcing is already on screen in front of the user;
        motion that says "come here" is wrong for the place they already are. (The QUESTION
        nudge deliberately does NOT make this exception — see the render below.)
      · one seen for the FIRST time — opening a project that happens to be mid-question is
        the user's own click, not an interruption;
      · any chip, when the user asked for reduced motion. Read at fire time rather than at
        mount so a mid-session change is honoured. The colour and the badge still change, so
        nothing is carried by the animation alone (the stylesheet suppresses the keyframes
        too — this arm is what also keeps the flag below from latching with no `animationend`
        ever coming to clear it). */
  useEffect(() => {
    const started: string[] = [];
    const asking: string[] = [];
    const next: Record<string, number> = {};
    for (const chip of chips) {
      const seen = seenWaitingRef.current[chip.vault];
      // Recorded even for an asking chip, so that answering the question and THEN ringing a
      // bell later still reads as a fresh 0→>0 crossing rather than a level that never reset.
      next[chip.vault] = chip.waiting;
      if (chip.asking > 0) { asking.push(chip.vault); continue; }
      if (seen === 0 && chip.waiting > 0 && !chip.active) started.push(chip.vault);
    }
    seenWaitingRef.current = next; // drops vaults whose chip is gone
    const canBounce = started.length > 0 && !prefersReducedMotion();
    if (!canBounce && asking.length === 0) return;
    setBouncing((prev) => {
      let merged = prev;
      const own = () => { if (merged === prev) merged = { ...prev }; return merged; };
      // HAND OVER, don't stack: a bounce already in flight when the question lands would fight
      // the nudge for the same `animation` property, and the loser is decided by stylesheet
      // order rather than by intent. Clearing the flag here makes the two mutually exclusive
      // in the markup, so the CSS never has to arbitrate.
      for (const vault of asking) if (merged[vault]) delete own()[vault];
      if (canBounce) for (const vault of started) own()[vault] = true;
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
      data-picking={previewed ? 'true' : 'false'}
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
              data-preview={chip.preview ? 'true' : 'false'}
              data-cold={chip.cold ? 'true' : 'false'}
              data-kind={chip.worst}
              /*
                A question is pending in this project — the repeating nudge (see the effect
                above). Set on EVERY such chip, the active one included, which is the one place
                this deliberately parts company with the bounce: a project can hold several
                chats, so "you are looking at this project" does not mean you are looking at
                the chat that is blocked — it may be behind another pane, or the whole agent
                surface may be collapsed to the corner dock. The dock anchor shakes regardless
                of focus for exactly this reason, and the chip is the same claim one level up.
              */
              data-asking={chip.asking > 0 ? 'true' : undefined}
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
                title={(chip.cold ? `${vault} — sleeping, click to reopen` : describeChip(chip)) + cycleHint}
                // The bubbles are colour and a bare number; the label is where the same
                // information is available to anyone not reading the pixels.
                aria-label={describeChip(chip)}
                onClick={() => onActivate(vault)}
              >
                <span className="project-tab-name">{vault}</span>
                {/*
                  One bubble per non-empty status, never a "0". The zero case is the reason
                  this is a filter and not three conditional spans: a quiet project draws no
                  bubbles at all, so the strip stays silent when nothing is happening rather
                  than carrying three permanent grey marks.
                */}
                {chip.live > 0 && (
                  <span className="project-tab-bubbles" aria-hidden="true">
                    {BUBBLES.filter(({ state }) => chip[state] > 0).map(({ state }) => (
                      <span key={state} className="project-tab-bubble" data-state={state}>
                        {/*
                          An element rather than a ::after, so the ring can be positioned
                          under the number while overflowing the bubble's box. It inherits
                          the bubble's pill radius, which is what makes a two-digit count
                          work: the bubble grows sideways into a stadium and the ring simply
                          follows its shape instead of needing a second drawing.
                        */}
                        {state === 'working' && (
                          <span className="project-tab-bubble-ring" aria-hidden="true" />
                        )}
                        <span className="project-tab-bubble-n">{chip[state]}</span>
                      </span>
                    ))}
                    {/*
                      The unseen dot, AFTER the three counts and outside the partition. It is
                      the dock tile's badge at strip scale: a chat that finished while you were
                      elsewhere keeps its real colour (green if it went straight back to work,
                      grey if it is idle) and grows this beside it, instead of the whole bubble
                      turning magenta and staying there until clicked.
                    */}
                    {chip.flagged > 0 && <span className="project-tab-flag" />}
                  </span>
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

      {/*
        The held pick, in words, under the enlarged glass.

        It is doing two jobs at once and both are load-bearing. Visually it teaches the half of
        the gesture nothing on screen can show — that the switch happens on RELEASE, and that
        the cursor also moves with the arrows — at the one moment the user is holding the key
        and can act on it. For a screen reader it is the announcement: `role="status"` names
        the project the pick is pointing at as the cursor moves, which the chip's own ring
        (colour and a shadow) cannot say on its own.

        Absolutely positioned so the strip's geometry — Rule 1's frozen widths, Rule 2's
        centring — is identical whether or not a pick is in flight.
      */}
      {previewed && (
        <div className="project-tabs-hint" role="status">
          <span className="project-tabs-hint-name">{previewed.vault}</span>
          <span className="project-tabs-hint-keys">release ⌥ · ←→ to move</span>
        </div>
      )}

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
