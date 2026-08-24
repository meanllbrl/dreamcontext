import type { ProgressCriterion } from '../hooks/useAgentCapabilities';

/**
 * The pure reasoning behind the run-progress panel — what changed since the last poll, where
 * the work is, and how long ago the task file moved.
 *
 * It lives beside `shelfModel.ts` rather than inside it because the shelf's model answers a
 * layout question (which entry owns the one open row) and this answers a reading question
 * (what does the task file say now, and what did it say a moment ago). Both are pure and
 * unit-tested for the same reason: root vitest runs under plain Node with no jsdom, so
 * everything that can be decided without a DOM is decided here and the component is left
 * drawing the result.
 *
 * Why any of this exists: the panel used to render two lines — the criterion in flight and the
 * newest changelog bullet — under a header reading `8/20`, so it promised twenty rows and drew
 * two, and nothing on it ever moved between polls (owner, 2026-08-24: "fazla statik
 * hissettiriyor, live progress izleme gibi durmuyor"). The list fixed the first half. These
 * three functions are the second half: a tick you can SEE happening, and a clock that keeps
 * moving when the percent does not.
 */

/** U+0000 — see {@link criterionKey}. Named, because a bare escape inline reads as a typo. */
const KEY_SEP = '\u0000';

/**
 * The stable identity of a criterion across polls.
 *
 * NOT its index: a run that inserts a criterion mid-list would shift every key below it and
 * flash a dozen rows that never moved. The group + text pair is what the user is looking at,
 * and a NUL can occur in neither — both arrive through the route's `oneLine`, which collapses
 * every whitespace run — so it is an unambiguous separator.
 */
export function criterionKey(c: { text: string; group: string | null }): string {
  return `${c.group ?? ''}${KEY_SEP}${c.text}`;
}

/**
 * Which criteria flipped unticked → ticked between two readings of the task file.
 *
 * The liveness this panel was missing is not a faster poll; it is that a tick which HAPPENED
 * is never seen happening. Two consecutive payloads already carry that fact, so it is derived
 * here rather than asked of the server: nothing new is polled and nothing new is stored.
 *
 * Deliberately asymmetric — a criterion going ticked → unticked (an agent correcting itself,
 * a file rewritten) returns nothing. There is no "un-flash", and inventing one would put a
 * celebratory highlight on work being taken back.
 *
 * The FIRST reading of a run flashes nothing: `prev` is empty, so twenty already-ticked
 * criteria arriving together are the state of the world, not twenty things that just happened.
 */
export function newlyTicked(
  prev: readonly ProgressCriterion[],
  next: readonly ProgressCriterion[],
): string[] {
  if (prev.length === 0) return [];
  const before = new Map(prev.map((c) => [criterionKey(c), c.done]));
  const out: string[] = [];
  for (const c of next) {
    if (!c.done) continue;
    if (before.get(criterionKey(c)) === false) out.push(criterionKey(c));
  }
  return out;
}

/**
 * The index of the criterion IN FLIGHT — the first unticked one whose text is non-empty.
 *
 * "Non-empty" is what makes this agree with the route's `now` in every case rather than in the
 * common one. `firstUnticked` (src/lib/markdown.ts) skips a malformed `- [ ]` with no text
 * because naming `''` as the work in flight is worse than looking further down; `listCheckboxes`
 * KEEPS that line so the list length still matches the fraction beside it. Applying the same
 * rule here is what stops the row and the panel naming two different criteria on such a file.
 *
 * Returns -1 when every criterion is ticked — a real state (`all-done`), not an error.
 */
export function inFlightIndex(criteria: readonly ProgressCriterion[]): number {
  return criteria.findIndex((c) => !c.done && c.text.trim() !== '');
}

/** One milestone heading and the criteria under it, with that group's own tally. */
export interface CriterionGroup {
  /** The `### ` heading, or null for criteria written above the first one. */
  name: string | null;
  done: number;
  total: number;
  /** Index INTO THE FLAT LIST, so a group row and the in-flight index agree without a lookup. */
  items: { index: number; criterion: ProgressCriterion }[];
}

/**
 * The flat list, folded into its milestone headings, in document order.
 *
 * Runs of the same heading are merged only when ADJACENT — headings are not deduplicated
 * across the file. If a task really does write `### Part A` twice, that is two phases as
 * written and collapsing them would silently reorder the user's own document.
 *
 * A list with no headings comes back as ONE group named `null`, which the panel renders flat.
 * That is the whole reason `name` is nullable rather than defaulted to something like
 * "Criteria": an invented heading is a line of UI nobody wrote.
 */
export function groupCriteria(criteria: readonly ProgressCriterion[]): CriterionGroup[] {
  const out: CriterionGroup[] = [];
  criteria.forEach((criterion, index) => {
    const tail = out[out.length - 1];
    const group = tail && tail.name === criterion.group
      ? tail
      : (out.push({ name: criterion.group, done: 0, total: 0, items: [] }), out[out.length - 1]);
    group.items.push({ index, criterion });
    group.total += 1;
    if (criterion.done) group.done += 1;
  });
  return out;
}

/**
 * How long ago the task file last changed, as one short human string.
 *
 * This is the honest liveness signal. A spinner looks identical during a productive minute and
 * a hung one; a clock reading "3m ago" and climbing says which of the two you are watching.
 * Seconds below a minute — it has to visibly move — then minutes to the hour, then hours. No
 * "just now": that would be a second name for a fact the number already states, and it would
 * stop moving for the sixty seconds when movement matters most.
 *
 * `updatedAt` of 0 means the mtime was never read, which is not the same as "0s ago" — so this
 * returns null and the row shows no clock rather than a confident zero.
 */
export function sinceLabel(updatedAt: number, nowMs: number): string | null {
  if (!updatedAt) return null;
  const secs = Math.max(0, Math.round((nowMs - updatedAt) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
