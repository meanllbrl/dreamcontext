import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { useDismissOnOutside } from '../../../lib/useDismissOnOutside';
import {
  SHELF_DETAIL_PANE_FRACTION, SHELF_TAGS_PANE_FRACTION, type ShelfEntry, type ShelfTag,
} from '../../../lib/shelfModel';
import {
  criterionKey, groupCriteria, inFlightIndex, sinceLabel,
} from '../../../lib/progressModel';
import type { ProgressCriterion, TaskProgress } from '../../../hooks/useAgentCapabilities';
import { entryIdOf, type ShelfHandle } from './useShelf';
import './pinShelf.css';
// AFTER `pinShelf.css`, deliberately: `progressPanel.css` raises `.pin-pop`'s max-height, and
// at equal specificity the later sheet is the one that wins. Importing the stylesheet from the
// component is the convention every other file in this folder follows.
import './progressPanel.css';

/**
 * The pinned shelf — the surface docked to the composer's top edge that holds what a
 * transcript would scroll away: this session's facts, and a run's progress read from disk.
 *
 * ── The one property everything here is built to protect ────────────────────────────────
 * IT DOES NOT MOVE. The tag line is the row nearest the composer and its `y` is identical
 * whether a row is open above it or not, at every scroll position, in every state. That is
 * why the open row is rendered ABOVE the tag line rather than below it, why an expanded
 * detail grows upward into the transcript, and why this file contains no scroll listener, no
 * `scrollTop` read and no `IntersectionObserver`: a surface that cannot observe a scroll
 * gesture cannot react to one. (`tests/unit/chat-shelf-placement.test.ts` pins that
 * mechanically, because the absence of a thing is not visible in review.)
 *
 * ── What this component decides, and what it does not ───────────────────────────────────
 * Nothing. Every RULE — which entry owns the one open row, what demotes to a `⌃` tag, what
 * folds behind `+N`, whether a `row`-weight pin has earned its row — lives in the pure
 * `lib/shelfModel.ts` and arrives here as a finished `ShelfLayout`. This file draws it and
 * owns exactly two measurements the DOM alone can answer: how many chips fit on the tag line,
 * and how tall 40% of the pane is.
 *
 * ── Two panels, two behaviours, and the difference is deliberate ────────────────────────
 * A LONG PIN opens IN PLACE, growing upward into empty transcript: that content IS the pin,
 * and the row above the tags is exactly where it belongs. RUN PROGRESS opens as a POPOVER
 * floating over the conversation: its detail is a glance, not the pin, and paying for that
 * glance in shelf height made the one surface that must never move the surface that moved
 * most (owner, after live testing). The popover therefore costs the shelf no height at all.
 *
 * ── There is nothing to measure about the tag line ──────────────────────────────────────
 * Tags always render, all of them, and `.pin-tags` wraps. An earlier cut folded them behind a
 * `+N` chip and had to measure chip widths to decide when — which misfired at full width and
 * hid four facts behind a lone `−4`. The only measurement left here is the pane's height.
 */

