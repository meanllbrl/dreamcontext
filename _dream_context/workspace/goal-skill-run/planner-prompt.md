You are the goal-planner in a goal-skill v2 run for the dreamcontext repo (cwd is the repo root). Produce a rigorous, file-by-file implementation PLAN. You do NOT write code, do NOT edit files, do NOT create tasks — plan only. Ground every step in the real code: read the files, name exact paths, functions and line-level anchors. A step like "update the relevant files" is a rejection.

# The goal (two deliverables, strictly in this order)

**D1 — Composer redesign** (visual spec: `_dream_context/workspace/design-import/Composer.dc.html` + `composer.design.css`): rebuild the Chat composer's chrome in `dashboard/src/components/sleepy/chat/Composer.tsx` + `composer.css` to match the design — left mode trigger (mode name + permission), attach icon button, spacer, usage ring, combined model+effort trigger, circular send. Four popover menus: usage detail, model+effort (with effort slider and "Set as default"), mode+permission (NO set-default — owner delta), and NO skills menu (removed; placeholder hints "/" for skills instead).

**D2 — Pinned shelf** (visual spec: `_dream_context/workspace/design-import/ShelfUnit.dc.html`): the pin/progress surface docked to the composer's top edge. Behavioural spec of record: the acceptance criteria in `_dream_context/state/two-new-agent-actions-pinned-session-facts-that-stay-put-and-progress-read-from-the-task-file.md` (M1/M2/M2b/M3/cross-cutting) and the board `_dream_context/knowledge/diagrams/product/chat-pinned-surface/chat-pinned-surface.excalidraw.md`.

READ FIRST: `_dream_context/workspace/design-import/README.md` — it lists the owner deltas that OVERRIDE the design files (no set-default in mode menu; skills removed; modes are real behaviour; usage popover gains 5h-session + weekly limit bars with "show what's found, hide what isn't"; progress detail is the in-place variant, popover dropped; worktree facts per session).

# Mode semantics (owner's definition — plan the wiring, not just the menu)

- **Basic**: plain Claude Code. Only the existing `CHAT_SURFACE_BRIEFING` rides along.
- **Plan**: the agent behaves as goal-skill's planning half — asks the user the critical questions, drives decisions interactively, reviews them, and ENDS by creating a dreamcontext task and presenting the task doc. When the user says "go to development", the app opens a NEW chat session in Develop mode carrying the task slug (preloaded prompt via the existing promptToken mechanism) and closes the plan session. New-session-per-handoff is decided; do not plan an in-place /clear variant.
- **Develop**: the agent behaves as goal-skill's implement half — implements in waves, validates, shows evidence. It may use git worktrees ONLY when the brain is isolated: gate on `resolveMode(config) === 'full-repo'` (`src/lib/git-sync/brain-repo.ts:79-81`) or a linked-repo setup (`src/lib/linked-repos.ts`); never when `_dream_context/` lives in-tree.
- **J.A.R.V.I.S**: rendered disabled with badge "Soon". No behaviour.

Mode briefings should be delivered the same way `CHAT_SURFACE_BRIEFING` is: a per-mode system-prompt append file written at spawn (`src/server/routes/agent-chat.ts:361-449` builds the spawn; line ~416-428 writes the briefing temp file and passes `--append-system-prompt-file`). Mode must travel client→server like model/effort already do (WS URL params in `dashboard/src/components/sleepy/chatSession.ts:412-449`, sanitized in `src/server/routes/agent-spawn-shared.ts:79-88`, applied at agent-chat.ts:437-441). Decide and pin: where the selected mode persists (per-session in the tab roster + a default in `~/.dreamcontext/agent-ui.json` like `chatPermissionMode`, launcher.ts:868-910), and how the Plan→Develop handoff creates the new session (POST `/api/agent/prompt` → promptToken → WS upgrade with `sessionId=<fresh>&mode=develop`, then close the plan tab).

# Code map (verified by exploration 2026-08-23 — trust these anchors, verify details yourself)

