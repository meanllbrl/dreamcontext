/**
 * Chat MODES — the per-mode system-prompt append a chat-spawned `claude` gets on top of
 * `CHAT_SURFACE_BRIEFING` (chat-surface.ts).
 *
 * WHY this is separate from the surface briefing: they answer different questions.
 * `CHAT_SURFACE_BRIEFING` says what the SURFACE can draw ("a fenced dream-view block becomes
 * a chart") and is unconditional — every chat gets it. A mode brief says how the agent should
 * WORK, and the user picks it from the composer. Mixing them would mean either a mode's prose
 * riding along in every session that never selected it, or the surface's capabilities being
 * re-stated per mode.
 *
 * Both are written into ONE temp file and passed as ONE `--append-system-prompt-file` (see
 * agent-chat.ts's briefing block) — the CLI concatenates either way, and a second flag would
 * be a second argv element and a second cleanup path for no gain.
 *
 * Keep these SHORT. Like the surface briefing, they ride in the system prompt of every turn
 * of every session that selected them.
 *
 * MIRRORED in `dashboard/src/lib/chatModes.ts` (`ChatMode` + `CHAT_MODE_ROWS`). Change one,
 * change the other; `tests/unit/chat-mode-mirror.test.ts` pins the pair.
 */

/** Every mode the client may ask for. `jarvis` is rendered DISABLED in the composer (badge
 *  "Soon") and has no behaviour — it is listed here so the sanitizer's allowlist and the
 *  menu's rows come from one place, not so it can be selected. */
export const CHAT_MODES = ['basic', 'plan', 'develop', 'jarvis'] as const;
export type ChatMode = typeof CHAT_MODES[number];

/** What a chat is in when nothing asked for anything else. There is deliberately NO
 *  user-settable mode default (the mode menu has no "Set as default" — owner call): a fresh
 *  chat is plain Claude Code, and a mode is a per-session choice. */
export const DEFAULT_CHAT_MODE: ChatMode = 'basic';

/**
 * goal-skill's PLANNING half — Phases 0-3, compressed. Ends by creating a real task and
 * offering the handoff, so implementation runs in its own session and the plan transcript
 * stays auditable.
 *
 * ── Step 4 is a REVERSAL, and it is the point of this briefing ────────────────────────
 * Step 4 used to read "Review your own plan before presenting it: what is unverified, what
 * could break, what you assumed" — goal-skill's Phase 2 collapsed into self-review by the
 * agent that just wrote the plan. That is precisely the anchoring failure
 * `knowledge/patterns/three-reviewer-parallel-mandates-pattern.md` documents: a reviewer's
 * mandate biases what it sees, and an author reviewing its own plan has the most biased
 * mandate of all. Reported by the owner 2026-09-02 as "plan mode does not do goal-skill's
 * plan review iteration — it just plans and that's it". The lenses are now CLEAN sub-agents
 * fed only the plan text, and step 5 restores goal-skill's convergence-by-signal loop:
 * revise on new findings, escalate when the same finding survives a revision.
 *
 * Unlike goal-skill there is deliberately NO tier router — every plan gets reviewed (owner
 * call, 2026-09-02). A chat plan has no orchestrator standing outside it to judge the tier,
 * and the failure this mode exists to prevent is an unreviewed plan, not an over-reviewed one.
 *
 * The dispatch depends on `SUBAGENT_DISPATCH_AUTHORIZATION` (cli/commands/hook.ts) naming
 * this mode: Claude Code appends "Do not call the AgentTool unless the user requested it" to
 * every Opus 5 system prompt, and that outranks a system-prompt append like this one. Without
 * the hook line the lenses silently run INLINE — i.e. self-review again, the exact bug.
 */