export function PinShelf({
  shelf, onOpenUrl,
}: {
  shelf: ShelfHandle;
  /** `openExternalUrl` (lib/desktop.ts) — passed in rather than imported so the Rust-side
   *  scheme validator stays in the chain and this component keeps no OS reach of its own. */
  onOpenUrl: (url: string) => void;
}) {
  const {
    layout, openId, setOpenId, hasRows, dismiss, promote,
    progress, justTicked, live, evicted,
  } = shelf;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // ONE measurement, and it is not about the tag line: the pane's height, written to
  // `--pin-detail-max` so a long pin's in-place detail is capped at its 40% share and scrolls
  // inside itself past that. `cqh` cannot express it — no ancestor declares a size container
  // (`.chat-pane` declares none, `.agent-pane` is `inline-size` only) — so it is measured the
  // same way the composer already measures its own ceiling against this very element.
  //
  // The tag line is deliberately NOT measured. It wraps; there is nothing to compute.
  // An empty shelf renders `null` (M1.7), so on the very first mount there is no element to
  // measure against. `mounted` is the dep that re-runs this the moment one appears — with
  // `[]` the effect would bail once, never re-run, and both caps would sit silently on their
  // CSS fallbacks (34vh / 25vh) instead of the measured pane. That is exactly what happened:
  // the fallbacks are close enough to the real values that nothing looked wrong.
  const mounted = layout.row !== null || layout.tags.length > 0;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const pane = root.closest('.chat-pane') as HTMLElement | null;
    if (!pane) return;

    const applyPaneCap = () => {
      const h = pane.getBoundingClientRect().height;
      if (h <= 0) return;
      root.style.setProperty('--pin-detail-max', `${Math.round(h * SHELF_DETAIL_PANE_FRACTION)}px`);
      root.style.setProperty('--pin-tags-max', `${Math.round(h * SHELF_TAGS_PANE_FRACTION)}px`);
    };
    applyPaneCap();
    const ro = new ResizeObserver(applyPaneCap);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [mounted]);

  const progressRow = layout.row?.kind === 'progress' ? layout.row : null;
  const progressOpen = !!progressRow && openId === progressRow.id;
  const closeProgress = () => setOpenId(null);
  // Esc arbitrates LIFO on the app's overlay stack and an outside pointerdown dismisses —
  // the same hook the composer's menus and the terminal's skill picker use, so this popover
  // can neither swallow an Esc meant for something stacked above it nor miss its own.
  // The row is named as an "inside" region by attribute: without that, pointerdown would
  // close the popover and the click that followed would immediately reopen it.
  useDismissOnOutside(progressOpen, closeProgress, [popRef], { ignoreSelector: '[data-pin-progress-trigger]' });

  // M1.7 — an empty shelf is NOT a zero-height strip with a border. It is nothing.
  if (layout.row === null && layout.tags.length === 0) return null;

  return (
    <div className="pin-shelf" ref={rootRef}>
      <div className={`pin-shell${hasRows ? ' has-rows' : ''}`}>
        {/* The progress DETAIL floats over the conversation rather than expanding the shelf:
            it costs the shelf no height, so the tag line and the composer cannot move when it
            opens (owner, after live testing). The ROW stays pinned exactly as it was. A long
            pin's detail still expands IN PLACE — that one grows upward into empty transcript
            and is the reason the row opens above the tags at all. */}
        {progressOpen && (
          <ProgressPopover
            progress={progress}
            justTicked={justTicked}
            popRef={popRef}
            onClose={closeProgress}
          />
        )}

        {progressRow && (
          <ProgressRow
            progress={progress}
            open={progressOpen}
            live={live}
            onToggle={() => setOpenId(progressOpen ? null : progressRow.id)}
            onDismiss={() => dismiss(progressRow.id)}
          />
        )}

        {layout.row?.kind === 'pin' && (
          <LedeRow
            entry={layout.row}
            open={openId === layout.row.id}
            onToggle={() => setOpenId(openId === layout.row!.id ? null : layout.row!.id)}
            onDismiss={() => dismiss(layout.row!.id)}
          />
        )}

        {/* EVERY tag, always. `.pin-tags` wraps, so a long line costs a second line instead
            of hiding facts behind a count — and because the tag area is the BOTTOM row, it
            grows downward into the composer's own padding rather than moving anything the
            user was reading. There is no fold and no measurement here by design; see
            shelfModel.ts's header for why the earlier one was deleted. */}
        <div className="pin-tags">
          {layout.tags.map((tag) => (
            <TagChip
              key={tag.id}
              tag={tag}
              onOpenUrl={onOpenUrl}
              onDismiss={dismiss}
              onPromote={promote}
            />
          ))}
          {/* Eviction is loud too: a conversation that pinned past the cap says how many it
              dropped rather than quietly forgetting them. */}
          {evicted > 0 && (
            <span
              className="pin-chip is-marker"
              title={`This conversation pinned more than the shelf keeps — ${evicted} of the oldest were dropped.`}
            >−{evicted} older</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── The open row: progress ──────────────────────────────────────────────────────────

/**
 * A run's progress, and — when the number cannot be honest — the reason instead.
 *
 * The percentage is never computed here. It arrives from `/api/agent/task-progress`, which
 * counts the task file's own ticked acceptance criteria: the same number `tasks doctor`
 * reports, so the user can check it. A `state` other than `ok` replaces the reading with its
 * notice rather than drawing a bar that would be a guess.
 */
/**
 * `Date.now()`, re-read once a second, for as long as the caller is mounted.
 *
 * It is a HOOK IN A LEAF on purpose. The obvious home is `useShelf`, next to the rest of the
 * shelf's state — but that hook is called by `ChatPane`, so a per-second state change there
 * would re-render the whole pane, transcript included, to change one word. Here the re-render
 * is the row and nothing else.
 *
 * It also settles "no interval while no progress row is on the shelf" by construction rather
 * than by a guard someone has to keep true: `ProgressRow` is only mounted when a row exists, so
 * the interval is created with it and cleared with it.
 */
function useSecondTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function ProgressRow({
  progress, open, live, onToggle, onDismiss,
}: {
  progress: TaskProgress | null;
  open: boolean;
  /** Whether the TURN is running — see `ShelfHandle.live`. */
  live: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  const tick = useSecondTick();
  const reading = progress && (progress.state === 'ok' || progress.state === 'all-done');
  const pct = reading ? progress.percent ?? 0 : null;
  // The panel is worth opening whenever there is a list to read, which there now always is for
  // a real reading — so this is no longer "is there a second string to show".
  const detail = (progress?.criteria.length ?? 0) > 0 || progress?.notice || progress?.last;
  const since = progress ? sinceLabel(progress.updatedAt, tick) : null;

  return (
    // No `.pin-open` wrapper and no in-place body: the detail is a POPOVER now, so this row
    // is exactly as tall open as closed. That is what makes "opening it never moves the tag
    // line" true by construction rather than by measurement.
    <div className={`pin-row${live ? ' is-live' : ''}`} data-pin-progress-trigger>
      <button type="button" className="pin-lede" aria-expanded={open} aria-haspopup="dialog" onClick={onToggle} disabled={!detail}>
        <span className="pin-caret" aria-hidden>{open ? '▾' : '▸'}</span>
        {pct !== null ? (
          <>
            <span className="pin-pct">{pct}%</span>
            <span className="pin-count">{progress!.done}/{progress!.total}</span>
            <span className="pin-dot" aria-hidden>·</span>
            <span className="pin-now">
              {progress!.now
                ? <><span className="pin-now-key">now: </span>{progress!.now}</>
                : <span className="pin-now-key">every criterion is ticked</span>}
            </span>
          </>
        ) : (
          <span className="pin-now">{progress?.notice ?? 'Reading the task file…'}</span>
        )}
        {/* The clock is the row's liveness, and it is deliberately a FACT rather than a
            spinner: a spinner looks the same during a productive minute and a hung one, while
            "12s ago" climbing to "4m ago" says which of the two this is. It moves every second
            whether or not the percent does — which is the whole difference between a panel you
            watch and a number you re-read. */}
        {since && (
          <span className="pin-since" title="Since the task file last changed on disk">{since}</span>
        )}
        {detail && <span className="pin-open-hint" aria-hidden>⌄</span>}
      </button>
      <button type="button" className="pin-x" aria-label="Unpin run progress" onClick={onDismiss}>×</button>
      {pct !== null && (
        <span className="pin-track" aria-hidden><span className="pin-track-fill" style={{ width: `${pct}%` }} /></span>
      )}
    </div>
  );
}

/**
 * The run's detail, floating over the conversation.
 *
 * Why a popover and not the in-place panel this started as: a progress detail is a GLANCE —
 * you open it, read what just happened, and close it — and paying for that glance by growing
 * the shelf meant the surface that must never move was the surface that moved most (owner,
 * after live testing). Absolutely positioned above `.pin-shell`, so it costs the shelf zero
 * height and the tag line and composer cannot shift when it opens.
 *
 * The in-place panel survives for LONG PINS (`LedeRow`), where it is right for the opposite
 * reason: that content is the pin, not a reading of it, and it grows upward into empty
 * transcript.
 *
 * ── What this used to be, and why it isn't ──────────────────────────────────────────────
 * It rendered exactly TWO `.pin-task` rows — the criterion in flight and the newest changelog
 * bullet — under a header reading `8/20`. The other eighteen were not folded away; the route
 * never sent them. So the panel stated a denominator it then declined to show, and between
 * polls nothing on it moved (owner, 2026-08-24: "genelde iki madde var 20 görünüyor … fazla
 * statik hissettiriyor, live progress izleme gibi durmuyor"). It now draws every criterion,
 * under its own milestone heading, with the one in flight marked and anything that ticked in
 * the last few seconds still lit — which is the panel the `8/20` was always promising.
 */
function ProgressPopover({
  progress, justTicked, popRef, onClose,
}: {
  progress: TaskProgress | null;
  justTicked: ReadonlySet<string>;
  popRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const reading = progress && (progress.state === 'ok' || progress.state === 'all-done');
  const criteria = progress?.criteria ?? [];
  const groups = useMemo(() => groupCriteria(criteria), [criteria]);
  const flight = inFlightIndex(criteria);

  return (
    <div className="pin-pop" role="dialog" aria-label="Run progress" ref={popRef}>
      {/* Head and the in-flight strip are STICKY (progressPanel.css), which is how the work in
          flight stays on screen in a twenty-item list.
          The obvious alternative — scroll the list to the in-flight row on open — is not
          available here and should not be made available: `chat-shelf-placement.test.ts`
          forbids every scroll token in this file, on the argument that a surface which cannot
          touch scroll cannot get scroll wrong. Sticky is the better answer anyway: it holds at
          EVERY scroll position, not only at the moment the panel opens, and it costs no JS. */}
      <div className="pin-pop-top">
        <div className="pin-pop-head">
          <span className="pin-title">Run progress</span>
          {reading && <span className="pin-count">{progress!.done}/{progress!.total} · {progress!.percent}%</span>}
          <button type="button" className="pin-x" aria-label="Close run progress" onClick={onClose}>×</button>
        </div>
        {reading && (
          <div className="pin-pop-flight">
            <span className="pin-task-glyph" aria-hidden>{flight === -1 ? '✓' : '●'}</span>
            <span className="pin-task-name">
              {flight === -1 ? 'every criterion is ticked' : criteria[flight].text}
            </span>
            <span className="pin-task-meta">{flight === -1 ? 'done' : 'in flight'}</span>
          </div>
        )}
      </div>
      <div className="pin-poplist">
        {progress?.notice && <p className="pin-notice">{progress.notice}</p>}
        {/* The cap is REPORTED, never swallowed. A list quietly shorter than the total above it
            is the exact defect this panel was rebuilt to remove, so it may not reappear at the
            boundary. */}
        {!!progress?.truncated && (
          <p className="pin-notice">
            {progress.truncated} more criteria are not shown — this task is past the {criteria.length}-item
            cap the shelf polls.
          </p>
        )}
        {groups.map((group, gi) => (
          <div className="pin-group" key={`${group.name ?? ''}#${gi}`}>
            {/* An ungrouped list renders flat: `name` is null and there is no heading to draw.
                Inventing one ("Criteria") would be a line of UI nobody wrote. */}
            {group.name && (
              <div className="pin-group-head">
                <span className="pin-group-name">{group.name}</span>
                <span className="pin-count">{group.done}/{group.total}</span>
              </div>
            )}
            {group.items.map(({ index, criterion }) => (
              <CriterionRow
                key={`${criterionKey(criterion)}#${index}`}
                criterion={criterion}
                inFlight={index === flight}
                justTicked={justTicked.has(criterionKey(criterion))}
              />
            ))}
          </div>
        ))}
        {/* The changelog bullet is what the AGENT last said, not a criterion — so it sits below
            a rule and outside the list rather than being counted or styled as a checkbox. */}
        {progress?.last && (
          <div className="pin-pop-foot">
            <span className="pin-task-meta">last logged</span>
            <span className="pin-task-name">{progress.last}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** One criterion. Three states and no fourth: ticked, in flight, still to do. */
function CriterionRow({
  criterion, inFlight, justTicked,
}: {
  criterion: ProgressCriterion;
  inFlight: boolean;
  justTicked: boolean;
}) {
  const cls = ['pin-task'];
  cls.push(criterion.done ? 'is-done' : inFlight ? 'is-now' : 'is-todo');
  if (justTicked) cls.push('is-just-ticked');
  return (
    <div className={cls.join(' ')}>
      <span className="pin-task-glyph" aria-hidden>{criterion.done ? '✓' : inFlight ? '●' : '○'}</span>
      {/* A criterion with no text is a malformed `- [ ]` in the task file. It is drawn as an
          empty row on purpose: the list length has to keep matching the fraction above it, and
          a blank line under a glyph is a visible "your task file has a bad line" — which is
          more use than silently dropping it and leaving 19 rows under a 20. */}
      <span className="pin-task-name">{criterion.text}</span>
      {/* No "in flight" label here — the sticky strip above already carries it, and printing it
          twice on screen at once was the first thing that read as noise. The row keeps the `●`
          and the accent, so it is still findable as the position marker in the list; the strip
          is what NAMES the state. */}
      {justTicked && <span className="pin-task-meta is-fresh">just ticked</span>}
    </div>
  );
}

// ─── The open row: a long pin ────────────────────────────────────────────────────────

/**
 * A pin whose content does not fit a chip. At rest it is exactly ONE row — a lede plus an
 * affordance — because quietly taking two would spend the entire ceiling and push the tag
 * line off screen.
 *
 * `.pin-clamp` (the `…` chip) appears ONLY when the shelf itself cut the line. That
 * distinction is the honesty rule: `…` means "the shelf truncated this", `⌄` means "there is
 * more behind it". An author who wrote a short lede for long prose gets the second and not
 * the first, so a clamped pin is never presented as complete.
 */
function LedeRow({
  entry, open, onToggle, onDismiss,
}: {
  entry: Extract<ShelfEntry, { kind: 'pin' }>;
  open: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  const label = entry.lede ?? entry.facts[0]?.label ?? entry.id;
  return (
    <div className={open ? 'pin-open' : undefined}>
      <div className="pin-row">
        <button type="button" className="pin-lede" aria-expanded={open} onClick={onToggle} disabled={!entry.detail}>
          <span className="pin-caret" aria-hidden>{open ? '▾' : '▸'}</span>
          <span className="pin-ledetext">{label}</span>
          {entry.ledeClamped && (
            <span className="pin-clamp" title="Clamped by the shelf — the author wrote no lede">…</span>
          )}
          {entry.detail && <span className="pin-open-hint" aria-hidden>⌄</span>}
        </button>
        <button type="button" className="pin-x" aria-label={`Unpin ${label}`} onClick={onDismiss}>×</button>
      </div>
      {open && entry.detail && (
        <div className="pin-body">
          {/* Sanitized markdown, never a raw HTML sink: `MarkdownPreview` runs every block
              through DOMPurify. A pin's prose is agent-authored, so this is the only way it
              may reach the document. */}
          <MarkdownPreview content={entry.detail} />
        </div>
      )}
    </div>
  );
}

// ─── The tag line ────────────────────────────────────────────────────────────────────

function BranchGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden>
      <path d="M3.5 3v6M3.5 6.5h3a2 2 0 0 0 2-2V3" />
      <circle cx="3.5" cy="2" r="1.05" />
      <circle cx="8.5" cy="2" r="1.05" />
      <circle cx="3.5" cy="10" r="1.05" />
    </svg>
  );
}

function WorktreeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden>
      <rect x="1.4" y="1.4" width="5.6" height="5.6" rx="1.4" />
      <path d="M4.6 10.6h4a2 2 0 0 0 2-2v-4" />
    </svg>
  );
}

/**
 * One chip. The `.pin-chip` box is always a `<span>` and any interaction lives INSIDE it —
 * a link chip that was itself a `<button>` could not also carry a dismiss `×`, and nesting
 * buttons is invalid. So the box holds up to two hit areas, both real buttons, both
 * keyboard-reachable.
 *
 * Server-derived facts (branch, worktree) carry NO `×`: they are polled, so dismissing one
 * would be a button that undoes itself on the next tick.
 */
function TagChip({
  tag, onOpenUrl, onDismiss, onPromote,
}: {
  tag: ShelfTag;
  onOpenUrl: (url: string) => void;
  onDismiss: (id: string) => void;
  onPromote: (id: string) => void;
}) {
  const cls = ['pin-chip'];
  if (tag.marker) cls.push('is-marker');
  if (tag.url) cls.push('is-link');
  if (tag.demoted) cls.push('is-demoted');

  const glyph = tag.icon === 'branch' ? <BranchGlyph />
    : tag.icon === 'worktree' ? <WorktreeGlyph />
      : null;

  return (
    <span className={cls.join(' ')} data-pin-tag title={tag.url ? tag.url : undefined}>
      {tag.icon === 'worktree' ? (
        // Both spellings ship; the container query at 470px swaps which one is on screen, so
        // the marker survives a narrow pane as its bracket glyph instead of wrapping the line.
        <>
          <span className="pin-chip-glyph" aria-hidden>{glyph}</span>
          <span className="pin-chip-word">{tag.label}</span>
        </>
      ) : (
        <>
          {glyph}
          {tag.url ? (
            <button
              type="button"
              className="pin-chip-open"
              aria-label={`Open ${tag.url}`}
              onClick={() => onOpenUrl(tag.url!)}
            >{tag.label} <span aria-hidden>↗</span></button>
          ) : tag.demoted ? (
            <button
              type="button"
              className="pin-chip-open"
              title="Demoted to a tag — click to re-open"
              onClick={() => onPromote(tag.id)}
            ><span className="pin-caret" aria-hidden>⌃</span>{tag.label}</button>
          ) : (
            <span className="pin-chip-label">{tag.label}</span>
          )}
        </>
      )}
      {tag.dismissable && (
        // Named for the PIN, not the chip. Dismissal is entry-level — a pin is the unit the
        // agent sent and the unit the store holds — so a pin carrying six facts loses all six.
        // Labelling this "Unpin :5173" would promise to remove one chip and remove five more.
        <button
          type="button"
          className="pin-chip-x"
          aria-label={`Unpin ${entryIdOf(tag.id)}`}
          title={`Unpin ${entryIdOf(tag.id)}`}
          onClick={() => onDismiss(tag.id)}
        >×</button>
      )}
    </span>
  );
}
