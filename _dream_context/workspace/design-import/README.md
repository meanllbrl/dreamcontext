# Design import — Composer redesign + Pinned Shelf

Imported 2026-08-23 from claude.ai/design project `33bd5c25-2e6d-42d5-b5e4-d9c8ccce7488`
(files decoded verbatim from the MCP read; etags at import: Composer.dc.html
`1787415002508523`, ShelfUnit.dc.html `1787496269326765`, composer.css `1787496441490713`).

**These files are the visual spec for the 0.25.0 chat work.** Spec of record for shelf
BEHAVIOUR stays the task + board:
- `_dream_context/state/two-new-agent-actions-pinned-session-facts-that-stay-put-and-progress-read-from-the-task-file.md`
- `_dream_context/knowledge/diagrams/product/chat-pinned-surface/chat-pinned-surface.excalidraw.md`

## Files

| File | What it is |
|---|---|
| `Composer.dc.html` | Deliverable 1 — the redesigned composer: mode trigger (left), attach, usage ring, model+effort trigger, send. Plus the four popover menus (usage / model+effort / mode+permission / skills). |
| `ShelfUnit.dc.html` | Deliverable 2 — the pinned shelf component: tag line, progress row, lede/long pin, overflow fold, demote chip, in-place + popover progress detail, and a static composer replica showing the docking seam. |
| `composer.design.css` | The complete stylesheet for both, incl. theme tokens for dark/light. Classes prefixed `chat-cmp-` (composer) and `pin-` (shelf). |

NOT imported: `support.js` (the design tool's preview runtime — DCLogic shim, not product
code), `Composer.tsx` (design's copy of the repo file), `uploads/` (reference screenshots),
`.thumbnail`. The `sc-if`/`sc-for`/`{{ }}` syntax in the .dc.html files is the design
tool's template language — translate to React/TSX; the embedded `Component` class shows
the intended state machine.

## The states doc (`Pinned Shelf.dc.html`, distilled — it only composes ShelfUnit)

It renders ShelfUnit in a matrix: modes `rest / active / lede / open / overflow / demote /
authored` × themes dark/light × widths 740px and 470px (narrow), plus two full 1440×900
in-context frames, plus `progress-open` in both `detail="inplace"` and `detail="popover"`
variants. Its annotations, which are design intent:

- **Anchored below**: rows mount at the TOP of the shell; the tag line and composer keep
  their pixel position through every state.
- **One object, not a card**: the shell borrows the composer's width/border/12px corners;
  the composer's top corners square off (`.pin-composer.is-shelved`) and the seam becomes
  the pane's drag handle.
- **Accent spent once**: only the port chip, the progress fill and the open caret carry
  the accent. Everything else is border, chip and text.
- **Clamp honesty**: a surface-clamped lede shows the `…` chip (`pin-clamp`) + the `⌄`
  open hint; an author-written lede shows only `⌄`. The `…` means "the shelf cut this
  line"; the `⌄` means "there is more behind it" and appears on every long pin.
- **Demote**: when a third row would arrive, the oldest pin demotes to a tag chip carrying
  `⌃` ("it demoted, it did not close"); clicking promotes it back and demotes whatever is
  oldest then.
- **Overflow**: tags past the line's width fold into `+3` / `−3`; the fold opens as a row
  ABOVE (upward, as always). Folded tags never disappear — the count is the affordance.
- **Narrow (470px)**: the `worktree` marker text drops to its bracket glyph; paddings
  tighten (`is-narrow`).
- **Progress detail**: opens INSIDE the shelf, capped near 40% of the pane
  (`max-height: 34vh`), scrolling within itself; the row keeps its track and percentage
  while open. The doc also drew a popover variant and said "pick one, and the other can
  go" — see owner deltas below.

## OWNER DELTAS — these override what the design files show

1. **Mode menu has NO "Set as default"** — remove the `saveModeDefault` footer from the
   mode/permission menu. The model+effort menu KEEPS its "Set as default" footer (owner:
   "set default kısmını kullanma [mode'da] ancak model ve efor seçimi kısmında bunu
   mutlaka göster").
2. **Skills section is REMOVED.** The skillmenu markup in Composer.dc.html is vestigial
   (no toolbar trigger references it) — do not build it. Instead the input placeholder
   hints the slash path, e.g. `Message Claude…  ·  "/" for skills` (exact copy up to the
   implementer; the "/" slash menu already exists in `Composer.tsx`).
3. **Modes are real behaviour, not labels:**
   - **Basic** — plain Claude Code. No extra briefing beyond `CHAT_SURFACE_BRIEFING`.
   - **Plan** — goal-skill's PLANNING half: asks the user lots of questions, drives the
     critical decisions interactively, reviews them, plans all phases, ends by creating a
     dreamcontext TASK and presenting the task doc. When the user says "go to
     development": open a NEW session in Develop mode carrying the task slug, and close
     the plan session (owner chose new-session-per-mode over in-place /clear; the plan
     transcript stays auditable).
   - **Develop** — goal-skill's IMPLEMENT half: waves, validation, evidence
     (screenshots/proof) as it goes. May use git worktrees ONLY when the dreamcontext
     brain is isolated (`resolveMode(config) === 'full-repo'` in
     `src/lib/git-sync/brain-repo.ts`) or the repo is linked; never when the brain lives
     in-tree.
   - **J.A.R.V.I.S** — disabled, badge "Soon".
4. **Usage popover gains session + weekly limits**: three nested bars/rings (Apple Health
   style) — context window, 5-hour session limit, weekly limit. Rule: **show what's
   found, hide what isn't** — a limit with no locally readable data source renders
   nothing (no empty ring). As of 2026-08-23 exploration found NO local source for the
   5h/weekly numbers (settings/transcripts/routes all lack it); ship context-only unless
   the planner finds one.
5. **Progress detail: the IN-PLACE variant is chosen**; the popover variant
   (`.pin-pop`, `detail="popover"`) is dropped. This matches the task's M2b/M3 criteria
   (grows upward, ~40% cap, scrolls inside, tag line and composer never move).
6. **When a session runs in a worktree**, the shelf's session facts must express: branch,
   worktree marker, and the active dev-server port — per session.

## Integration notes for the planner

- The design's theme tokens (`--color-*`) are self-contained in `composer.design.css`;
  the repo has its own `dashboard/src/styles/tokens.css`. Map, don't duplicate: prefer
  the repo's existing variables where values coincide; add missing ones scoped to the
  chat surface.
- Popovers are `position: absolute` anchored to `.chat-cmp` (NOT the card — the card is
  `overflow: hidden`), opening upward via `bottom: calc(100% - 4px)`.
- The composer card radius in this design is 14px (matches the repo's current
  `--radius-lg` usage in `composer.css`); the shelf's shell uses 12px top corners.
- The real `Composer.tsx` (862 ln) already owns: auto-grow height (`--chat-cmp-h`),
  drag handle, slash menu, attachments, queue/stop send states, history nav. The
  redesign REPLACES chrome (toolbar controls, menus), not those behaviours.
