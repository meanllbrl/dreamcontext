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

/** goal-skill's PLANNING half. Ends by creating a real task and offering the handoff — the
 *  implementation runs in its own session so the plan transcript stays auditable. */
const PLAN_BRIEFING = `# Mode: Plan

You are planning, not building. Do not edit code in this session.

- **Ask first.** Put the critical questions to the user a few at a time and WAIT for answers.
  A plan built on guesses is the failure this mode exists to prevent.
- **Drive the open decisions.** Name the options, recommend one, say why. Don't hand back a
  menu.
- **Ground every step in the real code** — exact paths, functions, line anchors. "Update the
  relevant files" is not a plan.
- **Review your own plan** before presenting it: what is unverified, what could break, what
  you assumed.
- **End by creating a dreamcontext task** (\`dreamcontext tasks create …\`) carrying the plan
  and its testable acceptance criteria, then present that task document.
- **Shelve it the moment it exists** — emit \`\`\`dream-view {"type":"progress","task":"<the-slug>"}\`\`\`
  so the owner watches criteria land while you finish the doc.

Then offer the handoff. Implementation runs in a NEW session in Develop mode, carrying the
slug you just created:

\`\`\`dream-actions
[{"label": "Go to development", "action": "develop", "id": "<the-task-slug>"}]
\`\`\`
`;

/** goal-skill's IMPLEMENTING half. The worktree paragraph is appended by `modeBriefing`,
 *  because whether a worktree is safe here is a property of THIS project, not of the mode. */
const DEVELOP_BRIEFING = `# Mode: Develop

You are building to a task's acceptance criteria.

- **Put the run on the shelf FIRST** — before your first edit, right after you read the task:

\`\`\`dream-view
{"type":"progress","task":"<the-slug>"}
\`\`\`

  That pins a live percent above the composer for the whole session, read from the criteria
  you tick on disk. Ticking and logging IS the progress display — there is no second place to
  report it. When you start a dev server, pin its URL as a tag too:

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
`;

/** Appended to the develop brief when the project's dreamcontext brain is ISOLATED, so a
 *  second checkout cannot fork it. */
const WORKTREE_ALLOWED = `
This project's dreamcontext brain is isolated from the code checkout, so you MAY use a git
worktree to keep parallel work off the main tree. Say which worktree and branch you created.
`;

/** Appended otherwise. Stated as a prohibition, not as silence: an unmentioned capability is
 *  one the agent will reach for anyway. */
const WORKTREE_FORBIDDEN = `
Do NOT create a git worktree in this project. \`_dream_context/\` lives in the working tree,
so a second checkout would fork the brain. Work in the main checkout.
`;

/**
 * The system-prompt append for `mode`, or `''` for a mode that adds nothing.
 *
 * `basic` is plain Claude Code — the surface briefing and nothing else. `jarvis` also returns
 * `''`: it is unselectable in the UI and `sanitizeChatMode` coerces it away before it ever
 * reaches here, so this arm is defence in depth, not a feature.
 *
 * Pure — `worktreeAllowed` is passed in rather than resolved here, so this stays a
 * string-in/string-out function the tests can drive across every combination without a
 * filesystem. The caller reads it from `worktreeIsolationAllowed` (lib/worktree-gate.ts).
 */
export function modeBriefing(mode: ChatMode, opts: { worktreeAllowed: boolean }): string {
  switch (mode) {
    case 'plan':
      return PLAN_BRIEFING;
    case 'develop':
      return DEVELOP_BRIEFING + (opts.worktreeAllowed ? WORKTREE_ALLOWED : WORKTREE_FORBIDDEN);
    case 'basic':
    case 'jarvis':
      return '';
  }
}
