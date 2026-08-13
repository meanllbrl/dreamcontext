/**
 * `AutomationCard.tsx` (D5: last fire time + last status, unmistakable even on a healthy
 * run) has nothing about its own JSX worth pinning without a DOM — this repo's vitest runs
 * in `node`, no jsdom, same constraint `automations-flow-canvas.test.ts` documents for its
 * sibling component.
 *
 * What IS worth pinning, in plain node/fs, is the same class of gap that test guards
 * against: `AutomationCard.tsx`'s status dot is built from a template literal
 * (`auto-card-status-dot--${status}`) keyed off `RunStatus` (`useAutomations.ts`), and its
 * word is chosen by a `switch` in `statusWord()`. Neither is checked by the TypeScript
 * compiler against the other — nothing stops a future `RunStatus` member from reaching the
 * card with no CSS color and no human-readable word, silently rendering as an uncolored dot
 * next to the raw status string (via the `switch`'s `default: return status` fallback,
 * itself untestable without a DOM: this only pins that the fallback is never REACHED for a
 * status the union actually declares).
 *
 * A source-text scan (regex over the three files) is exactly what a node-environment test
 * can honestly assert here: no DOM, no rendering, no re-assertion of a constant against
 * itself — every check below is a PARITY check against `RunStatus`, an external source of
 * truth this file does not own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOOKS_TS = fileURLToPath(new URL('../../dashboard/src/hooks/useAutomations.ts', import.meta.url));
const CARD_TSX = fileURLToPath(new URL('../../dashboard/src/components/automations/AutomationCard.tsx', import.meta.url));
const CARD_CSS = fileURLToPath(new URL('../../dashboard/src/components/automations/AutomationCard.css', import.meta.url));

/** `summary.cache?.status` is `RunStatus | null` — the card's dot/word both handle `null`
 *  as this literal extra case (`?? 'none'` / `?? null`), which is not itself a member of
 *  `RunStatus` and so cannot be read off that union the way every other case can. */
const NULL_STATUS_CASE = 'none';

function readRunStatusMembers(): string[] {
  const src = readFileSync(HOOKS_TS, 'utf8');
  // Non-greedy up to the terminating `;` — the union's members are interleaved with a
  // block comment (see `'awaiting-review'`'s), so this deliberately does not assume the
  // union is comment-free.
  const m = src.match(/export type RunStatus =\s*([\s\S]+?);/);
  expect(m, 'RunStatus type alias must exist in useAutomations.ts').not.toBeNull();
  return [...m![1].matchAll(/'([a-z-]+)'/g)].map((mm) => mm[1]);
}

describe('AutomationCard status dot/word parity with RunStatus (useAutomations.ts)', () => {
  it('RunStatus still has the seven members this card was built against', () => {
    // Pinned as a canary: if this fails, `RunStatus` itself changed upstream and the two
    // checks below need a human look, not just a green run.
    expect(readRunStatusMembers()).toEqual([
      'ok', 'failed', 'timeout', 'blocked', 'deferred', 'orphaned', 'awaiting-review',
    ]);
  });

  it('every RunStatus member (plus the null-status case) has a `.auto-card-status-dot--<x>` color rule', () => {
    const statuses = [...readRunStatusMembers(), NULL_STATUS_CASE];
    const css = readFileSync(CARD_CSS, 'utf8');
    const missing = statuses.filter((s) => !css.includes(`.auto-card-status-dot--${s}`));
    expect(missing, `status(es) with no dot color rule: ${missing.join(', ')}`).toEqual([]);
  });

  it('every RunStatus member (plus the null-status case) has its own `case` in `statusWord()`', () => {
    const statuses = [...readRunStatusMembers(), NULL_STATUS_CASE];
    const src = readFileSync(CARD_TSX, 'utf8');
    const fn = src.match(/function statusWord\([\s\S]+?\n\}/);
    expect(fn, 'statusWord() must exist in AutomationCard.tsx').not.toBeNull();
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
