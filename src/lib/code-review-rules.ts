/**
 * code-review-rules — the three texts a Develop run's code review loop hands out, in one place.
 *
 * Measured over 390 Develop runs (2026-10-18 to 11-08; task develop-inceleme-dongusu-…): 41 ran
 * 3+ failing reviews in a row, and of the 180 blocking findings inside those loops 42% were holes
 * the previous fix opened, 32% another site of the same class, 17% the same finding unfixed and
 * 9% missed in round 1. The lead fixed the finding's sentence (one path, one field), pasted the
 * reviewer's suggested code unread (at least 10 holes came from that), and 39% of the "Major"s
 * were small. "The same finding twice = stop" caught none of it: two thirds of the repeats were
 * the same class in other words. These texts carry the answer to each:
 *
 *   CODE_REVIEW_RULES     what every code reviewer is told, every round, by
 *                         `dreamcontext builder review packet`. Mirrored verbatim into
 *                         skill-packs/agents/reviewer.md (tests/unit/code-review-loop.test.ts
 *                         holds them equal), so a reviewer dispatched without a packet still
 *                         writes the format the ledger parses.
 *   CODE_REVISION_RECIPE  what the lead is told before a fix: fix the class, every sibling
 *                         path, in one place; a reviewer's code is a hypothesis.
 *   CODE_STOP_CARD        the stop card's three options, in the owner's language.
 */

export const CODE_REVIEW_RULES = `## Code review rules

- Read the change yourself with the \`git diff\` lines the packet gives; a file with status A is
  new: read it whole. Never review from a summary, and never from a pasted diff.
- From round 2: read every reviewer's raw review of the previous round and the lead's fix note.
  Re-check each of YOUR open ids against the fix, then read the fix itself for holes it opened.
- First line exactly \`PASS\` or \`FAIL\`. Out of turns: \`PARTIAL\`, then a \`Not reviewed:\` line.
- Then the FULL current list of blocking findings. Re-state every one of YOUR open ids that is
  still open with its id; a new finding gets \`new\`. One line each, then its evidence:
  \`<k>. [Critical|Major] id: <id|new> | class: <name> | origin: <new|fix-hole|same-class> | harm: <who or what is hurt, and how>\`
  then \`file:line\` and a quote, and an optional \`Suggestion:\`. Number the list 1, 2, 3… once.
- \`harm\` is required: the user who sees or loses something, the data lost, corrupted or
  leaked, the check that lets something through. Major ONLY with a concrete harm on a real
  path. "Could be cleaner", "might confuse", a missing test alone, or a case nothing reaches is
  Minor. A Major without a concrete harm is recorded as Minor and opens no round. Critical: a
  security hole, data loss, or the wrong thing shipped.
- \`class\` is the invariant violated, not the spot. Before listing a finding, search the change
  for every sibling path where the same invariant applies and name them in the same finding.
  Reuse a name from the known classes when it fits, so a recurring problem is seen as one.
- \`origin\`: \`fix-hole\` = the previous fix opened it; \`same-class\` = another site of a known
  class (use that class's name); \`new\` = anything else.
- Close each of YOUR open ids you no longer hold with one line: \`closed: <id> | <why>\`. An own
  open id neither re-stated nor closed rejects the review. Other reviewers' ids are theirs.
- A \`Suggestion\` is a hypothesis for the lead, not a patch to paste: say what must hold.
- After the blocking list: a \`Non-blocking\` heading, Minor and Nit, one line each.
- For each ticked criterion say whether its evidence OBSERVED it or inferred it; a criterion
  about what the owner sees, ticked with no screenshot, is a Major (harm: the owner opens a
  screen nobody looked at).
- \`PASS\` means no blocking finding; still close your open ids.`;

export const CODE_REVISION_RECIPE = `## Fix by class, not by finding

1. For each open finding take its CLASS (the invariant), not its sentence.
2. Search the whole change for every sibling path where that invariant applies: each entry
   point, each field, each caller, not only the line named.
3. Fix it in the ONE place that covers all of them (one guard, one helper, one contract), never
   a patch per site.
4. A reviewer's Suggestion is a hypothesis: read the code it touches and verify it before you
   use any of it. Never paste suggested code unread.
5. Run the tests the fix touched (\`builder test --wave final --failed --related <files>\`).
6. Write changes.md WHOLE for this round: one \`sweep: <class> | <the sibling paths you
   checked> | <the one place you fixed it>\` line per open class, plus any \`redesign:\` or
   \`split:\` line the status asks for, then what changed and why.`;

/** The stop card's options, in the owner's language (he reads the card, not the CLI). */
export const CODE_STOP_CARD = {
  narrow: { label: 'Daralt', detail: 'Bu sınıfı taşıyan değişikliği bu işten geri al ve bir takip görevi aç. Kalan iş bir tur daha incelenir.' },
  split: { label: 'Böl', detail: 'Açık sınıfın bulgularını bir takip görevine kriter olarak taşı; o parça bu işten çıkar ve kalan iş bir kez daha incelenir.' },
  continue: { label: 'Devam', detail: 'Bir tur daha düzelt. Sınıf yine gelirse iş yine durur.' },
} as const;
