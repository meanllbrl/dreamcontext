/**
 * The brief every headless builder gets, printed by `dreamcontext goal-live recipe
 * builder-brief` and shared with Develop's own builder brief (develop-recipe.ts).
 *
 * A `claude -p` builder forked by goal-skill never loads the goal-implementer agent file: the
 * prompt it is forked with is everything it sees. So the check rules live HERE, printed from
 * the same install the orchestrator runs, and the orchestrator passes the filled-in text as a
 * file (`"$(cat …)"`) instead of retyping it. A retyped brief is how the 2026-10-04 builders
 * got a scoped-check rule and still ran the full suite.
 *
 * tests/unit/goal-builder-discipline.test.ts pins the load-bearing lines.
 */

/** How a builder runs its checks. Shared by goal-skill's brief and Develop's. */
export const BUILDER_CHECK_RULES = `How you run checks. This session ends the moment your turn ends, so nothing you put in the
background ever reports back:
1. Foreground only. Every check runs in the foreground with an explicit timeout under
   600000 ms. Never background one: no run_in_background, no &, no nohup, no Monitor wait.
   One check per Bash call: never chain two type-checks, or a type-check and a test run.
2. Never end your turn while a check is still running. A final message like "waiting for X"
   is a failed run. If a tool result says a command "was moved to the background", poll its
   output file with short foreground calls (sleep 30; tail -5 <file>) until it shows the
   result. A check that times out gets a narrower scope, never the background.
3. Only your lane's checks: the test files you wrote or changed, the existing tests of the
   modules you touched, and the type-check of each package you touched. Never the full
   suite, a build, integration tests that need compiled output, or a generator script: the
   orchestrator runs those once, at the final gate.
4. Run every type-check and test run through the repo's heavy lock, with at most 2 test
   workers: \`dreamcontext builder heavy -- <command>\` (e.g. \`dreamcontext builder heavy --
   npx vitest run --maxWorkers=2 <files>\`). It runs one heavy check at a time across every
   builder of this repo. Exit 75 means the lock stayed busy and NOTHING ran: run it again.`;

/** goal-skill's builder brief. The orchestrator fills the <placeholders> and writes it to a file. */
export const BUILDER_BRIEF = `# Builder brief (goal-skill implementer)

Fill every <placeholder>, write the result to $RUN/brief-<TaskId>.md, and fork the builder
with "$(cat "$RUN/brief-<TaskId>.md")" as its prompt. Never retype these rules.

---

You are implementer <TaskId> for task <slug>. You are NO LONGER the planner. Read
_dream_context/state/<slug>.md. Build only <files owned>, against the pinned contracts in its
dependency map. Never touch another lane's file, never call dreamcontext goal-live, never edit
the task's dependency map or session registry. If the plan is wrong or impossible, STOP and
report instead of redesigning.

Your checks: <type-check command for each package you will touch>; <test command> on the test
files you write or change and the existing tests of the modules you touch.

${BUILDER_CHECK_RULES}

Your final message starts with the exact heading \`## <TaskId> report\`, then: files changed
(one line each), each check you ran with its real result, the criteria met, anything not done
and why. A final message without that heading is treated as unfinished and resumed.
`;
