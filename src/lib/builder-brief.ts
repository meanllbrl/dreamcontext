/**
 * The brief every headless goal-skill builder gets, printed by `dreamcontext goal-live recipe
 * builder-brief`. Develop's fan-out builders get the same {@link NO_CHECK_BUILDER_RULES} inside
 * their own brief (develop-recipe.ts).
 *
 * A `claude -p` builder forked by goal-skill never loads the goal-implementer agent file: the
 * prompt it is forked with is everything it sees. So the builder rules live HERE, printed from
 * the same install the orchestrator runs, and the orchestrator passes the filled-in text as a
 * file (`"$(cat …)"`) instead of retyping it. A retyped brief is how the 2026-10-04 builders
 * got a scoped-check rule and still ran the full suite.
 *
 * tests/unit/goal-builder-discipline.test.ts pins the load-bearing lines.
 */

/**
 * How every builder treats checks, in Develop's fan-out and in goal-skill alike: it writes its
 * tests and runs none of them. Whoever started it (the Develop lead or the goal-skill
 * orchestrator) runs one type-check + related-tests pass per wave (`dreamcontext builder test`)
 * and resumes the owning builder with exactly the failures. Measured 2026-10-11: checks were
 * 40% of a builder's active time (median 19 runs, p90 129, all through one repo-wide lock), and
 * a builder that never type-checks costs one resume at most. The hand-run, heavy-locked lane
 * checks goal-skill used before (BUILDER_CHECK_RULES) are retired with that evening's alignment.
 */
export const NO_CHECK_BUILDER_RULES = `Checks are not yours. Write the tests for the code you write, in the files you own, and run
none of them: no test runner, no type-check, no build, no dev server. The lead or orchestrator
that started you runs one type-check and test pass for the whole wave and resumes you with
exactly what failed, if anything did. Never put anything in the background (no
run_in_background, no &, no nohup) and never end your turn "waiting" for something: this
session ends with your turn. Something broken or missing outside your files is reported,
never fixed.`;

/** goal-skill's builder brief. The orchestrator fills the <placeholders> and writes it to a file. */
export const BUILDER_BRIEF = `# Builder brief (goal-skill implementer)

Fill every <placeholder>, write the result to $RUN/brief-<TaskId>.md, and fork the builder
with "$(cat "$RUN/brief-<TaskId>.md")" as its prompt. Never retype these rules.

---

You are implementer <TaskId> for task <slug>. You are NO LONGER the planner. Read
_dream_context/state/<slug>.md. Build only <files owned: your lane's files, or in an EXECUTION:
lead run the files of the wave you are given>, against the pinned contracts in its dependency
map. Never touch another lane's file, never call dreamcontext goal-live, never edit the task's
dependency map or session registry. If the plan is wrong or impossible, STOP and report
instead of redesigning. In an EXECUTION: lead run you build every wave in turn: you are resumed
with the next wave once this one's check is green.

${NO_CHECK_BUILDER_RULES}

Your final message starts with the exact heading \`## <TaskId> report\`, then: files changed
(one line each), the tests you wrote, the criteria met, anything not done and why. A final
message without that heading is treated as unfinished and resumed.
`;
