/**
 * `AgentMemberCard.tsx` (the Agents page's member list) has nothing about its own JSX worth
 * pinning without a DOM — this repo's vitest runs in `node`, no jsdom, same constraint
 * `automations-flow-canvas.test.ts` documents for its sibling component.
 *
 * What IS worth pinning, in plain node/fs, is the gap the TypeScript compiler cannot see:
 * the card's human-readable status word is chosen by a `switch` in `statusWord()` keyed off
 * `RunStatus` (`useAutomations.ts`), and nothing checks the two against each other. A future
 * `RunStatus` member would reach the card with no word of its own and render as the raw
 * status string via the `switch`'s `default: return status` fallback — this pins that the
 * fallback is never REACHED for a status the union actually declares.
 *
 * WHY IT READS TWO FILES (2026-09-20). It used to read `RunStatus` from the dashboard mirror
 * and pin its members against a literal list of seven. That is a mirror checked against
 * itself: the backend had already grown an eighth status (`awaiting-approval`), the mirror
 * never received it, and a card in the owner's own vault printed the raw enum at them via
 * `statusWord`'s `default` fallback. The parity is now measured against
 * `src/lib/automations/types.ts` — the list the runner actually writes — in both directions.
 *
 * WHAT THIS TEST USED TO ALSO CHECK, AND WHY IT NO LONGER DOES (2026-09-19, agents step 1).
 * It previously asserted that every `RunStatus` member had a `.auto-card-status-dot--<x>`
 * colour rule, because the old `AutomationCard` painted the status as a coloured dot beside
 * a word. The member card that replaced it states the last run as a SENTENCE — "Last run
 * failed, Sep 18 09:00." — with no dot at all, which is Tilki K26/K40 (a status is a word,
 * not a badge) and is a deliberate design change, not a dropped requirement. Re-pointing
 * that assertion at a dot the card does not render would have made it pass by checking dead
 * CSS. The parity that still exists — one word per status — is what remains asserted.
 *
 * A source-text scan is exactly what a node-environment test can honestly assert here: no
 * DOM, no rendering, no re-assertion of a constant against itself — the check below is a
 * PARITY check against `RunStatus`, an external source of truth this file does not own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOOKS_TS = fileURLToPath(new URL('../../dashboard/src/hooks/useAutomations.ts', import.meta.url));
/** The SOURCE OF TRUTH. `RunStatus` in the dashboard is a hand-written mirror of
 *  this list (the dashboard has no import path into `src/`), and a mirror that
 *  is only ever checked against ITSELF cannot notice a member it never
 *  received — which is exactly what happened: the backend carried
 *  `awaiting-approval`, the mirror did not, and a card printed the raw enum at
 *  a human. See `knowledge/patterns/mirror-with-drift-test`. */
const TYPES_TS = fileURLToPath(new URL('../../src/lib/automations/types.ts', import.meta.url));
const CARD_TSX = fileURLToPath(new URL('../../dashboard/src/components/agents/AgentMemberCard.tsx', import.meta.url));

/** `summary.cache?.status` is `RunStatus | null` — the card's word handles `null` as this
 *  literal extra case (`?? null`), which is not itself a member of `RunStatus` and so
 *  cannot be read off that union the way every other case can. */
const NULL_STATUS_CASE = 'none';

/** `RUN_STATUSES` as the backend actually declares it. */
function readBackendStatuses(): string[] {
  const src = readFileSync(TYPES_TS, 'utf8');
  const m = src.match(/export const RUN_STATUSES = \[([\s\S]+?)\] as const;/);
  expect(m, 'RUN_STATUSES must exist in src/lib/automations/types.ts').not.toBeNull();
  return [...m![1].matchAll(/'([a-z-]+)'/g)].map((mm) => mm[1]);
}

function readRunStatusMembers(): string[] {
  const src = readFileSync(HOOKS_TS, 'utf8');
  // Non-greedy up to the terminating `;` — the union's members are interleaved with a
  // block comment (see `'awaiting-review'`'s), so this deliberately does not assume the
  // union is comment-free.
  const m = src.match(/export type RunStatus =\s*([\s\S]+?);/);
  expect(m, 'RunStatus type alias must exist in useAutomations.ts').not.toBeNull();
  return [...m![1].matchAll(/'([a-z-]+)'/g)].map((mm) => mm[1]);
}

describe('AgentMemberCard status-word parity with RunStatus', () => {
  it('the dashboard mirror carries EVERY status the backend declares', () => {
    // The check that would have caught the real bug. Asserted against the
    // backend's own list, not a pinned literal and not the mirror itself — a
    // mirror compared only to itself agrees with itself by construction.
    const backend = readBackendStatuses();
    const mirror = readRunStatusMembers();
    const missing = backend.filter((s) => !mirror.includes(s));
    expect(missing, `RunStatus in useAutomations.ts is missing: ${missing.join(', ')}`).toEqual([]);
    // And nothing invented on the mirror side either, which would render a word
    // for a state the runner can never produce.
    const extra = mirror.filter((s) => !backend.includes(s));
    expect(extra, `RunStatus in useAutomations.ts invents: ${extra.join(', ')}`).toEqual([]);
  });

  it('every RunStatus member (plus the null-status case) has its own `case` in `statusWord()`', () => {
    // Driven off the BACKEND list, so a status the runner can produce always
    // needs a human-readable word here — even on the day the mirror forgets it.
    const statuses = [...readBackendStatuses(), NULL_STATUS_CASE];
    const src = readFileSync(CARD_TSX, 'utf8');
    const fn = src.match(/function statusWord\([\s\S]+?\n\}/);
    expect(fn, 'statusWord() must exist in AgentMemberCard.tsx').not.toBeNull();
    const body = fn![0];
    // `NULL_STATUS_CASE` ('none') is handled by the leading `if (!status) return …` guard,
    // not a `case` label — checked separately so the loop below can stay a single shape.
    expect(body).toMatch(/if \(!status\) return/);
    const missing = statuses
      .filter((s) => s !== NULL_STATUS_CASE)
      .filter((s) => !body.includes(`case '${s}':`));
    expect(missing, `status(es) with no dedicated statusWord() case: ${missing.join(', ')}`).toEqual([]);
  });
});
