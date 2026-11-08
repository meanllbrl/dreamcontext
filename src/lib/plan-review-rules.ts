/**
 * plan-review-rules — the three texts the planning loop hands out, in one place.
 *
 * Measured on three long plans (Telegram 30 rounds, Apps 16 + 12; task
 * planlama-dongusu-sinif-bazli-…, 2026-11-08): the planner was the weak link (42% of the
 * findings after round 1 were holes the previous fix opened), then the review handoff (each
 * lens saw only its own findings, summarized; prompts named the section to look at), then
 * uncalibrated severity. These texts carry the answer to each:
 *
 *   PLAN_REVIEW_RULES     what every lens is told, every round, by `dreamcontext plan packet`.
 *                         Mirrored verbatim into skill-packs/agents/goal-plan-reviewer.md
 *                         (tests/unit/plan-review-rules.test.ts holds them equal), so a lens
 *                         dispatched without a packet still knows the format the ledger parses.
 *   PLAN_REVISION_RECIPE  what `plan status` prints to the planner before a revision: fix the
 *                         class, not the sentence, and rewrite the plan whole.
 *   PLAN_STOP_CARD        the three options of a stop card, in the owner's language. The lead
 *                         asks them as an owner card; a Super Agent never answers it.
 */

export const PLAN_REVIEW_RULES = `## Plan review rules

- Review the WHOLE plan snapshot the packet names, not only its Changes. Verify each claim
  against the code at the base the plan's Environment names, and read every file it cites.
- Read every lens's raw reviews from the previous round and the plan's Changes. A decision
  under the plan's Decisions is the owner's: never a finding (a Critical against it is an
  owner question, said as one). Do not invent problems; confidence over coverage.
- First line exactly \`SOLID\` or \`NEEDS_WORK\` (the pragmatist: \`PROPOSALS\`).
- Then the FULL current list of blocking findings. Re-state every one of YOUR open ids that is
  still open with its id; a new finding gets \`new\`. One line each, then its evidence:
  \`<k>. [Critical|Major] id: <id|new> | class: <name> | kind: <premise|contract|security|criteria|map> | <the invariant violated>\`
  then \`file:line\` or a quote, and an optional \`Suggestion:\`.
- Close each of YOUR open ids you no longer hold with one line: \`closed: <id> | <why>\`. An own
  open id neither re-stated nor closed rejects the review. Other lenses' ids are theirs: you
  may mention them, only the owning lens closes one.
- \`class\` is the invariant violated, not the spot. Reuse a name from the known classes when it
  fits, so a recurring problem is seen as one.
- Major ONLY when the fix changes a contract, a gate, a criterion, the wave map or the
  approach. Critical: it would ship a security hole, lose data or build the wrong thing. A fix
  local to one file is a build note, never blocking.
- After the blocking list: a \`Build notes\` heading (non-blocking, one line each), then a
  \`Non-blocking\` heading for Minor and Nit, one line each.
- \`SOLID\` means no blocking finding; still close your open ids.
- After a split, each moved id of yours is owed: \`closed: <id> | cut\` when the plan no longer
  carries that part, else re-state it. An id closed \`cut\` whose problem comes back is \`new\`.
- The pragmatist never blocks: after \`PROPOSALS\`, one line each
  \`- cut|defer|premise: <what> | <why> | <what it removes>\`. They go to the owner.`;

export const PLAN_REVISION_RECIPE = `## Revise by class, not by finding

1. For each open finding take its CLASS (the invariant), not its sentence.
2. Sweep every place in the plan where that invariant applies, not only the spot named.
3. Fix it at the one layer that covers all of them (one gate, one contract), never a patch per site.
4. A reviewer's Suggestion is a hypothesis: verify it against the code before adopting it.
5. Read every file the revision newly cites.
6. Rewrite plan.md WHOLE: no amendment layers, superseded text deleted.
7. Replace \`## Changes in this revision\` with what changed and why (and any \`redesign:\` or
   \`split:\` line the status asks for). Minors go to Build notes, never into reviewed text.`;

/** The stop card's options, in the owner's language (he reads the card, not the CLI). */
export const PLAN_STOP_CARD = {
  narrow: { label: 'Daralt', detail: 'Bu sınıfı taşıyan özelliği plandan çıkar, takip görevi aç. Kalan plan bir tur daha incelenir.' },
  split: { label: 'Böl', detail: 'Açık sınıfı taşıyan parçayı bu plandan kes ve bir takip görevine taşı (bulguları kriter olur). Bu plan onsuz yeniden yazılır ve bir kez daha incelenir.' },
  continue: { label: 'Devam', detail: 'Bu plan için tur sınırı kalkar. Bir sınıf yine tekrar ederse plan yine durur.' },
} as const;
