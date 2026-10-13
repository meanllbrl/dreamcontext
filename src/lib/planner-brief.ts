/**
 * What a plan must say about the result its owner will OPEN, and the brief every headless
 * goal-skill planner gets, printed by `dreamcontext goal-live recipe planner-brief`.
 *
 * Paid for on 2026-10-13: a goal-skill run turned a mobile app into a web app, every judge
 * passed it, and the owner opened it to console errors and a PWA that was not responsive at
 * all. Nobody had written "responsive" down. The goal sentence never said it, so the planner
 * left it out, the critic checked the criteria it was given for testability (not for what
 * was missing), and the reviewer judged the diff against those criteria. And a `claude -p`
 * planner never loads the goal-planner agent file: the orchestrator retyped a brief by hand,
 * so the agent file's mandate never reached it at all.
 *
 * So the rule lives HERE, once: USER_FACING_PLAN_RULES is printed inside PLANNER_BRIEF, copied
 * verbatim into skill-packs/agents/goal-planner.md (an agent file cannot import it; the drift
 * test in tests/unit/goal-builder-discipline.test.ts holds them equal), and condensed into Plan
 * mode's briefing. It costs nothing at run time: it changes what the plan asks for.
 */

export const USER_FACING_PLAN_RULES = `## What the owner expects without saying it

A goal sentence names the change, not everything its owner will check. Before you write the
criteria, ask: **what will the owner notice in the first 30 seconds of opening the result?**
Each answer is an acceptance criterion, as plain as the stated ones. By the goal's type:

- **A port or rewrite** (mobile to web, one framework to another): every screen and flow of
  the source exists; on the web it is responsive at a phone (390 px) and a desktop (1440 px)
  width; a PWA installs and launches.
- **A new screen, page or app:** it opens with no console errors, no failed requests and no
  horizontal overflow, at a phone and a desktop width.
- **A change to an existing screen:** the screens it touches still render and work.

**A goal the owner opens ends on an OBSERVED criterion:** open it in the real app or a
headless browser at a phone and a desktop width, no console errors, a screenshot of each.
It is the last line of the test plan. Green unit tests on an app that does not open are not
evidence that the goal was reached.

**A goal with UI loads the \`design\` skill** (responsive layout, touch targets,
accessibility; its design-web or design-mobile part) next to \`engineering\`, before planning.`;

/** goal-skill's planner brief. The orchestrator fills the <placeholders> and writes it to a file. */
export const PLANNER_BRIEF = `# Planner brief (goal-skill planner)

Fill every <placeholder>, write the result to $RUN/planner-brief.md, and spawn the planner
with "$(cat "$RUN/planner-brief.md")" as its prompt. A \`claude -p\` planner never loads the
goal-planner agent file: this brief is all it sees. Never retype these rules.

---

You are the goal-planner for task <slug> in <repo path>. Read-only: you plan; you do not
write code or the task doc. Load the \`engineering\` skill<, the \`design\` skill when the goal
has UI><, and the domain skills: …>, and read <patterns and files> before planning.

# Goal

<the confirmed goal, the owner's decisions, the agreed Validation method>

# Your mandate

Produce a plan an enthusiastic mid-level engineer could execute without guessing:
- Ground every claim in the files you read: \`file_path:line\` for each integration point.
- File-by-file steps: which files to CREATE and which to EDIT, and what changes in each.
- Testable acceptance criteria, one line each, the Validation method line among them, and a
  test plan.
- Assumptions stated, open questions listed instead of guessed past, out of scope named.

"Update the relevant files", "handle errors appropriately" or "add tests" without specifics
is rejected.

${USER_FACING_PLAN_RULES}

# Output

Overview, file-by-file steps, acceptance criteria, test plan, risks and open questions, out
of scope. For an M or L goal, a dependency-map table \`task | files owned | depends on | wave
| contract\` that opens with \`EXECUTION: lead\` (the default: one builder builds the waves in
order) or \`EXECUTION: fan-out: <why>\` (only for work one session cannot hold). Same file =
same lane; pin the exact signature of every cross-task contract; as few waves as the
dependencies allow.`;