const PLAN_BRIEFING = `# Mode: Plan

You are planning, not building. Do not edit code in this session.

1. **Ask first.** Critical questions a few at a time, then WAIT — including **how this should
   be validated** (tests, or a manual checklist). A plan built on guesses is the failure this
   mode exists to prevent.
2. **Drive the open decisions.** Name the options, recommend one, say why. Don't hand back a
   menu.
3. **Draft against the real code** — exact paths, functions, line anchors. "Update the
   relevant files" is not a plan.
4. **Then have it attacked. Every plan, no exceptions — never review your own.** Dispatch
   \`goal-plan-reviewer\` sub-agents IN PARALLEL in ONE message, each fed only the plan text:
   **critic** (premise, assumptions, correctness), **pragmatist** (scope, YAGNI),
   **edge-cases** (empty/null, concurrency, partial failure, retries, rollback) — plus
   **security** when the goal touches auth, crypto, secrets or migrations. Show the user every
   verdict and its blocking findings. No \`goal-plan-reviewer\` in this project? Use
   general-purpose agents with the same mandates — the lenses are the contract, not the
   agent name.
5. **Iterate until every lens says SOLID.** New blocking findings → revise and re-review. The
   SAME finding twice → STOP and put it to the user; never quietly proceed past it.
6. **End by creating the task** — the reviewed plan's only durable home:

\`\`\`
dreamcontext tasks create "<sentence-style goal>" -p <priority> -w "<why>"
dreamcontext tasks insert <slug> acceptance_criteria "<one testable criterion>"
dreamcontext tasks insert <slug> acceptance_criteria "Validation method: <the user's choice>"
dreamcontext tasks insert <slug> technical_details "<the file-by-file plan>"
dreamcontext tasks insert <slug> constraints "<decisions taken, what is out of scope>"
\`\`\`

   Present it, and shelve it the moment it exists — emit
   \`\`\`dream-view {"type":"progress","task":"<the-slug>"}\`\`\` so the owner watches criteria land.

Then offer the handoff. Implementation runs in a NEW session in Develop mode, carrying the
slug you just created:

\`\`\`dream-actions
[{"label": "Go to development", "action": "develop", "id": "<the-task-slug>"}]
\`\`\`
`;

/**
 * goal-skill's IMPLEMENTING half — Phases 4-6. The worktree paragraph is appended by
 * `modeBriefing`, because whether a worktree is safe here is a property of THIS project, not
 * of the mode.
 *
 * ── The last two bullets are the 2026-09-02 addition ──────────────────────────────────
 * This briefing used to stop at "don't expand scope": the agent implemented in waves, gated
 * each wave on build+test, ticked its own criteria and declared itself done. Every judgement
 * in that loop belonged to the author — the same self-review failure the Plan briefing had,
 * one phase later and more expensive, because by then the code exists. goal-skill never
 * worked that way: Phase 5 is a CLEAN `reviewer` reading the diff it fetched itself, and
 * Phase 6 is validation by the method the USER agreed to, evidenced by real command output.
 * Both are now here, with the same convergence-by-signal rule the Plan briefing uses — fix
 * new findings, escalate a finding that survives a fix.
 *
 * Review runs ONCE, after the last wave, not per wave (goal-skill Phase 5): the per-wave
 * gate is build+test, and a full review of a half-built wave reports on code the next wave
 * is about to change.
 *
 * Like Plan, the dispatch depends on `SUBAGENT_DISPATCH_AUTHORIZATION` (cli/commands/hook.ts)
 * naming this mode — without it the injected Opus 5 line collapses the review inline, which
 * is the author reviewing itself again.
 */
const DEVELOP_BRIEFING = `# Mode: Develop

You are building to a task's acceptance criteria.

- **Put the run on the shelf FIRST** — before your first edit, right after you read the task:

\`\`\`dream-view
{"type":"progress","task":"<the-slug>"}
\`\`\`

  That pins a live percent above the composer for the whole session, read from the criteria
  you tick on disk — ticking and logging IS the progress display, there is no second place
  to report it. Starting a dev server? Pin its URL as a tag too:

\`\`\`dream-view
{"type":"pin","id":"dev","weight":"tag","facts":[{"label":":PORT","url":"http://localhost:PORT"}]}
\`\`\`

- **Work in waves.** Independent work in parallel; a dependent step never before the thing it
  depends on.
- **Validate each wave before starting the next, and SHOW the evidence** — the command you
  ran and its real output, not a claim that it passed.
- **Tick a criterion only when it is demonstrably true.** Log progress with
  \`dreamcontext tasks log <slug> "…"\`.
- **Don't expand scope.** If the plan turns out to be wrong, STOP and say so rather than
  silently redesigning it.
- **Then have it reviewed — you do not sign off on your own work.** After the LAST wave (the
  per-wave gates stay build+test only), dispatch ONE clean \`reviewer\` sub-agent. Give it the
  base ref and let it run \`git diff\` ITSELF; never paste a diff into its prompt. No \`reviewer\`
  here? A general-purpose agent with the same mandate and base ref. New findings → fix exactly those, then re-review. The SAME finding twice → STOP and put
  it to the user; never merge past it.
- **Then validate — clean too, and by the method the TASK names.** Dispatch ONE \`goal-validator\`
  (or a general-purpose agent with that mandate) with the slug and its \`Validation method:\`
  criterion. IT runs the check and reports PASS/FAIL with the exact
  command and output — you do not certify your own build. Flaky, skipped or "should pass" is a
  FAIL: fix and re-validate. On PASS close it — \`dreamcontext tasks status <slug> completed
  "<what shipped + the evidence>"\` — or leave it \`in_review\` when a human should still
  eyeball something.
`;

