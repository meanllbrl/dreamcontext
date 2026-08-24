/**
 * The pinned shelf's two structural invariants — the ones that are true because of where
 * code ISN'T, which is precisely the kind review does not catch.
 *
 *   1. PLACEMENT. `PinShelf` is mounted OUTSIDE `.chat-transcript`. Everything the shelf
 *      promises ("after scrolling to the top of a long conversation and back, it is still on
 *      screen and unchanged") follows from that one fact: a node that is not inside the
 *      scroller cannot be scrolled. Move the mount inside and every geometry assertion in
 *      `scripts/verify/chat-shelf-ui.mjs` starts failing for a reason no unit test would name.
 *
 *   2. NO SCROLL INPUT. Neither the component nor its hook may observe scroll at all. The
 *      board's fifth rule is NO SCROLL REACTION, argued from two bugs this transcript already
 *      paid to close twice ("I scroll up, you load history, and the place I was at moves").
 *      The strongest possible guarantee is not "we handle scroll carefully" but "there is no
 *      scroll signal in this subtree to handle".
 *
 * Both are checked against the SOURCE rather than a rendered DOM because root vitest runs
 * under the plain Node environment (no jsdom in this repo) — and a source scan is the right
 * instrument for an absence anyway. The live geometry is asserted separately, with real
 * boxes, by `scripts/verify/chat-shelf-ui.mjs`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const CHAT_PANE = 'dashboard/src/components/sleepy/ChatPane.tsx';
const SHELF = 'dashboard/src/components/sleepy/chat/PinShelf.tsx';
const HOOK = 'dashboard/src/components/sleepy/chat/useShelf.ts';

/**
 * Source with comments and string/template literals removed.
 *
 * This matters: both files DOCUMENT that they take no scroll input, and a naive substring
 * scan would fail on the very sentence that explains the rule — which would teach the next
 * person to delete the explanation rather than keep the property. Only executable tokens are
 * searched.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')  // line comments (not the // of a URL)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")  // single-quoted strings
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')  // double-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');   // template literals
}

describe('the pinned shelf is not in the scroller', () => {
  it('mounts PinShelf after .chat-transcript closes, and never inside it', () => {
    const src = read(CHAT_PANE);
    const transcriptOpen = src.indexOf('className="chat-transcript"');
    const mount = src.indexOf('<PinShelf');
    // LAST occurrence: `<Composer` is also named in a doc comment ~1200 lines above the render
    // site, and anchoring on the first hit would compare the mount against prose.
    const composer = src.lastIndexOf('<Composer');

    expect(transcriptOpen, 'ChatPane no longer renders .chat-transcript — re-derive this test').toBeGreaterThan(-1);
    expect(mount, 'ChatPane does not mount <PinShelf>').toBeGreaterThan(-1);

    // The scroller's subtree ends where `<QueuedMessages>` begins — that row is already
    // documented in ChatPane as living OUTSIDE the scroller, so it is the anchor that makes
    // "after the transcript" precise without parsing JSX.
    const outsideAnchor = src.indexOf('<QueuedMessages');
    expect(outsideAnchor).toBeGreaterThan(transcriptOpen);
    expect(mount, '<PinShelf> must be mounted outside the transcript scroller').toBeGreaterThan(outsideAnchor);
    // …and above the composer, because the shelf docks to its TOP edge.
    expect(mount, '<PinShelf> must sit above the composer it docks to').toBeLessThan(composer);
  });

  it('passes the shell\'s own has-rows state to the composer, so the seam cannot drift', () => {
    expect(read(CHAT_PANE)).toContain('shelved={shelf.hasRows}');
  });
});

describe('the shelf takes no scroll input at all', () => {
  const FORBIDDEN = ['scrollTop', 'onScroll', 'IntersectionObserver', 'scroll'];

  for (const file of [SHELF, HOOK]) {
    it(`${file.split('/').pop()} contains no scroll token in executable code`, () => {
      const executable = code(read(file));
      for (const token of FORBIDDEN) {
        expect(
          executable.includes(token),
          `${file} references "${token}" — the shelf must not be able to observe scroll at all (board rule: NO SCROLL REACTION)`,
        ).toBe(false);
      }
    });
  }

  it('the comment-stripper does not simply blank the files (it would pass vacuously)', () => {
    // A stripper with a runaway regex would return whitespace and every assertion above would
    // pass for the wrong reason. Anchor it on something that must survive.
    expect(code(read(SHELF))).toContain('ResizeObserver');
    expect(code(read(HOOK))).toContain('layoutShelf');
  });
});

/**
 * The run-progress LIVENESS, and the two absences it depends on.
 *
 * Both are "true because of where code isn't", which is why they are here and not in
 * `progress-criteria.test.ts` beside the pure model. There is no jsdom in this repo, so a
 * mounted-and-unmounted assertion is not available — but the property that actually matters is
 * structural anyway: the interval must be OWNED BY A LEAF that only exists while a progress row
 * does, and it must be cleared. A guard that has to be remembered is a guard that eventually
 * isn't.
 */