- Composer: `dashboard/src/components/sleepy/chat/Composer.tsx` (862 ln) — card at ~545, handle 572-584, body 589-704 (auto-grow via `--chat-cmp-h`, `composerHeight.ts`), toolbar 706-858: PermissionModeMenu → Attach popover → Skills popover (733-748, to be REMOVED with `skillChip` state) → ContextReadout (~759) + cost → model/effort pills → send. Slash menu exists: `slashQueryAt` ~306, menu at 549-568 opens upward. Placeholders at ~640 ("Connecting…" / busy / "Message Claude…").
- Permission modes today: `PermissionModeMenu.tsx` — `['auto','bypass']`, persisted as `chatPermissionMode`.
- Context stats: `ContextReadout.tsx` + `useAgentSessionStats` polling `GET /api/agent/session-stats` (computed in `src/server/routes/agent-terminal.ts` from the session JSONL; `SessionStats = {contextTokens, contextLimit, costUsd}`). There is NO local source for 5h-session or weekly limits (settings.json, ~/.claude.json, transcript JSONL, routes all lack it). Plan the usage popover so absent limits render nothing; if you can identify a real, locally readable source (e.g. rate-limit fields Claude Code writes anywhere under ~/.claude), name it with evidence; otherwise ship context+cost only and note the extension point.
- dream-view pipeline: `dashboard/src/lib/chatViewSpec.ts` (VIEW_TYPES=['chart','page','checklist'], caps, degrade-loudly, max 4 blocks/message) → renderer `ChatViews.tsx`. Actions https-only guard: `chatActions.ts` (the localhost pin needs a loopback-only carve-out).
- Persistence precedent: `dashboard/src/lib/checklistStore.ts` — vault+id hex-keyed envelope in localStorage, debounced writes, TTL sweep. Pins must reuse this pattern (per-conversation, survive reload).
- Progress percent: MUST come from the existing acceptance-criteria checkbox counter in `src/lib/markdown.ts` (same number `tasks doctor` uses), served by a small server route reading the task file; refresh as the file changes; agent-supplied percent ignored with a notice; zero-criteria/unknown-slug/all-ticked degrade loudly.
- Briefing lockstep: `src/server/chat-surface.ts` `CHAT_SURFACE_BRIEFING` must teach pin+progress (and the weight request-not-command semantics); `tests/unit/chat-surface-lockstep.test.ts` pins briefing↔renderer; they ship in the same change.
- Session facts for the shelf: branch + worktree marker + dev-server port per session. NOTE: the old checkout backend (`src/lib/git-checkout.ts`, `agent-checkout.ts`) is LOST — it exists in no commit. Plan a fresh minimal backend: `git rev-parse --abbrev-ref HEAD`, worktree detection via `--git-common-dir` vs `--absolute-git-dir` (mainRoot = dirname(commonDir)), short memo cache, never throws, desktop-gated; exposed to the shelf (either a route the shelf polls or facts the agent pins — decide which and justify).
- Goal-skill live panel already reads `_dream_context/tmp/.goal-skill-live*.json` via `GET /api/agent/goal-live` (agent-terminal.ts:1453-1500) — the shelf coexists with it; do not break it.

# Constraints

- Validation method (Phase 6, already agreed with the owner): vitest unit tests + `scripts/verify/` HTTP scripts against the real server (pattern: existing `scripts/verify/dream-actions.mjs`) + a short manual visual checklist for the owner (four shelf states + composer menus, dark/light, 740px + 470px). Playwright/browser E2E is NOT available — do not plan it.
- `npm test` and the build must stay green; `chat-surface-lockstep.test.ts` green.
- D1 ships before D2 and must not regress existing composer behaviours: auto-grow height, drag handle, slash menu, attachments, queue/stop send states, history nav, container-query narrow degradation (labels→icons ≤470px).
- Do not overload the word "pinned" in code — `pinned` is control-bearing frontmatter on knowledge files. Use pin/shelf vocabulary.
- Load and honour the engineering skill conventions (`.claude/skills/engineering/`). Feature goals end with integration wiring: apply `_dream_context/knowledge/patterns/feature-integration-pattern.md` (skill docs, Entity Router, reference sections, sub-agent contracts) as the final wave.

# Required output (all five sections, in this order)

1. **File-by-file plan** — for each file: create/modify, what changes, exact function/section anchors, and the contract it exposes.
2. **Dependency map** — a table with EXACTLY these columns: `task | files owned | depends on | wave | contract`. Rules: same file → same lane (never two tasks touching one file in the same wave); pin exact TypeScript signatures for every cross-task interface; max 3 concurrent tasks per wave; D1 waves strictly before D2 waves.
3. **Acceptance criteria** — testable additions for D1 (the composer task `chat-density-shrink-chrome-…` will receive them) and any refinements to D2's existing criteria (do not weaken them).
4. **Assumptions & open questions** — anything you could not verify, with the file you looked in.
5. **Validation plan** — which unit tests, which verify scripts, and the manual checklist items, mapped to criteria.

Print the COMPLETE plan as your final message (it is parsed from your output). Be exhaustive in the plan, terse in prose.