/**
 * The sentence both arms end with.
 *
 * ── What this used to say, and why it stopped ─────────────────────────────────────────
 * It used to end "say so, and pin the checkout as a tag", because the server followed only the
 * harness's `EnterWorktree`/`ExitWorktree` frames and a manual `git worktree add` + `cd` left
 * the tag reporting the checkout the session STARTED in (photographed 2026-08-24). Asking the
 * agent to paper over that produced the NEXT defect, photographed 2026-08-25: three chips
 * reading `main` + `wt: eur-multicurrency` + `branch: feat/eur-multicurrency` — one branch
 * stated twice, and the server's copy of it wrong.
 *
 * The server now reads the checkout from the conversation's own transcript
 * (src/lib/session-transcript-cwd.ts), which the CLI rewrites on every entry, so EVERY move is
 * followed — the tool, a manual one, and a plain `git checkout -b`. There is nothing left for
 * the agent to declare, and `layoutShelf` drops a pin that restates the chip anyway. So the
 * paragraph keeps only the half that is still true: prefer the tool, because it is the move the
 * shelf can attribute instantly rather than on the next transcript flush.
 *
 * Appended to the FORBIDDEN arm too, deliberately. That arm forbids CREATING a worktree; it
 * does not stop a session being driven from one that already exists.
 */
const WORKTREE_DECLARE = `Moving checkout? Prefer the EnterWorktree tool. The shelf reads the
checkout from the transcript, so it follows any move — do not pin the branch or worktree
yourself; a pin restating it is dropped.`;

/** Appended when the project's dreamcontext brain is ISOLATED, so a second checkout cannot
 *  fork it. */
const WORKTREE_ALLOWED = `
This project's dreamcontext brain is isolated from the code checkout, so you MAY use a git
worktree to keep parallel work off the main tree. Say which worktree and branch you created.
${WORKTREE_DECLARE}
`;

/** Appended otherwise. Stated as a prohibition, not as silence: an unmentioned capability is
 *  one the agent will reach for anyway. */
const WORKTREE_FORBIDDEN = `
Do NOT create a git worktree in this project. \`_dream_context/\` lives in the working tree,
so a second checkout would fork the brain. Work in the main checkout.
${WORKTREE_DECLARE}
`;

/**
 * The system-prompt append for `mode`, or `''` for a mode that adds nothing.
 *
 * ── `basic` is no longer empty, and that is a REVERSAL ────────────────────────────────
 * It used to return `''` — "plain Claude Code, the surface briefing and nothing else" — with
 * the worktree paragraph appended only in `develop`. That put the one paragraph standing
 * between an agent and a FORKED BRAIN in the mode the fewest sessions run: `basic` is
 * `DEFAULT_CHAT_MODE`, a fresh chat is in it, and it carries exactly the same tools as
 * develop. The prohibition was guarding the door nobody uses. `basic` now gets the worktree
 * paragraph and nothing else, so the mode is still plain Claude Code in BEHAVIOUR, plus the
 * one rule that protects the brain from it.
 *
 * `plan` is deliberately excluded: it opens with "Do not edit code in this session", so a
 * worktree rule there is prose that rides every turn of every planning session to say
 * nothing. `jarvis` still returns `''` — it is unselectable in the UI and `sanitizeChatMode`
 * coerces it away before it ever reaches here, so that arm is defence in depth, not a feature.
 *
 * Pure — `worktreeAllowed` is passed in rather than resolved here, so this stays a
 * string-in/string-out function the tests can drive across every combination without a
 * filesystem. The caller reads it from `worktreeIsolationAllowed` (lib/worktree-gate.ts).
 */
export function modeBriefing(mode: ChatMode, opts: { worktreeAllowed: boolean }): string {
  // ONE constant for both modes that get it — two copies would be two things to keep in step.
  const worktree = opts.worktreeAllowed ? WORKTREE_ALLOWED : WORKTREE_FORBIDDEN;
  switch (mode) {
    case 'plan':
      return PLAN_BRIEFING;
    case 'develop':
      return DEVELOP_BRIEFING + worktree;
    case 'basic':
      return worktree;
    case 'jarvis':
      return '';
  }
}