describe('the second-tick clock is owned by the row, not by the pane', () => {
  it('useShelf starts no interval at all — it is called by ChatPane', () => {
    // A per-second state change in `useShelf` re-renders the entire chat pane, transcript
    // included, to change one word in one row. It lived there for one revision; this is what
    // stops it moving back.
    const executable = code(read(HOOK));
    expect(
      executable.includes('setInterval'),
      'useShelf must not run an interval — it is called by ChatPane, so every tick would re-render the whole pane',
    ).toBe(false);
  });

  it('PinShelf creates exactly one interval and clears it', () => {
    const executable = code(read(SHELF));
    const starts = executable.match(/setInterval/g) ?? [];
    const stops = executable.match(/clearInterval/g) ?? [];
    expect(starts, 'the since-last-write clock is gone from PinShelf').toHaveLength(1);
    expect(stops, 'an interval with no clearInterval outlives the row that justified it').toHaveLength(1);
  });

  it('the interval lives in ProgressRow\'s own hook, so no row means no timer', () => {
    // `ProgressRow` is rendered only when `layout.row?.kind === 'progress'`. Putting the
    // interval inside a hook that only IT calls is what makes "an idle shelf costs nothing"
    // true by construction rather than by a `if (!progressTask) return` somebody must keep.
    const src = read(SHELF);
    const hook = src.indexOf('function useSecondTick');
    const interval = src.indexOf('setInterval');
    const nextFn = src.indexOf('\nfunction ', hook + 1);
    expect(hook, 'useSecondTick is gone — re-derive where the clock lives').toBeGreaterThan(-1);
    expect(interval).toBeGreaterThan(hook);
    expect(interval, 'setInterval escaped useSecondTick').toBeLessThan(nextFn);
    // …and exactly one place CALLS it. The trailing `;` is what separates a call site from the
    // declaration `function useSecondTick(): number {`, which also contains `useSecondTick()`.
    const callers = (src.match(/useSecondTick\(\);/g) ?? []).length;
    expect(callers, 'useSecondTick is called from more than one place').toBe(1);
    // …and that place is ProgressRow.
    const row = src.indexOf('function ProgressRow');
    const call = src.indexOf('useSecondTick();');
    expect(call).toBeGreaterThan(row);
    expect(call).toBeLessThan(src.indexOf('\nfunction ', row + 1));
  });
});

/**
 * The live treatment is bound to the RUN, not to the panel.
 *
 * A settled task whose row still pulsed would be the same lie the static panel told, inverted:
 * motion that means nothing. `live` comes from `session.busy` and from nothing else — in
 * particular not from `openId`, which would make the animation a property of the user having
 * clicked rather than of work happening.
 */
describe('run-progress liveness is bound to the turn, not to the popover', () => {
  it('useShelf derives `live` from session.busy', () => {
    expect(code(read(HOOK))).toContain('live: session.busy');
  });

  it('the is-live class is driven by that prop and not by open state', () => {
    const src = read(SHELF);
    expect(src).toContain("${live ? ' is-live' : ''}");
    // The row's class expression must not mention the open flag. Anchored on the row's own
    // className rather than the file, because `open` legitimately appears elsewhere in it.
    const cls = src.slice(src.indexOf('function ProgressRow'));
    const expr = cls.slice(cls.indexOf('className={`pin-row'), cls.indexOf('data-pin-progress-trigger'));
    expect(expr).not.toContain('open');
  });
});
