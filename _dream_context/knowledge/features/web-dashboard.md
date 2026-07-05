---
id: feat_O7LODr7O
status: active
created: '2026-02-25'
updated: '2026-07-04'
released_version: 0.1.0
tags:
  - frontend
  - architecture
  - design
related_tasks:
  - web-dashboard
  - v06-control-panel-frontend
  - v06-control-plane-backend
  - landing-page-v2
  - dashboard-alignment
  - data-structures-to-knowledge
  - knowledge-diagram-nesting
  - >-
    feat-dashboard-sprint-aware-version-filter-current-completed-actions-status-sort
  - >-
    feat-dashboard-redesign-tasks-board-saved-views-with-shared-local-persistence
  - dashboard-version-rename-and-delete-controls
  - board-version-filter-smart-buckets
  - multi-assignee-via-person-tags
type: feature
name: web-dashboard
description: ''
pinned: false
date: '2026-02-25'
---

## Why

Users need a visual interface to manage agent context without using the terminal. The dashboard provides a Kanban task board, sleep state tracking, core file editing, knowledge management, and feature viewing, all through a premium Notion/Linear-inspired web UI. Every manual change is tracked in the sleep file so the agent learns what the user did between sessions.

## User Stories

- [x] As a user, I want to run `dreamcontext dashboard` and have a web UI open in my browser so that I can manage my project context visually
- [x] As a user, I want to see a Kanban board of my tasks so that I can track work status at a glance
- [x] As a user, I want to drag tasks between columns (todo, in_progress, completed) so that I can update status without typing commands
- [x] As a user, I want to filter tasks by status, priority, urgency, tags, version, text search, and date range so that I can find specific tasks quickly
- [x] As a user, I want to group tasks by status, priority, urgency, version, or tags so that I can organize the board to my preference
- [x] As a user, I want to switch between Kanban, Eisenhower Matrix, RICE scatter, list, Timeline (Gantt), Calendar, and Activity Heatmap views so that I can see tasks by status, prioritization, and time
- [x] As a user, I want time-axis views (timeline/calendar/heatmap) so that I can plan when work lands and see load/completions over time
- [x] As a user, I want to create new tasks from the dashboard with name, description, priority, urgency, version, and tags so that I can add work without the CLI
- [x] As a user, I want to update task fields (status, priority, description) and add changelog entries from a detail panel so that I can keep tasks current
- [x] As a user, I want to see the agent character in the top-left corner showing sleep state (alert, drowsy, sleepy, must sleep) so that I know when consolidation is needed
- [ ] As a user, I want a dedicated sleep page showing debt level, session history, and dashboard changes so that I can track sleep cycles in a beautiful UI
- [ ] As a user, I want to read and edit core files (soul, user, memory, style guide, tech stack) with a markdown editor and live preview so that I can update project identity
- [ ] As a user, I want to browse, search, and view knowledge files so that I can find stored knowledge quickly
- [ ] As a user, I want to pin and unpin knowledge files from the dashboard so that important knowledge appears in the snapshot
- [x] As a user, I want to view feature PRDs with all their sections (Why, User Stories, Acceptance Criteria, etc.) so that I can review feature specs
- [x] As a user, I want to manage planning versions alongside released versions in a Version Manager so that I can track what's coming next
- [x] As a user, I want to promote a planning version to released from the Version Manager so that I can track release milestones
- [x] As a user, I can rename a version from the Versions popover (registered or ghost) so that I can normalize naming inconsistencies without CLI file edits; all tasks re-point automatically and the active-sprint pointer follows.
- [x] As a user, I can delete a registered version from the Versions popover with a confirmation dialog that warns how many tasks will be cleared (warn-and-clear policy: tasks kept, version field nulled), so I can clean up stale releases without orphaning tasks.
- [ ] As a user, I want all manual changes I make in the dashboard to be recorded in the sleep file so that the agent consolidates them during the next sleep cycle
- [ ] As a user, I want light and dark mode (with system preference detection) so that the UI matches my OS settings
- [ ] As a user, I want multi-language support (English initially, i18n-ready) so that the dashboard can be localized in the future
- [x] As a user, I want to toggle the Brain graph to a 3D rendering mode so that I can perceive relationship depth and cluster density that 2D layouts obscure when nodes overlap
- [x] As a user, I want a Settings page to view and edit my project's platforms and packs so that I can configure dreamcontext without using the CLI.
- [x] As a user, I want a Packs page to browse available skill packs and see which are installed.
- [x] As a user, I want an in-app update badge that tells me when a newer dreamcontext version is available, and lets me run the full upgrade (CLI + desktop app + every registered project) with one click from the badge itself, so I never have to open a terminal to run `dreamcontext upgrade`.
- [x] As a user, after a one-click upgrade finishes I can relaunch the app directly from the badge so the new version takes effect without me manually quitting and reopening.
- [x] As a user, I can see registered vaults (read-only) from the Settings page so that I know which projects are tracked.
- [x] As a user, I see a "What is this?" section at the bottom of the sidebar that opens a full-page marketing/explainer landing page with a real system diagram, sleep walkthrough, recall flow, cinematic architecture view, live skill-packs marquee, and collapsible features showcase.
- [x] As a user, the landing page hero shows the logo+wordmark and a looping brain-graph video so I immediately understand what dreamcontext is.
- [x] As a user, the dashboard's responsive layout doesn't clip or misalign at tablet/narrow widths (768px) because the sidebar collapses and pages use flexible spacing.
- [x] As a user, the "What is this?" sidebar entry bounces and glows until I open it once (then remembers via localStorage and stops) so I never miss the landing page on first run.
- [x] As a user, the landing page hero headline reads "The persistent brain for AI natives" with a "Works with Claude Code" credibility pill so I immediately understand the audience.
- [x] As a user, the "One brain, many faculties" features showcase is a pinned scroll-scrubbed spotlight: the header+stage stay sticky while a tall track scrolls past; scroll progress continuously crossfades faculty panels (opacity+translateY on refs, zero React renders per frame); snap-to-nearest settles any intermediate frame on scroll idle.
- [x] As a user, the goal-skill orchestration is a flagship spotlight faculty with its own landscape loop diagram so I understand how planning-review-implementation-validation works end-to-end.
- [x] As a user, flow animations in diagrams are compositor-smooth (CSS Motion Path dots riding offset-path/offset-distance rather than stroke-dashoffset), so 27 simultaneous dots cause 0 jank frames.

- [x] As a user, the task board's version filter is sprint-aware: it shows the current sprint with a star badge and a "Current" quick-pick, distinguishes planning / unregistered / released sprints with status icons, sorts active sprints first and collapses released ones, and lets me set a sprint as current or mark it complete directly from the dropdown, so I can manage sprint focus from the board without using the CLI.
- [x] As a user, I can enter my ClickUp or GitHub API token directly in the Settings page cloud provider panel (never stored in `.config.json`, always written to the gitignored `.secrets.json`) so I don't need to use the CLI to authenticate.
- [x] As a user, I can preview what `tasks provision` would create (dry-run) before committing, so I can see exactly which remote fields / labels will be provisioned without side effects.
- [x] As a user, the Settings page has a left-rail section-nav (Platforms / Cloud Tasks / Task Format / Memory / Connections / Sleepy) so I can jump to any settings section without scrolling, with Task Format appearing above Sleepy, a BETA badge, and a "How the format works" documentation link.
- [x] As a user, I can view and edit the project's task format override (`overrides/task.md`) from the Settings page, including the full markdown body (displayed read-only) and any declared custom field definitions, so I can manage the project's task schema from the dashboard.
- [x] As a user, I can add, edit, and remove custom field definitions (name, key, type, options, sync target, agent prompt, required flag, ask flag) from the Settings page without manually editing YAML; the AddCustomFieldForm includes a Required toggle and an "Ask me" toggle so I can mark fields mandatory or agent-ask-only.
- [x] As a user, custom field values on a task are displayed in the task detail panel and can be edited inline; required fields are marked with a `*` indicator so I know which fields must be filled before completing the task.

- [x] As a user, I can view Excalidraw diagrams stored in knowledge/diagrams/ rendered as real hand-drawn boards (native canvas, crisp at any zoom, wheel-pan/pinch-zoom, auto-centered on load) in the dashboard's Knowledge Preview tab.
- [x] As a user, embedded screenshots in Excalidraw boards (Obsidian SHA1-linked) resolve and render in the dashboard canvas view, so boards that reference screenshots are visually complete.
- [x] As a user, the dashboard header has a refresh button so I can reload the current page's data without navigating away (sleep debt, tasks, knowledge all update in place).
- [x] As a user, I see the data-structures knowledge file rendered as the relational/ER view (entities with PK/FK fields and relationship lines) in the Knowledge Preview tab, identical to the view the Core page previously provided for .sql files.
- [x] As a user, I can expand any knowledge document (markdown, SQL/ER, excalidraw, raw file view) into a full-screen in-app overlay via a ⛶ button next to the File/Preview tabs, and exit with Esc or the close button, so large boards and long documents are readable.
- [x] As a user, nested `diagrams/{title}/` excalidraw boards display under the Diagrams group with a clean leaf name (basename), not a redundant `title/title.excalidraw` label.
- [x] As a user, I can browse the project tag taxonomy on a dedicated Taxonomy page (facet chip clusters with usage counts, alias arrows, drift/audit panel) so I can see vocabulary health without the CLI.

- [x] As a user, the sleep page shows a mood-driven Sleepy mascot (awake/drowsy/asleep states by debt level) with a level-tinted aura and floating Zzz animation when asleep, so I understand consolidation urgency at a glance without reading raw numbers.
- [x] As a user, the "sleep cloud" (pending consolidation items) and the sleep hero are presented as one unified card with a hairline divider, so the sleep overview feels cohesive rather than split across two separate panels.
- [x] As a user, the board toolbar collapses View/Group/Versions/Properties chips into a `⋯ More` overflow menu at narrow widths (ResizeObserver-driven), so the board remains fully usable at any window width without horizontal overflow.
- [x] As a user, Kanban card drag-to-move no longer flickers the drop silhouette in WKWebView (Tauri), because the clear-on-drag-leave is deferred to the board-row container level rather than per-column, eliminating spurious `relatedTarget=null` oscillation.
- [x] As a user, the Council page has a rich empty-state explainer (animated 6-persona showcase diagram, "Start your first debate" CTA, "COUNCIL · LAB" branding) and a dismissible how-it-works banner in the populated state, so new users understand the feature before seeing any debates.
- [x] As a user, the Council nav entry carries a LAB badge so I can spot the experimental feature from anywhere in the sidebar.
- [x] As a user, `?page=<page>` deep-link support in the app shell lets me navigate directly to any page (e.g. `?page=council`), overriding the remembered page.
- [x] As a user, task context-menu submenus ("Move to status", "Set priority") use flyout panels beside the parent row, reducing menu vertical footprint from ~360px to ~190px, flipping left when near the viewport edge.
- [x] As a user, the version filter shows smart semantic buckets — **Current** (active sprint), **Backlog** (tasks without a version), and **Completed** (any released sprint) — above the literal version list with is/not toggles and live task counts, so I can filter by sprint state without knowing the active sprint name; saved views referencing `@current` always track the live active sprint automatically.

## Acceptance Criteria

### Kanban Board
- [x] Board shows four columns: To Do, In Progress, In Review (purple), Completed
- [x] Tasks can be dragged between columns, status updates on drop
- [x] Filter by status (todo/in_progress/completed) works
- [x] Filter by priority (critical/high/medium/low) works
- [x] Text search filters by task name and description
- [x] Date range filter (from/to) on created_at or updated_at field works
- [x] Filter state persists across page reloads via localStorage
- [x] Clear Filters button resets filter fields but preserves sort and groupBy
- [x] Filter by tag (multi-select with type-ahead search)
- [x] Sort by updated date, created date, priority, name works
- [x] Group by status (default), priority, urgency, version, or tags (multi-column)
- [x] Sub-grouping within columns (collapsible SubGroupSection with count)
- [x] Create task modal: name (required), description, priority, urgency, version, tags
- [x] Detail panel slides in from right on task click: shows all fields, status/priority/urgency/version dropdowns, changelog with add entry form
- [x] Eisenhower Matrix view: 2×2 priority×urgency grid, excludes completed tasks; tasks draggable between quadrants (updates priority+urgency on drop)
- [x] Timeline (Gantt) view: status-colored bars from created→due (prefers `start_date` when the model gains it), sticky task labels with priority dot + assignee, today marker, overdue outline, adaptive day/week/month ticks, collapsible Unscheduled tray
- [x] Timeline Gantt bars are pointer-draggable to reschedule: `onPointerDown` starts drag, `pointermove`/`pointerup` window listeners translate pointer offset to date delta, `dragPreview` state provides optimistic bar position; `updateTask` is held in `updateTaskRef` so the window listeners stay referentially stable across re-renders — fixes the cursor getting stuck in the grab state when a react-query mutation re-render tore listeners down mid-drag.
- [x] Timeline Gantt UX polish (v0.11.0 cycle): row height 34→48px with larger bar/label typography for readability; zoom ladder rescaled 10→100px/day; a `ResizeObserver` stretches the default day-column count to fill the scroll viewport (no dead horizontal space); label column 220→240px; tighter default date range that re-expands after each drag commits.
- [x] Calendar view: Monday-first month grid with tasks as chips on their due date, overdue + today highlighting, month nav, due/unscheduled counts
- [x] Activity heatmap view: GitHub-style 53-week grid with Created/Updated/Completed/Due metric toggle, intensity buckets, SR-only daily summary, peak/active-day stats
- [x] Shared time-axis date logic in `calendar-utils.ts` (local-time helpers + `taskSpan()`, forward-compatible with the in-flight `start_date` feature via a typed cast)
- [x] MultiSelectFilter: checkbox-based, type-ahead search shown when >5 options, All/None toggle
- [x] Version Manager: planning/released sections, stats header, Release button to promote
- [x] Flowchart-to-acceptance-criteria sync: `<!-- node:<id> -->` markers in task body link mermaid node IDs to checkboxes; toggling a checkbox updates the corresponding mermaid node's `:::class` (done/active/todo/blocked) and vice versa.
- [x] Race-safe rapid checkbox toggles: `pendingBodyRef` pattern computes successive optimistic bodies from the latest in-flight state (not stale server state); reverts on API failure.
- [x] Server PATCH body size limit raised to 1 MB; `---` front-matter delimiters sanitized from body before writing to prevent parse corruption.
- [x] Mermaid edge-line corruption fix: lines containing edge operators (`-->`, `---`, `-.->`, etc.) are never treated as node definitions during class-injection pass.
- [x] TaskDetailPanel shows a Start date editor alongside the Due date field; both are clearable; start≤due validation prevents invalid ranges (PR #67).
- [x] Assignee multi-select filter (KanbanBoard filter bar): shown only when a cloud backend is configured; filters by `person:<slug>` tag; hidden for local-only setups (PR #67).
- [x] Dashboard assignee picker (`TaskDetailPanel`) only offers real roster members on a remote backend (`allowCustom` disabled); already-assigned non-member chips flagged with a "won't sync" warning chip (red dashed) (PR #69).
- [x] `GET /api/tasks/members` drops `id:''` stubs when a real member roster is available, so the picker is never polluted with unresolvable free-text slugs (PR #69).
- [x] `boardModel.taskAssignees(task)` derives all assignees from `person:<slug>` tags (multi-aware, with legacy scalar `assignee` fallback); `taskAssignee()` returns the primary assignee. All board views — filter counts, group-by, card display, and Gantt labels — derive from this unified `person:` tag read. Group-by places a task under each of its assignees. Fixes assignees appearing as Unassigned in the board when set via person-tags (fix/dashboard-assignee-person-tags).
- [x] `BoardCard` renders multi-assignee tasks as an overlapping `AvatarStack` (up to 3 circular initials badges, `marginLeft: -6` overlap, ring border matching the card surface) plus a `+N` overflow chip; each badge uses a deterministic per-slug HSL hue (`assigneeHue()`) and per-person `title` tooltip showing the full display name; the overflow chip's tooltip lists all remaining names. Fixes cards previously showing only the primary assignee on multi-assignee tasks.
- [x] Sprint-aware `VersionFilter` component replaces the generic `MultiSelectFilter` for the version facet: status icons (star=current, dot=planning, hollow=unregistered, check=released), "current" badge, release date on completed rows, per-row Set-current (star) + Complete (check) actions, "Current" quick-pick chip, collapsible Completed section, status-aware sort (current→planning→unregistered→backlog→released, completed sink to bottom).
- [x] `GET /api/releases/active` returns `{ active: string | null }` (registered before `:version` route to prevent segment capture); `PUT /api/releases/active` accepts `{ version: string | null }` — null/empty clears; a planning entry is lazily created for an unregistered version name; 409 on an already-released version; records a dashboard change.
- [x] `useActiveVersion`, `useSetActiveVersion`, `useCompleteVersion` hooks; `VersionFilter.tsx/.css` wired through `TaskFilters` + `KanbanBoard` (versionItems join of task version strings + RELEASES + active).
- [x] `TaskCustomFields` component renders custom field values in `TaskDetailPanel`; `CustomFieldInput` provides type-appropriate controls (text, number, date, select); `AddCustomFieldForm` for adding new field defs; all wired to task `custom_fields:` frontmatter.

### Version Filter — Smart Semantic Buckets
- [x] `@current` virtual token resolves at filter time to tasks whose version equals the active sprint name; chip only renders when an active sprint exists.
- [x] `@backlog` virtual token resolves to tasks with no version assigned; the literal "backlog" row in the version list is folded into this bucket when `@backlog` is present, preventing a duplicate row.
- [x] `@completed` virtual token resolves to tasks in any released/completed sprint (version field matches any version with `status: 'released'` in RELEASES.json).
- [x] Each smart bucket chip shows a live count of matching tasks and supports is/not toggle (include vs exclude).
- [x] `BoardToolbar.tsx` gates each bucket's rendering on applicability: `@current` requires an active sprint; `@backlog` shown when relevant; `@completed` shown when any completed releases exist.
- [x] `normFilters()` migration pass rewrites persisted literal `'backlog'` in the version array → `'@backlog'` on saved-view load, preventing old state becoming an un-dismissable ghost filter row.
- [x] Saved views containing `@current` always resolve to the live active sprint — changing the active sprint updates what `@current` matches with no version-name staleness in the view.

### Version Rename + Delete Controls (v0.10.0)
- [x] Every row in the Versions popover has an **✎ rename** inline-edit control and a **🗑 delete** control with a confirm dialog.
- [x] **Rename** (`PATCH /api/releases/:version` with `{newVersion}`): rewrites the `RELEASES.json` entry key, re-points every task whose `version:` field matches the old string via `repointTasksVersion()`, moves the `.active-version.json` pointer if it pointed at the old name. Returns 409 on a name collision. Works on unregistered ghost versions (re-points tasks only, no RELEASES.json entry to rename).
- [x] **Delete** (`DELETE /api/releases/:version`): removes the entry from `RELEASES.json`; sets `version: null` on all tasks that pointed at the deleted version (warn-and-clear policy — tasks are NEVER deleted); clears the active-version pointer if it pointed there. Ghost versions (no RELEASES.json entry) clear-and-exit cleanly.
- [x] Delete confirm dialog surface: counts how many tasks will have their version cleared and surfaces the count ("X tasks will have their version cleared"). `window.confirm`-style consistent with other destructive dashboard controls.
- [x] `repointTasksVersion(oldVersion, newVersion)` shared helper via `LocalTaskBackend.updateFields` so re-points are journaled (changelog + cloud sync) like any other task field change.
- [x] 9 route tests covering rename (registered / ghost / collision / active-move / back-compat) and delete (registered+tasks / ghost / active-clear / 404) — all pass; existing release suite still green.
- [x] `useRenameVersion` and `useDeleteVersion` TanStack Query mutation hooks wired to `VersionsPopover.tsx` and `useVersions.ts`.

### Tasks Board Redesign — Saved Views + Shared/Local Preferences (v0.10.x)
- [x] Board rebuilt to the violet design language (from `Board.dc.html`): saved-view tab bar, a combined two-pane Filter menu (per-field include `✓` / exclude `✕`), View-type chip, Group + sub-group chip, Sort chip + direction, Versions **popover** (popup, not a dropdown), and a card Properties chip (toggle which fields show on cards).
- [x] **Saved views** carry their own filter / sort / group / sub-group / layout / search combination. Switching a view applies its config; editing it shows an "Unsaved changes · Reset · Save view" affordance in the tab bar; views have a kebab menu (Rename / Duplicate / Delete; default views are locked).
- [x] **Version-controlled board preferences**: views, sorts, filters, grouping, and the managed version list persist to `_dream_context/overrides/board.json` (git-tracked — survives `dreamcontext update`). Saving a view "for everyone" writes here. This makes a view/sort/filter combination permanent and shared across the team, never lost to localStorage or a fresh desktop loopback origin.
- [x] **Per-machine override**: saving a view "for yourself" writes to `_dream_context/state/board.local.json` (git-ignored). It holds private per-view overrides, local-only views, the active view, and card-property toggles. On read the client merges shared + local (local override wins for that view; local-only views append; a shared view with a private override shows a "•yours" marker).
- [x] **Save-scope prompt**: every Save view / Create view opens a `SaveScopeDialog` ("Save for everyone" → `overrides/board.json`, vs "Save for yourself" → `state/board.local.json`), defaulting to the view's current home scope. Version add/remove writes to the shared file (project structure); active-view selection, collapse, and card-properties are per-machine (no prompt).
- [x] Card properties (description / tags / priority dot / urgency bar / due / RICE / assignee / version) toggle which fields a `BoardCard` renders; the at-risk alert strip surfaces overdue / due-today / due-this-week counts with a "Show at-risk only" quick filter.
- [x] Kanban drag-and-drop patches whichever dimension is grouped (status / priority / urgency / version / assignee). The existing Eisenhower / Timeline / Calendar / Heatmap / RICE views and the rich `TaskDetailPanel` + `TaskCreateModal` are preserved and fed the filtered task set via the new view-type switcher (NOT regressed to "coming soon").
- [x] Backend: `GET /api/board` → `{ shared, local }`; `PUT /api/board/shared` and `PUT /api/board/local` (CSRF-guarded, strict-pick `board`, 512 KB cap, missing/corrupt reads back as `{}`). Mirrors the `ui-settings.ts` brain-settings pattern. New files: `dashboard/src/hooks/useBoard.ts`, `dashboard/src/components/tasks/boardModel.ts` + `BoardViewTabs/BoardToolbar/BoardColumn/BoardCard/SaveScopeDialog/AtRiskAlert.tsx` + `Board.css`; `src/server/routes/board.ts`.

### Sleep State
- [ ] Agent avatar (diamond logo) in header: full color when alert, dims progressively, pulses with "zzz" when must_sleep
- [ ] Sleep badge in header shows level name and debt number
- [x] Sleep page: mood-driven Sleepy mascot with `getSleepMood(debt)` helper — awake (≤6), drowsy (7–9), asleep (≥10); level-tinted aura on card; floating Zzz on the asleep state.
- [x] Sleep page: session history and dashboard-activity cloud merged into a single card below the hero (hairline divider, matching padding, violet wash); "Sleep cloud" standalone header and subtitle removed.
- [x] Sleep page: stat pills (Work sessions / Highlights) and per-group detail rows visible in the cloud section; dashboard activity groups rendered with create/update/delete chips.
- [x] Sleep page layout width matches other pages (full-width alignment consistent across all pages).

### Core Files
- [ ] File list in left panel shows all core files (0.soul.md through 5.data_structures.sql, CHANGELOG.json, RELEASES.json)
- [ ] Clicking a file shows content in right panel
- [ ] Markdown files have an Edit button that opens split-pane editor (textarea left, preview right)
- [ ] JSON files display formatted JSON
- [ ] Saving a core file records the change in .sleep.json dashboard_changes

### Knowledge Management
- [ ] Knowledge list shows all knowledge files with name, description, tags
- [ ] Search filters by name, description, and tags
- [ ] Pin/unpin toggle on each knowledge card
- [ ] Clicking shows full content in detail panel
- [ ] Pin/unpin records change in .sleep.json dashboard_changes
- [x] `MarkdownPreview` renders SQL and other code blocks with syntax highlighting (highlight.js, theme-aware, DOMPurify allowlist extended for `hljs-*` span classes)
- [x] Data-structures files appear under the Knowledge view (not Core), because `knowledge/data-structures/` is now canonical

#### Knowledge Fullscreen (#21 / PR #30)
- [x] Generic `FullscreenOverlay` component (`dashboard/src/components/layout/FullscreenOverlay.tsx/.css`): in-app fixed-position dialog (NOT the browser Fullscreen API), `role="dialog"` + `aria-modal` + `aria-label` (doc name); header carries doc name, File/Preview tabs, and a close button.
- [x] Esc closes via a document-level capture-phase keydown listener (element-scoped listeners go dead in Firefox/Safari when clicking non-focusable content moves focus to `<body>`); Tab is trapped and pulled back into the overlay if it escapes; focus returns to the trigger on close.
- [x] FOCUSABLE selector excludes disabled elements (`:not(:disabled)`) — markdown task lists render disabled checkboxes that can never be `document.activeElement`; one at first/last position would break the Tab wrap check.
- [x] Body scroll locked while open with scrollbar-width compensation (no layout shift on enter/exit).
- [x] ⛶ expand button on KnowledgePage covers all views: markdown preview, SQL/ER, excalidraw, and raw file; File/Preview tab state is shared in/out of fullscreen (survives enter/leave).
- [x] Single render site: pane content is unmounted while the overlay is open so a doc never mounts twice (excalidraw export + mermaid element ids collide on double-mount); ExcalidrawPreview's mount-time fit + ResizeObserver re-fit the board to the larger canvas.
- [x] `.fullscreen-overlay-body` child rule uses `:only-child` (0,2,0 specificity) so it beats `.excalidraw-preview { min-height: 420px }` regardless of CSS emission order.
- [x] e2e spec `e2e/knowledge-fullscreen.spec.ts`: open/close paths, tab use inside the overlay, scroll lock, list/search preservation, and the excalidraw svg actually growing in full-screen.

#### Taxonomy Page
- [x] Taxonomy page (`dashboard/src/pages/TaxonomyPage.tsx/.css`, `useTaxonomy.ts` hook): facet chip clusters with alias-resolved usage tallies, alias arrows, drift/audit panel; linked from nav + CorePage.
- [x] Backed by read-only `GET /api/taxonomy` (vocabulary + usage tallies + audit buckets); all mutations stay CLI-only.

### One-Click Full-Machine Upgrade (v0.11.0 cycle, in progress)
- [x] `UpdateBadge` shows whenever there's genuinely something to upgrade: an outdated CLI (`cliOutdated`), new packs, or a prose nudge — not just the prose nudge as before (matters most in the desktop app, where the prose CLI line is suppressed but the badge can still act).
- [x] `POST /api/launcher/upgrade` spawns the SAME `dreamcontext upgrade --yes` the CLI exposes, inside an interactive login shell (`$SHELL -ilc`) so `npm`/`npx` resolve even when the app was launched from Finder/Spotlight; singleton in-memory `upgradeRun` (only one machine-wide upgrade at a time — it mutates the shared npm install AND the shared `.app` bundle).
- [x] `GET /api/launcher/upgrade/status` polls `{ state: 'idle'|'running'|'done'|'error', output }`; output is capped to an 8000-char tail so a chatty run can't grow memory unbounded; a 12-minute safety-ceiling timeout force-kills a stuck run.
- [x] `UpdateBadge.tsx` state machine: idle → running (spinner + live log) → done (relaunch button) / error (retry button); on mount it restores an in-flight OR just-finished-but-unrelaunched run from `/upgrade/status` (not just `running`) so a finished upgrade doesn't reappear as a fresh "Upgrade everything" button and re-trigger a redundant run.
- [x] `POST /api/launcher/relaunch` detaches a `sleep 2 && open <app>` into its own process group (`detached` + `unref`) so it escapes the parent-death watchdog/reap when the current window closes to quit the app — re-opens the swapped bundle after the old process releases it; reports `{ ok: false, reason: 'app_not_installed' }` outside an installed app (frontend keeps the window open with a manual-reopen hint instead of quitting into a dead end).
- [x] Escape does not dismiss the popover while an upgrade is `running` (the affordance would vanish while the job keeps running unattended).
- [ ] **Known open bug (code review, not yet fixed):** `UpdateBadge.tsx`'s `applyStatus()` has no branch for `state: 'idle'` — if the server's in-memory `upgradeRun` is lost (server restart/crash mid-upgrade) while a window is still polling with `phase: 'running'`, the badge never learns the job is gone and the poll interval runs forever. The server-side sibling bug (`POST /upgrade` unconditionally reporting `state: 'running'` even on a synchronous spawn failure) WAS fixed — the response now reflects `run.state` honestly.

### Settings — Cloud Provider / Token Entry (v0.10.0)
- [x] Settings page has a cloud provider panel for the active backend (ClickUp or GitHub); shows current token masked status (`GET /api/tasks/token-status`).
- [x] Token entry field: writes to gitignored `.secrets.json` via `POST /api/tasks/token`; token never echoed in response; visible feedback (set / cleared).
- [x] Dry-run provision preview: "Preview" button calls `POST /api/tasks/provision?dryRun=true` and shows what fields/labels would be created (created[], existing[]) before the user clicks "Provision".
- [x] Actual provision button calls `POST /api/tasks/provision` (no dryRun); errors surface inline.

### Settings — Section Navigation (v0.10.0)
- [x] Settings page has a left-rail section-nav menu with anchors: Platforms / Cloud Tasks / Task Format / Memory / Connections / Sleepy. Task Format appears above Sleepy and carries a BETA badge plus a "How the format works" documentation link. Clicking a nav item smooth-scrolls to the corresponding section.

### Settings — Task Override Editor (v0.10.0)
- [x] `TaskOverrideEditor` component in `dashboard/src/components/settings/`: displays the active `overrides/task.md` raw markdown as a **read-only** view (not an editable textarea) and the list of parsed custom field defs.
- [x] `AddCustomFieldForm` component: add a new field definition (name, type, options, sync targets, prompt, **Required toggle**, **"Ask me" toggle**). Calls `POST /api/task-overrides/fields` (upsert, carries `ask: boolean`). Editing an existing def pre-populates the form including the required and ask flags.
- [x] Per-field remove button: calls `DELETE /api/task-overrides/fields/:key`.
- [x] `GET /api/task-overrides` returns `{ customFields, agentInstructions, warnings }`; `GET /api/task-overrides/doc` returns raw markdown; `PUT /api/task-overrides/doc` saves verbatim.
- [x] Doctor surface: `dreamcontext doctor` warns on malformed `overrides/task.md` (surfaced from `loadTaskOverride().warnings`).
- [x] `TaskCustomFields` in `TaskDetailPanel` renders required fields with a `*` marker so the user knows which fields block task completion.

### Features
- [x] Feature list shows all features with slug, status badge, tags
- [x] Clicking shows full PRD: all sections (Why, User Stories, Acceptance Criteria, Constraints, Technical Details, Notes, Changelog)
- [x] File/Preview tab toggle: File shows raw markdown, Preview renders as HTML (same pattern as Core and Knowledge pages)

### Change Tracking
- [ ] Every create/update action via dashboard API writes to .sleep.json dashboard_changes array
- [ ] Each change records: timestamp, entity, action, target file, field changed, human-readable summary
- [ ] `dreamcontext sleep done` clears dashboard_changes along with sessions

### About / Landing Page
- [x] AboutPage rebuilt as 9 self-contained section components under `dashboard/src/components/about/`.
- [x] FlowDiagram engine: single data-driven React component (FlowDiagram.tsx); instance-unique gradient IDs via `useId()`; inline SVG `stroke`/`fill` attributes (not CSS); CSS Motion Path dot animation (offset-path + offset-distance); reduced-motion guard parks dots at 55% (static, directional).
- [x] Hero: inline recolored diamond SVG + wordmark left; looping brain video (webm + mp4 + poster) right; heading "The persistent brain for AI natives"; "Works with Claude Code" credibility pill above install command.
- [x] How-it-works diagram: 8 context categories incl. data-structures, skills, sub-agents; RemSleep shown as multi-agent (parallel specialists); Motion Path dot animation.
- [x] "How sleep works" sub-section: debt accumulation flow + 3 parallel specialists with real file domains.
- [x] "How the system remembers" sub-section: BM25F → Haiku (smallest cloud agent) → SessionStart snapshot.
- [x] Architecture: cinematic 3D cortical-stack (layered cross-section), not a flat grid.
- [x] Skill-packs marquee: live from `usePacks()` hook (not hardcoded), infinite scroll, pause on hover, reduced-motion fallback to static scroll row.
- [x] Features showcase: "One brain, many faculties" pinned scroll-scrubbed spotlight — 11 faculty panels (incl. goal-skill flagship), sticky header+stage, imperative scrub on refs, snap-to-nearest on scroll-idle; mobile (<860px) un-stacks to normal tablist.
- [x] goal-skill faculty: landscape loop diagram (planner→plan-review↻→implementer→code-review↻→validator↻→shipped; ↻≤3 bounded retry loops on each stage).
- [x] FlowDiagram `wrapSub()` auto-wraps captions to node width (greedy break on ` · ` separators, viewBox-unit font math, size-aware 12/10 for full/mini); no caption overflow possible.
- [x] Wire contrast fix: `.fd-wire` uses `color-mix(in srgb, var(--color-text) 38%, transparent)` (not `var(--color-border)`) so connectors read in both light and dark themes.
- [x] "What is this?" sidebar entry: accent-soft fill + glow dot + bounce keyframe until first click; `dreamcontext.dashboard.aboutSeen` localStorage flag retires nudge permanently.
- [x] Token-only colors in all about component CSS (no raw hex/rgb in component rules).
- [x] Build green, tsc clean, light + dark screenshots pass.
- [x] Responsive: 11 alignment tests green (sidebar rail at 390/768, KB/Core/Features stacked at 768, settings hint aligned, council count in column).

### Design
- [ ] Lightweight, minimal UI inspired by Notion and Linear
- [x] Linear Midnight design system applied: Neon Lime (#e4f222) as sole accent, Inter Variable typeface (weight 510/590 with 500/600 fallback), pitch-black/graphite/deep-slate layered surfaces, muted Storm Cloud secondary text, flat surfaces (glassmorphism removed), Berkeley Mono for code.
- [ ] Purple-to-magenta brand gradient: #641787, #781ca3, #8200a6, #db04b4 (retained as legacy variable; Neon Lime replaces as primary action color)
- [ ] Light and dark mode with system preference detection and manual toggle
- [ ] WCAG AA contrast ratios
- [ ] Responsive layout (sidebar collapses on small screens)

### Technical
- [x] Command: `dreamcontext dashboard` starts HTTP server on localhost:4173 (configurable with --port)
- [x] Server: Node.js native http module, zero new runtime dependencies
- [x] Server binds to `127.0.0.1` by default (loopback only); a `--host` flag allows overriding with a visible warning.
- [x] Mutating endpoints (`POST/PUT/PATCH/DELETE`) reject requests whose `Origin` header is present but not a loopback origin — CSRF defense.
- [x] CORS reflects only loopback origins (never `*`).
- [x] All filesystem paths built from request input go through `safeChildPath()` — path-traversal guard.
- [ ] Frontend: React 19 + Vite 6 + TypeScript strict
- [ ] State: TanStack Query for server data, Context for theme/i18n
- [ ] Build: `npm run build` builds dashboard then CLI, dashboard output copied to dist/dashboard/
- [ ] All existing 258+ tests continue to pass

- [x] Excalidraw preview: knowledge files with slug matching diagrams/*.excalidraw render via `Excalidraw` canvas component (view-mode, lazy-loaded); boards are crisp at all zoom levels (live re-draw vs. one-shot SVG rasterization); `scrollToContent({fitToViewport:true})` called on mount + 100ms settle + ResizeObserver so board is always centered and fit; handles both `json` and `compressed-json` fence variants.
- [x] Embedded-image resolution for Excalidraw boards: `GET /api/knowledge-assets/:slug` parses `## Embedded Files` SHA1→path map, resolves image paths under vault (containment-guarded, image extensions only), down-scales to WebP via sharp (mtime-cached), returns base64 `files` map; dashboard merges resolved files into scene before canvas mount so Obsidian-linked screenshots render.
- [x] Live refresh header button: clicking refresh calls `queryClient.invalidateQueries()` for the active page without a full page reload; sleep debt, tasks, and knowledge data all update in place.
- [x] Data-structures ER view in Knowledge: files with slug starting with data-structures/ detect the ```sql fence (fenceConcat fallback for multi-fence files), extract the body, and render SqlPreview. Non-schema knowledge files are unaffected and continue using MarkdownPreview.
- [x] Nested excalidraw grouping (#20): depth-2 `diagrams/{title}/` slugs show leaf `{title}` under Diagrams; `leafName` uses basename (collapsing redundant `{title}/{title}.excalidraw`), not prefix-strip; `isExcalidrawSlug` matches nested slugs; knowledge detail route stays raw (renderer needs the raw scene — memory gets extracted text, see knowledge-base PRD).
- [x] Recursive nested folder tree: KnowledgePage.tsx builds a full recursive folder tree for knowledge/diagrams (and all knowledge subfolders), not just single-level depth. Category boards nest as collapsible sub-folders. Board cards show pen/sketch icon.
- [x] Excalidraw canvas rendering: `ExcalidrawPreview` uses live `@excalidraw/excalidraw` canvas (view-mode) instead of `exportToSvg()`. Lazy-loaded. `scrollToContent` via mount + 100ms timer + ResizeObserver. See `knowledge/dashboard-knowledge-rendering.md`.
- [x] `GET /api/knowledge-assets/:slug`: resolves Obsidian embedded images (SHA1→WebP base64, sharp, mtime-cached, safeChildPath-guarded). Key files: `src/server/routes/knowledge.ts`, `src/server/index.ts`.
- [x] Page-title headers removed from ALL dashboard pages (Tasks, Features, Knowledge, Council, Core, Settings, Sleep, Packs, Taxonomy); content starts directly without a redundant `<h1>` title; sidebar nav already labels the active page.
- [x] Sleep page layout width matches other pages (full-width alignment consistent across all pages).
- [x] Features page search box added.

### Board & UX Polish (2026-06-28)
- [x] `BoardToolbar` responsive overflow: `ResizeObserver`-driven `shrinkToFit` loop collapses View/Group/Versions/Properties chips into a `⋯ More` flyout when `scrollWidth > clientWidth`; `shell-main { min-width: 0 }` prevents the board's `nowrap` toolbar from pushing the board wider than the window. The collapsed controls' existing popover bodies render as left-flyouts from the More panel.
- [x] Kanban drag-flicker fix (WKWebView): `onColumnDragLeave` removed from per-column handlers (fires spuriously on silhouette reflow and when WKWebView reports `relatedTarget = null` mid-drag); `dragOverKey` now cleared only at the board-row container level on genuine leave of the row. Drop and drag-end still call `endDrag()` to reliably clear. No flicker in the desktop app.
- [x] Task context-menu flyout submenus: "Move to status" and "Set priority" in `TaskContextMenu` use flyout submenus (hover/click-open, `flipLeft` guard near viewport edge); menu vertical footprint ~360px → ~190px.
- [x] Knowledge subfolder slug fix: `BrainSearch` and `DocContent` derive the knowledge slug from `hit.path` (`knowledge/.../x.md` → `…/x`) rather than bare `hit.slug`, so nested knowledge files (e.g. `decisions/decision-mem0-vs-bm25`) open correctly in the side panel without a 404. Root-level knowledge files unaffected (their path-derived slug matches the bare slug).
- [x] Settings page max-width now uses `var(--page-max-width)` (matches AboutPage and other pages); was previously hardcoded to 1080px.

### Council Page Redesign (2026-06-28)
- [x] Empty-state: full "What is this?" explainer (brand gem → "LAB · COUNCIL" kicker → gradient headline → lead paragraph) + animated 6-persona showcase stage (Architect / Pragmatist / Skeptic / Researcher / Advocate / Strategist debating in a ring, comets on edges, converging to synthesizer → decision report) + "Start your first debate" CTA + experimental footnote.
- [x] Populated-state: Council + LAB badge header; "New debate" button in the filter toolbar row (not in a separate header section); dismissible "How Council works" banner above the debate grid; LAB chip on the Council sidebar nav entry.
- [x] `?page=<page>` deep-link support in `Shell.tsx` (explicit page param overrides remembered page, validated against page list); enables direct navigation to any page.
- [x] `FlowDiagram` engine reused for the Council showcase (6-persona ring with CSS Motion Path comets); same composited animation system as the About page — zero jank at full and mini sizes.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-07-04]** **One-click upgrade is a singleton background job, not a request/response call.** `dreamcontext upgrade --yes` can take minutes (npm install + app download + refreshing every registered project), so `POST /api/launcher/upgrade` starts it and returns immediately; the badge polls `GET /api/launcher/upgrade/status` on a 1.2s interval. In-memory `upgradeRun` is intentionally a single module-level variable (not per-session) — a second concurrent upgrade would race the same global npm install and the same shared `.app` bundle, so any window's poll sees the one true state. State is lost on server restart by design; the on-disk result is what matters, and a restart-then-repoll simply reports `idle`.
- **[2026-07-04]** **Relaunch escapes the reap via a detached process, not an in-process restart.** Closing the last window quits the app, which tears down the very server handling the relaunch request — so the relauncher can't just `exec` the new bundle from inside itself. `POST /api/launcher/relaunch` spawns `sleep 2 && open <app>` `detached` + `unref`'d into its own process group, which survives the parent app's death (would otherwise be caught by the existing parent-death watchdog / Rust process-group reap documented in `desktop-beta-tauri-multivault.md`). The frontend calls relaunch, THEN closes its own window — never the reverse, or the detached process races the still-alive window's teardown.
- **[2026-06-29]** **Assignee reading from `person:` tags (board model unification).** The board model previously read only the legacy scalar `assignee` field; tasks whose assignee was stored exclusively as `person:<slug>` tags appeared as Unassigned in filter/group-by/properties/gantt (though the detail panel showed them correctly, since it reads tags directly). Fix: `boardModel.taskAssignees(task)` derives all assignees from `person:` tags with legacy scalar fallback; `taskAssignee()` returns the primary. All board views (filter counts, group-by, card avatars, Gantt labels) now flow through this derivation. Multi-assign is modeled: group-by places a task under each of its assignees. `KanbanBoard` builds the assignee option list from every referenced person in the task set.

- **[2026-06-29]** **Version filter smart buckets: virtual filter token design.** `@current`, `@backlog`, `@completed` are `@`-prefixed sentinel constants (in `boardModel.ts`) that resolve at *filter time* against live `versionMeta` (active sprint + released-version set) rather than equalling a stored field value. A saved view referencing `@current` always tracks the live sprint without storing its name. `versionTokenMatches(token, version, versionMeta)` encapsulates resolution; `matchVersionField` and `filterTasks` receive the `versionMeta` param. `normFilters()` includes a migration pass: persisted literal `'backlog'` in the version array → `'@backlog'`, preventing old saved-view state from becoming an un-dismissable ghost row when the literal backlog row is folded into the bucket. `BoardToolbar.tsx` gates each chip on applicability (presence of active sprint, unversioned tasks, released sprints). See `knowledge/patterns/virtual-filter-tokens.md` for the reusable pattern.

- **[2026-06-29]** **Version "ghost" mechanic and rename/delete policy.** An "unregistered version" (ghost) is a string present only on tasks' `version:` frontmatter field with no corresponding entry in `RELEASES.json`; the Versions popover derives ghosts live by joining task version strings against RELEASES. Ghosts cannot be deleted as records (there is no record); "delete" means finding all tasks behind the ghost and clearing their `version:` field. Rename on a ghost re-points tasks only. Rename on a registered version additionally renames the RELEASES.json key and moves the active-version pointer. **Delete policy**: tasks are NEVER deleted; their `version:` field is set to `null` (warn-and-clear). The rename/delete backend uses `repointTasksVersion()` which goes through `LocalTaskBackend.updateFields`, so changes are journaled and synced like any other task edit. Route registration order matters: `PATCH /api/releases/:version` must be registered BEFORE `GET/PUT /api/releases/:version` would otherwise matter — but the rename PATCH extends the existing PATCH handler, so no ordering issue. 409 on collision guard prevents creating a duplicate key.
- **[2026-06-28]** **Sleep page redesign: mood-driven mascot + unified cloud card.** `SleepPage.tsx` redesigned to lead with a mood-driven Sleepy mascot (`getSleepMood(debt)`: awake ≤6, drowsy 7-9, asleep ≥10; Zzz float + level-tinted aura). The standalone "Sleep cloud" card is merged into the hero card as a continuous section (hairline `border-top` divider, matching horizontal padding, faint violet wash) — no second card chrome. The at-a-glance `12 ITEMS` count moved to the hero headline as a pill. Note: this Sleepy mascot is the DASHBOARD version (`SleepPage.tsx`); the Sleepy notch mascot (`SleepyMascot.tsx`) is the coded animated gem in the notch capture panel.
- **[2026-06-28]** **Board toolbar responsive overflow:** `BoardToolbar` implements `scrollWidth > clientWidth` shrink-to-fit via `ResizeObserver`; collapses View/Group/Versions/Properties (in that priority order, Properties first) into a `⋯ More` chip. `shell-main` gained `min-width: 0` (was `auto`) to prevent the nowrap toolbar from forcing the board wider than the window. Root cause of the prior overflow bug: `.shell-main { flex: 1 }` with the default `min-width: auto` refused to shrink below its content's min-content width (~1100px toolbar).
- **[2026-06-28]** **Kanban drag-flicker root cause (WKWebView).** The board's `dragOverKey` state oscillated because: (1) inserting the "Drop to move here" silhouette at column top shifts cards → triggers `dragleave` on the column boundary; (2) WKWebView reports `relatedTarget = null` mid-drag → `!contains(null)` always true → key cleared spuriously. Fix: remove per-column `onColumnDragLeave`; clear `dragOverKey` only at the board-row container level (with a `relatedTarget !== null` guard). Drag-end + drop still call `endDrag()` to reliably clear.
- **[2026-06-28]** Tasks-board preferences are split across TWO project files, never localStorage: SHARED views/sorts/filters/grouping + the version list live in version-controlled `_dream_context/overrides/board.json` ("save for all"); per-machine overrides + the active view + card-property toggles live in git-ignored `_dream_context/state/board.local.json` ("save for yourself"). Rationale: a saved view's filter/sort combination must be permanent and shareable, not lost to a browser's localStorage or the desktop app's per-launch loopback origin (the same gotcha `ui-settings.ts` solved for brain settings). `overrides/` was chosen for the shared file because it is git-tracked AND survives `dreamcontext update` (same home as `overrides/task.md`); `state/` is wholly git-ignored, so it is the natural per-machine home. Client merges shared + local on read (local override wins per-view; local-only views append). The dashboard design language had already moved to violet (`tokens.css`: `#7b68ee` light / `#9d8cff` dark), so the redesign reused the existing tokens rather than introducing a new palette. The old `TaskFilters`/`KanbanColumn`/`VersionManager`/`VersionFilter`/`MultiSelectFilter`/`FilterPopover`/`SubGroupSection`/`savedViews` store are now dead (replaced by the `boardModel` + `Board*` components) and are a follow-up cleanup candidate; `TaskCard` is retained because Eisenhower/RICE views still depend on it.

- **[2026-06-23]** `ask: true` on a custom field adds an "Ask me" toggle in `AddCustomFieldForm`; the flag is serialized via `POST /api/task-overrides/fields` and carried in `useTasks.ts` types. The dashboard itself does not enforce any "ask-before-create" flow — the behavioral rule is injected into the agent's briefing (`renderOverrideBriefing`) so it fires in CLI/agent contexts, not in the quick-draft dashboard create flow. Design rationale: `[[decisions/decision-task-format-override-and-custom-fields]]`.
- **[2026-06-23]** Settings section-nav left rail: Platforms / Cloud Tasks / Task Format / Memory / Connections / Sleepy order; Task Format above Sleepy because it is a power-user capability that benefits from proximity to Cloud Tasks (both relate to the task model). BETA badge on Task Format signals the override schema may evolve. "How the format works" doc link opens the relevant section of the skill reference.
- **[2026-06-23]** Task override markdown panel is read-only in the dashboard (not an editable textarea): direct YAML/markdown editing is error-prone and bypasses the structured `upsertCustomField` validation path. The AddCustomFieldForm is the canonical edit surface; it also persists the `required` flag via `POST /api/task-overrides/fields`. Raw file editing remains a CLI / text-editor operation.
- **[2026-06-23]** Sprint-aware version filter sort order: current → planning → unregistered → backlog → released (completed sink to bottom). `versionItems` is the join of task version strings + RELEASES entries + the active version — so a sprint that exists only as a task tag (not registered in RELEASES.json) still appears as "unregistered" and can be promoted from the dropdown. Dates shown only for released/completed sprints (no schema change needed).
- **[2026-06-23]** `PUT /api/releases/active` registered BEFORE `GET/PUT /api/releases/:version` in the router so the literal string "active" is not captured as a `:version` param. The route lazily creates a planning RELEASES.json entry for an unregistered sprint name before marking it active; returns 409 if the version is already released (can't un-release from the dashboard).
- **[2026-06-23]** Cloud token entry is always `POST /api/tasks/token` → `.secrets.json` (gitignored); never `.config.json`. Token is not echoed in any API response — the response only confirms success. `GET /api/tasks/token-status` returns `{ set, source, masked, backend }` so the UI can show "configured via env" vs "secrets file" without exposing the value.
- **[2026-06-23]** Task override editor reads/writes `_dream_context/overrides/task.md` via `GET /api/task-overrides/doc` + `PUT /api/task-overrides/doc`. Custom-field CRUD uses `POST /api/task-overrides/fields` (upsert) + `DELETE /api/task-overrides/fields/:key`. A malformed override is surfaced as `warnings[]` in the API response — never silently ignored, never fatal. The override file lives inside the brain so it survives `dreamcontext update`.

- **[2026-06-18]** Excalidraw canvas gate on isLoading, not data===undefined (PR #35 review fix): gating board render on data===undefined would permanently wedge the board behind a spinner whenever the /api/knowledge-assets fetch errors (no embedded images, sharp unavailable, etc.). Gate on isLoading instead — board mounts on success OR error; only held while actively fetching. Additionally, initialData is frozen at Excalidraw canvas mount: the component does not react to files prop changes after mount, so a two-pass low→high progressive image swap is impossible (requires remount, resets pan/zoom). Current approach: single-pass — wait for useKnowledgeAssets to resolve, then mount once with the final files map. See knowledge/dashboard-knowledge-rendering.md for full rationale.
- **[2026-06-17]** Excalidraw canvas over SVG export (PR #35): `exportToSvg()` rasterizes boards once — WebKit samples a 2556×4646 px SVG down to viewport → soft on high-DPI, not recoverable on zoom. Replaced with the live `Excalidraw` canvas component (view-mode): re-draws per zoom level, crisp at all scales. Trade-off: larger runtime bundle (lazy-loaded via React.lazy, no initial load cost). `scrollToContent` must be called at mount + 100ms timer + ResizeObserver to catch flex-pane layout settling; a single mount-time call fires before final dimensions. See `knowledge/dashboard-knowledge-rendering.md` for full rendering architecture.
- **[2026-06-17]** `knowledge-assets` route is image-only, safeChildPath-guarded (PR #35): resolves Obsidian board embedded images (SHA1→path→base64 WebP via sharp); containment guard + image-extension allowlist prevent path traversal. Mtime-cached; recompresses on file change. See `knowledge/dashboard-server-security.md` for the broader security model.
- **[2026-06-12]** Knowledge fullscreen is an in-app fixed dialog, NOT the browser Fullscreen API: predictable theming/layout, no UA chrome or permission quirks, and it keeps the overlay inside the app's stacking/theme context. Single-render-site invariant: never mount the same document twice (excalidraw export and mermaid ids collide) — the pane unmounts while the overlay is open. Deferred follow-ups (explicit owner decision, anti-over-engineering): (1) Core-page fullscreen adoption via the same `FullscreenOverlay`, (2) single-instance render to avoid remount cost on toggle, (3) shared icon-button CSS class.
- **[2026-06-09]** Eisenhower Matrix drag & drop: the existing matrix had `onDragStart={() => {}}` no-op handlers — only structure, no interactivity. Implemented using native HTML5 DnD API (consistent with Kanban). A quadrant receives `onDragOver` + `onDrop`; on drop, both `priority` and `urgency` are patched atomically via the existing PATCH /api/tasks endpoint. No new DnD library added — native API is sufficient for the 2×2 grid (4 drop targets, no complex reordering). `eisenhower.ts` maps quadrant ID to `{priority, urgency}` pairs.
- **[2026-06-06]** `overflow-x: hidden` vs `clip` on the `.about` container: `overflow-x: hidden` creates a new scroll container, so any `position: sticky` descendant resolves its scroll container to `.about` (not `.shell-main`) and pins immediately — the whole spotlight was stuck. `overflow-x: clip` clips visually without creating a scroll container, preserving sticky semantics. Fix: `.about { overflow-x: clip }` in AboutPage.css. This is a general CSS invariant: if a section has sticky children, its overflow must be `clip` (or `visible`), never `hidden` or `auto`.
- **[2026-06-06]** CSS Motion Path for flow animation: `stroke-dashoffset` repainted the entire dashed stroke (full path length) on the main thread every frame. With 27 simultaneous comets the browser re-rasterized ~27 paths per frame → stutter. Replaced with a small `<circle>` per edge riding the path via `offset-path: path(d)` + `offset-distance: 0→100%` — a compositor-class transform; only the ~14px dot region is dirtied per frame. Glow is a per-instance radial-gradient fill (purple→blue→transparent), rasterized once. Measured: worst frame 11.2ms, 0 jank/179 frames at 27 dots. `FlowEdge.travel` is now unused (offset-distance is length-independent). Reduced-motion: park dot at `offset-distance: 55%` (static, but still on-path and directional).
- **[2026-06-06]** Pinned scroll-scrubbed spotlight (FeaturesShowcase): imperative scrub — scroll progress written to panel refs (opacity + translateY) per-frame, zero React re-renders per frame; React state fires only when centred faculty changes (for tab ARIA + rail highlight). Snap-to-nearest on scroll-idle: 140ms debounce after last scroll event; smooth-scrolls container to nearest faculty centre; lands within 8px SNAP_EPS → no-op (no loop). Skips snap at track ends (progress ≤0.012 / ≥0.988) to let the user scroll out of the section naturally.
- **[2026-06-05]** Responsive fix: root cause was zero width media queries in Sidebar/Shell — fixed 220px sidebar was clipping every page at tablet/narrow. Fix: responsive CSS breakpoints for sidebar + shell, plus alignment audit across all pages (11 Playwright tests). `dist/dashboard` sync: `vite` writes to `dashboard/dist/`, but `dreamcontext dashboard` serves from `dist/dashboard/` — must run root `npm run build` (not `cd dashboard && npm run build`) to sync. See note in web-dashboard task.
- **[2026-06-04]** About page / landing page: AboutPage.tsx is a composition-only file (no inline logic); all sections are self-contained under `dashboard/src/components/about/`. FlowDiagram.tsx is the single diagram engine — gradient IDs must use `useId()` and be referenced as inline SVG attributes (not CSS) to avoid cross-diagram collisions. HowItWorksDiagram.tsx/.css deleted once FlowDiagram landed. Logo is inline recolored SVG diamond (not a network hotlink — that image isn't dashboard-served). Brain video is pre-generated at `dashboard/public/media/brain.{webm,mp4,png}`.
- **[2026-05-31]** Server hardening decisions: (1) default host=127.0.0.1 (not 0.0.0.0) — LAN access requires explicit `--host`; (2) CSRF guard via Origin/Host check at server level (not per-route) so all new mutating routes inherit it automatically; (3) `safeChildPath()` in `src/server/safe-path.ts` is the single path-validation function — every route that builds a path from request input MUST use it. These are security invariants; do not regress. See knowledge file `dashboard-server-security.md` for full threat model.
- **[2026-05-23]** Brain 3D view is a toggle on the existing Brain page, not a separate route. `react-force-graph-3d` + `three` are dashboard-only deps (isolated from CLI). Labels use `THREE.Sprite` (billboard) to stay legible at all camera angles. `fog: true` on `SpriteMaterial` ties label opacity to scene fog so distant labels auto-fade with their nodes. Fly-to on click uses `fgRef.current.cameraPosition()` (ForceGraph3D's imperative API), not Three.js directly.
- **[2026-05-22]** Linear Midnight design system (additive, non-breaking): old `--glass-*` and `--color-brand-*` CSS variables retained for backward compatibility; no selectors deleted. Google Fonts CDN loads Inter in browser; air-gapped environments fall back to system font. `font-weight: 510/590` uses Inter variable font axis; falls back to `500/600` if Inter is not a variable font instance.
- **[2026-05-22]** Flowchart sync uses `<!-- node:<id> -->` comment markers embedded in task body (between a checkbox and its label) to bind checkbox state to a mermaid node ID. Edge-line corruption guard: lines containing `-->`, `---`, `-.->`, `==>`, `--`, `==` operators are skipped during node-class injection. `sanitizeMermaid()` strips problematic characters before passing to `mermaid.render()`.
- **[2026-05-22]** `pendingBodyRef` race safety: PATCH mutations read from `pendingBodyRef.current` (last optimistic value) rather than stale server data. On failure, `bodySourceRef.current` (last confirmed server value) is used to revert.
- **[2026-03-07]** in_review is treated as active (not completed): shown in snapshot, default task list, and Eisenhower Matrix alongside todo and in_progress. This is intentional — in_review is a review gate before completion, not a done state.
- **[2026-03-07]** Versions unified with Releases: no separate VERSIONS.json. Planning-stage versions are ReleaseEntries with `status: 'planning'`. Backward compat: entries without status field treated as released. One schema, one file, UI handles the separation.
- **[2026-03-07]** Eisenhower Matrix excludes completed tasks: it's a prioritization view for future work, not a history. Completed tasks remain visible in the Kanban "Completed" column.
- **[2026-03-07]** MultiSelectFilter search threshold: type-ahead search input shown when >5 options (list too long to scan). Hidden when ≤5 options.
- **[2026-02-25]** Agent character: user will provide custom design later. Using brand diamond logo as placeholder with opacity/animation based on sleep level.
- **[2026-02-25]** Multi-language: i18n infrastructure built (I18nContext with t() function and translation keys), English only for v1. Adding languages means adding translation objects.
- **[2026-02-25]** No router library: 5 pages managed by state-based page switcher. No deep linking needed. Add wouter (~1.5KB) later if URL routing is wanted.
- **[2026-02-25]** No drag-and-drop library: using native HTML DnD API. Upgrade to @dnd-kit if UX is insufficient.
- **[2026-02-25]** No CSS framework: custom CSS with design tokens (CSS custom properties). Keeps bundle minimal, full control over design system.
- **[2026-02-25]** Server uses Node.js native http module: zero new runtime dependencies. Routes are thin wrappers around existing src/lib/ utilities.
- **[2026-02-25]** dashboard_changes separate from sessions: dashboard changes are individual user actions, agent sessions have transcripts and scores. Mixing them would confuse the rem-sleep agent.
- **[2026-02-25]** Dashboard is a separate build target (dashboard/ directory with own package.json). React deps isolated from CLI deps.
- **[2026-02-25]** Framework: React + Vite chosen over Preact/Svelte for full ecosystem support (TanStack Query, rich component patterns).
- **[2026-02-25]** Editor: Markdown textarea with live preview. No heavy editor library for v1.

## Technical Details

### Architecture
- `src/server/` - Node HTTP server + REST API (bundled by tsup with CLI)
- `dashboard/` - React SPA (built by Vite, output copied to dist/dashboard/)
- Server serves static files from dist/dashboard/ and API from /api/*

### Key Files
- `src/server/index.ts` - createServer, startDashboardServer(), route registration
- `src/server/router.ts` - URL pattern matching with :param extraction
- `src/server/routes/*.ts` - API handlers (tasks, sleep, core, knowledge, features, changelog, health)
- `src/server/change-tracker.ts` - recordDashboardChange() writes to .sleep.json
- `src/cli/commands/dashboard.ts` - CLI command registration
- `dashboard/src/App.tsx` - React root with providers (QueryClient, Theme, I18n)
- `dashboard/src/styles/tokens.css` - Design tokens (colors, spacing, typography)
- `dashboard/src/hooks/useTasks.ts` - TanStack Query hooks for task CRUD
- `dashboard/src/components/tasks/KanbanBoard.tsx` - Main board with filtering/sorting/grouping

### API Endpoints
~36 endpoints covering: tasks (5 + 3 new: members, provision, token-status, token), sleep (2), core (3), knowledge (3), features (2), changelog (1), releases (4 — list/show/add + active GET/PUT), health (1), config (2 — GET+PATCH), packs (1), version-check (1), vaults (1), council (3), taxonomy (1 — read-only GET), task-overrides (5 — schema, doc GET/PUT, field upsert/remove).

New in v0.11.0 cycle (one-click upgrade, in progress — see launcher route file below):
- `POST /api/launcher/upgrade` — start (or no-op re-attach to) the singleton full-machine upgrade job.
- `GET /api/launcher/upgrade/status` — poll `{ state, output }` for the running/last upgrade.
- `POST /api/launcher/relaunch` — detached-process app relaunch after an upgrade completes.
- `GET`/`POST /api/launcher/agent-settings` — persisted Agents-surface prefs (`~/.dreamcontext/agent-ui.json`); see `in-app-agent-terminal.md`.

New in v0.10.0 (version rename + delete):
- `PATCH /api/releases/:version` — extended to accept `{ newVersion }`: renames the entry in RELEASES.json, re-points all tasks, moves active-version pointer; 409 on collision; works on ghosts (task re-point only).
- `DELETE /api/releases/:version` — warn-and-clear: removes RELEASES.json entry, sets `version: null` on all referencing tasks, clears active-version pointer if it pointed there.

New in v0.10.0:
- `GET /api/releases/active` — returns `{ active: string | null }` (current sprint)
- `PUT /api/releases/active` — set (lazily creates planning entry) or clear; 409 on released version
- `GET /api/tasks/token-status` — `{ set, source, masked, backend }` for the active cloud backend
- `POST /api/tasks/token` — write token to `.secrets.json` (gitignored); token never echoed
- `POST /api/tasks/provision[?dryRun=true]` — create recommended remote fields/labels; dry-run returns preview only
- `GET /api/task-overrides` — `{ customFields, agentInstructions, warnings }` from `overrides/task.md`
- `GET /api/task-overrides/doc` — raw markdown of the override file
- `PUT /api/task-overrides/doc` — save raw markdown verbatim
- `POST /api/task-overrides/fields` — upsert one custom field def (name, key, type, options, sync, prompt)
- `DELETE /api/task-overrides/fields/:key` — remove field def by key

Board preferences (saved views):
- `GET /api/board` — `{ shared, local }` (overrides/board.json + state/board.local.json; each `{}` when missing/corrupt)
- `PUT /api/board/shared` — write the version-controlled shared blob (`overrides/board.json`)
- `PUT /api/board/local` — write the git-ignored per-machine blob (`state/board.local.json`)

All mutating endpoints call recordDashboardChange() except `PATCH /api/config` (entity union not widened in v0.6) and the board-preference PUTs (UI prefs, not consolidation-worthy content).

### Build Pipeline
1. `npm run build:dashboard` - Vite builds React app to dashboard/dist/
2. `npm run build:cli` - tsup builds CLI + server to dist/index.js
3. tsup onSuccess copies dashboard/dist/ to dist/dashboard/
4. dist/dashboard/ ships in npm package (covered by "files": ["dist"])

### Brain 3D View (v0.4)

- `dashboard/src/pages/BrainPage.tsx` — `React.lazy(() => import('../components/brain/BrainCanvas3D'))` behind `<Suspense>`. Conditional render on `settings.display.view === '3d'`. Runtime node type extended with `z/vz/fz` fields for 3D force simulation state.
- `dashboard/src/components/brain/BrainCanvas3D.tsx` — owns `ForceGraph3D` instance, 3D force config (`d3-force-3d`: `forceCollide`, `forceX/Y/Z`), billboard label sprites (`makeLabelSprite()` → `THREE.Sprite` via `THREE.CanvasTexture`), scene fog setup, and click fly-to camera animation via `fgRef.current.cameraPosition()`.
- `dashboard/src/components/brain/BrainSettings.tsx` — `SegmentedRow` component added; View 2D/3D row at top of Display section.
- `dashboard/src/hooks/useGraphSettings.ts` — `display.view: '2d' | '3d'` field added (default `'2d'`); persisted in `brain:settings:v1` localStorage blob; old persisted state without `view` falls back to `'2d'` via falsy check.
- **Dependencies** (dashboard-only): `react-force-graph-3d@^1.29.1`, `three@^0.184.0`, `@types/three@^0.184.1`.
- **Chunk**: Vite splits `BrainCanvas3D` into its own async chunk (`~334 KB gzip`). Initial bundle size unchanged.
- **Fog**: `THREE.Fog(color, 320, 1100)` — linear fog from distance 320 to 1100. Fog color: dark `#0d0d10`, light `#f7f7fa`. `SpriteMaterial.fog = true` ties label opacity to fog, so far labels auto-fade with their nodes.
- **Fly-to**: `handleNodeClickInternal` positions camera along the node's radial vector from origin at `targetDistance=90` world units, animated over 900 ms.

### Flowchart-AC Sync (v0.4)

- `dashboard/src/components/tasks/TaskDetailPanel.tsx`
  - `syncCriteriaToMermaid(body, id, checked)`: finds `<!-- node:<id> -->` markers in the body; replaces the node's `:::class` in the mermaid block.
  - `sanitizeMermaid(src)`: strips characters that break mermaid parsing.
  - Edge-line guard: `EDGE_OPS_RE` regex skips lines with flowchart edge operators during class-injection.
  - `pendingBodyRef`: `useRef<string>` initialized from `task.body`; reset when `task.body` changes from server; all successive checkbox toggles read/write this ref, not component state.
- Server: `src/server/routes/tasks.ts` PATCH body limit 1 MB; `---` at start/end of body stripped before frontmatter write.

### Brain — 3D View

- [x] `BrainSettings → Display → View` segmented control lets the user flip between `2d` (default) and `3d` modes without leaving the page.
- [x] 3D renderer (`BrainCanvas3D`) is lazy-loaded via `React.lazy` + `Suspense`; `three` + `react-force-graph-3d` ship as a separate Vite chunk (~334 KB gzip) fetched only on first toggle to 3D; initial bundle size unaffected.
- [x] Node labels in 3D mode are `THREE.Sprite` billboard objects (text-on-canvas → CanvasTexture) that always face the camera and are positioned below each node sphere. Dimmed nodes receive lower-opacity labels.
- [x] Scene fog (`THREE.Fog`) fades far nodes toward the background color, providing depth perception: near nodes pop forward, far nodes recede. Fog color is theme-aware (dark: `#0d0d10`, light: `#f7f7fa`).
- [x] Clicking a node triggers a camera fly-to animation (`cameraPosition()` over 900 ms): camera moves along the node's radial vector from origin to a fixed close distance (90 units) while looking at the node.
- [x] All shared Brain behaviors carry over to 3D: filtering, neighbor highlighting, hover-dim, `onNodeClick` → NodeDrawer, group color palette, force-simulation settings sliders, `view` persisted to `brain:settings:v1` localStorage blob (missing key falls back to `'2d'`).
- [x] `npm run build` produces a distinct `BrainCanvas3D-*.js` chunk, confirming lazy separation.

### Control Panel (v0.6)
- [x] Settings page: loads `GET /api/config`, shows platforms checkboxes + packs toggles, Save issues `PATCH /api/config` with body `{platforms, packs}` only; loading/error/success/empty states; read-only Vaults subsection (current vault highlighted).
- [x] Packs page: lists catalog packs + standalone from `GET /api/packs`; packs in `config.packs` show "Installed" indicator.
- [x] UpdateBadge: header banner surfaces `nudge` from `GET /api/version-check` when non-null (via `MarkdownPreview`); renders nothing when `nudge === null`.
- [x] `GET /api/vaults` returns `{vaults, current}` from the global registry; never 500.
- [x] `PATCH /api/config` strict-pick `{platforms, packs}`; prototype-pollution-safe (body never spread); per-element validation.
- [x] `GET /api/packs` imports from `src/lib/catalog.ts` (not `install-skill.ts`); catalog unreadable → `{packs:[], standalone:[]}` 200.
- [x] `GET /api/version-check` cache-only (no network in request path); read failure → benign payload.
- [x] `dashboard --vault <path|name>` re-roots the server to the chosen vault; invalid vault → non-zero exit + clean message.
- [x] `dashboard/tsconfig.json` has `noImplicitReturns: true`; `App.tsx` switch has explicit cases for `settings` and `packs`.

### About / Landing Page — v0.6 polish (2026-06-06)

**Component layout**: `dashboard/src/components/about/` — 9 self-contained sections. `AboutPage.tsx` composition-only. `AboutPage.css` must set `overflow-x: clip` (not `hidden`) — `hidden` creates a new scroll container which breaks `position: sticky` on descendants (sticky resolves to the wrong ancestor).

**FlowDiagram engine**: `FlowDiagram.tsx` + `FlowDiagram.css`. Types: `FlowNode`, `FlowEdge`, `FlowSpec`, props `{spec, className?, size:'full'|'mini'}`. Gradient IDs via `useId()` — referenced as inline SVG attrs (not CSS) to avoid cross-diagram collisions. Caption auto-wrap: `wrapSub(text, boxW, fontSize)` greedily breaks on ` · ` separators; widths are viewBox units (SVG font-size is user-space). Wire color: `color-mix(in srgb, var(--color-text) 38%, transparent)` — not `var(--color-border)` — so connectors are readable in light and dark.

**CSS Motion Path dots** (replaced stroke-dashoffset): each edge renders a `<circle r="5">` with `offset-path: path(edge.d)` + CSS `@keyframes fd-dot-travel { offset-distance: 0→100% }`. Compositor-class: only the ~14px dot region is dirtied per frame. Glow: per-instance `radial-gradient` fill, rasterized once. `FlowEdge.travel` deprecated/unused. Reduced-motion: dot parked at `offset-distance: 55%` (static, on-path, directional). Measured at 27 simultaneous dots: worst frame 11.2ms, 0 jank/179 frames.

**FeaturesShowcase pinned spotlight**: `FeaturesShowcase.tsx` + `.css`. Sticky `position: sticky; top: 84px`; tall scroll track below. Per-frame imperative scrub writes `opacity` + `translateY` to DOM refs (zero React re-renders per frame; React state only when centred faculty changes for ARIA + rail). Snap-to-nearest on idle: 140ms debounce → `container.scrollTo({behavior:'smooth'})` to nearest faculty centre; `SNAP_EPS = 8px` prevents loop re-entry; skips at track ends (progress ≤0.012 / ≥0.988). Mobile (<860px): track height→auto, sticky→static. Diagram animations run only on `.feat-panel--near` (≤3 from centre), rest paused. Key data: `flow-specs.ts` → `GOAL_SKILL_FLOW` (landscape 520×660 viewBox, ↻≤3 bounded-retry loops: plan-review, code-review, validator).

**Hero copy & sidebar nudge**: Hero headline "The persistent brain for AI natives." with accent gradient on "AI natives"; "Works with Claude Code" pill above install command. Sidebar: `ABOUT_SEEN_STORAGE_KEY = 'dreamcontext.dashboard.aboutSeen'`; `.sidebar-item--nudge` class = accent fill + glow dot + `about-bounce` ±4px keyframe; clears on first click, persists across reloads.

### Knowledge Fullscreen (v0.7, #21 / PR #30)

- `dashboard/src/components/layout/FullscreenOverlay.tsx` — generic, reusable overlay: fixed in-app dialog, document-capture keydown (Esc close + Tab trap with focus pull-back), `FOCUSABLE` selector excluding `:disabled`, focus restore to trigger, body scroll lock with scrollbar-width compensation. `FullscreenOverlay.css` — `:only-child` body rule to win over `.excalidraw-preview` min-height.
- `dashboard/src/pages/KnowledgePage.tsx` — ⛶ expand button next to File/Preview tabs; tab state lifted so it is shared in/out of fullscreen; pane content unmounted while overlay open (single render site).
- `e2e/knowledge-fullscreen.spec.ts` — Playwright coverage (open/close, tabs in overlay, scroll lock, list/search preservation, svg growth).
- Follow-ups deferred by owner: Core-page adoption, single-instance render, shared icon-button class.

### Taxonomy Page (v0.7)

- `dashboard/src/pages/TaxonomyPage.tsx/.css` + `dashboard/src/hooks/useTaxonomy.ts` — facet chip clusters (usage counts), alias arrows, drift/audit panel.
- `GET /api/taxonomy` (read-only): vocabulary + alias-resolved usage tallies + audit buckets. Mutations are CLI-only (`taxonomy add/alias`) — see the tag-taxonomy PRD.

### Sprint-Aware Version Filter (v0.10.0)

- `dashboard/src/components/tasks/VersionFilter.tsx/.css` — sprint-aware multi-select replacing the generic `MultiSelectFilter` for the version facet. Props: `versionItems: VersionItem[]` (joined from task version strings + RELEASES + active-version state), `selected: string[]`, `onChange`. Status icons: star (current), dot (planning), hollow circle (unregistered), check (released). Per-row actions: Set-current (star button → `useSetActiveVersion`), Mark-complete (check button → `useCompleteVersion`). "Current" quick-pick chip at top. Collapsible "Completed sprints" section. Sort order: current → planning → unregistered → backlog → released.
- `dashboard/src/hooks/useVersions.ts` — `useActiveVersion()`, `useSetActiveVersion()`, `useCompleteVersion()` hooks (TanStack Query over `GET/PUT /api/releases/active`).
- `src/lib/active-version.ts` — `getActivePlanningVersion(contextRoot)` reads `state/.active-version.json`, re-validates against RELEASES.json on every read (auto-clears if the stored version is no longer `planning`). `setActivePlanningVersion`, `clearActivePlanningVersion`.
- `src/server/routes/changelog.ts` — `GET/PUT /api/releases/active` registered before the `:version` segment route.

### Version Filter — Smart Semantic Buckets

- `dashboard/src/components/tasks/boardModel.ts`: `VV_CURRENT = '@current'`, `VV_BACKLOG = '@backlog'`, `VV_COMPLETED = '@completed'` sentinel constants; `versionTokenMatches(token, version, versionMeta)` resolves each pseudo-value against live `versionMeta`; `matchVersionField(task, selected, versionMeta)` iterates selected tokens (mix of real version names + virtual tokens); `filterTasks` extended to accept `versionMeta` param.
- `dashboard/src/components/tasks/KanbanBoard.tsx`: builds `versionMeta = { activeVersion, releasedVersions }` from `useActiveVersion()` + RELEASES entries; passes down to `filterTasks`.
- `dashboard/src/components/tasks/BoardToolbar.tsx`: renders Current / Backlog / Completed bucket chips above the literal version list, each gated on applicability; folds literal backlog row out of the rendered version list when `@backlog` chip is active.
- `normFilters()` (in board persistence / view-load path): migration pass that rewrites literal `'backlog'` in `version` array → `'@backlog'` on every saved-view filter load.

### Settings — Cloud Token + Provision (v0.10.0)

- `dashboard/src/pages/SettingsPage.tsx` — extended with a Cloud Provider panel: token-status badge (`GET /api/tasks/token-status`), password input + save for token entry (`POST /api/tasks/token`), dry-run preview panel, and Provision button.
- `src/server/routes/tasks.ts` — `GET /api/tasks/token-status`, `POST /api/tasks/token`, `POST /api/tasks/provision[?dryRun]` handlers; each backend owns its own `tokenStatus()` + token-write path (provider-agnostic server surface).

### Task Override Editor (v0.10.0)

- `dashboard/src/components/settings/TaskOverrideEditor.tsx/.css` — displays the active `overrides/task.md` raw markdown as a **read-only** panel and the parsed custom-field list (name, type, options, sync targets, prompt, required flag, remove button). Settings page has a left-rail section-nav (Platforms / Cloud Tasks / Task Format / Memory / Connections / Sleepy); Task Format section carries a BETA badge and "How the format works" doc link.
- `dashboard/src/components/tasks/AddCustomFieldForm.tsx/.css` — form for adding/editing a field def: name, type (text|number|select|date), options (select only), sync checkboxes, prompt textarea, **Required toggle** (`required: boolean`), **"Ask me" toggle** (`ask: boolean`). Editing pre-populates all fields.
- `dashboard/src/components/tasks/CustomFieldInput.tsx` — type-appropriate input control (text/number/date input or select).
- `dashboard/src/components/tasks/TaskCustomFields.tsx/.css` — renders a task's `custom_fields:` map in `TaskDetailPanel` using `CustomFieldInput`; required fields display a `*` marker.
- `src/server/routes/tasks.ts` — `GET /api/task-overrides`, `GET|PUT /api/task-overrides/doc`, `POST /api/task-overrides/fields` (accepts `required` boolean), `DELETE /api/task-overrides/fields/:key`; all delegate to `src/lib/overrides.ts`.
- `src/lib/overrides.ts` — `loadTaskOverride`, `readTaskOverrideRaw`, `writeTaskOverrideDoc`, `upsertCustomField`, `removeCustomField`, `renderOverrideBriefing` — pure aside from one file read; malformed entries dropped with warnings, never fatal. `upsertCustomField` persists `required` when present.

### Council Page

- [x] CouncilHall: searchable grid of debates with status badge, persona count, round progress indicator
- [x] CouncilDetail: full-page view (back nav + 3 tabs: Overview, Agents, Matrix)
- [x] Overview tab: StatTile row + full final-report as hero with dynamic section parsing
- [x] Agents tab: TranscriptView with search + inline slug chips
- [x] Matrix tab: inline cell expand (no sidebar drawer)
- [x] Backend routes: GET /api/council, /api/council/:id, /api/council/:id/:slug

## Notes

- Bundle size: ~80KB gzipped (React + app). Acceptable for a CLI tool.
- The dashboard reads/writes the same _dream_context/ files as the CLI. No separate database.
- Port 4173 chosen to match Vite preview convention. Configurable with --port flag.
- The server keeps running until Ctrl+C. It does not daemonize.
- Phase 4b complete. Enhanced filters added (status, text search, date range, localStorage persistence). Phase 5 (a11y, responsive, i18n tokens, bundle audit) pending.
- The Visby CF font is commercial. Dashboard uses system font fallback if Visby CF is not installed.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-04 - Live sleep-debt tracker in header (commit 7af88ff)
- **SleepDebtTracker component** (`dashboard/src/components/layout/SleepDebtTracker.tsx/.css`): live animated Sleepy mascot in header showing debt level (alert/drowsy/sleepy/must-sleep) with color-coded bar (green→violet→red), animated eyes (drowsier as debt rises), and localized level label. Mounted in `Header.tsx`. `useSleep.ts` updated with threshold realignment + `SLEEP_DEBT_MAX` constant.

### 2026-07-04 - One-click full-machine upgrade (in progress, sleep-product consolidation)
- `UpdateBadge` now performs the upgrade instead of just nudging: singleton `POST /api/launcher/upgrade` (runs `dreamcontext upgrade --yes` in an interactive login shell) + `GET /api/launcher/upgrade/status` polling + `POST /api/launcher/relaunch` (detached-process relaunch escaping the app's own teardown).
- Badge now shows on `cliOutdated` alone (not just a prose nudge) — matters in the desktop app where the prose CLI line is suppressed.
- Restores an in-flight OR just-finished run on mount so a completed-but-unrelaunched upgrade doesn't reappear as a fresh button and re-trigger.
- Code review (session 236e8894) found and the server-side fix landed: `POST /upgrade`'s response now reflects the real `run.state` instead of hardcoding `running` on a synchronous spawn failure. NOT yet fixed: `UpdateBadge.tsx`'s `applyStatus()` still has no `idle` branch, so a lost server-side run state (restart/crash mid-upgrade) leaves a polling window stuck showing "Upgrading…" forever — tracked as an open AC above.
- Status: in progress (working tree, not yet committed) — no dedicated task tracks this; consider creating one if more upgrade-flow work is planned.

### 2026-06-30 - Timeline Gantt stable drag + polish; multi-assignee AvatarStack on board cards
- **Gantt stable drag-to-reschedule** (`TimelineGantt.tsx`): `updateTask` held in `updateTaskRef` so `pointermove`/`pointerup` window listeners stay referentially stable across react-query re-renders — fixes cursor stuck in grab state when a re-render tore listeners down mid-drag. Pointer events API (not HTML5 DnD). `dragPreview` state provides optimistic bar position during the drag.
- **Gantt UX polish** (`TimelineGantt.tsx/.css`): row height 34→48px, larger bar typography; zoom ladder 10→100px/day; `ResizeObserver` stretches day columns to fill scroll viewport; label column 220→240px; tighter default date range (re-expands after drag commits); legend text "drag a bar to reschedule".
- **Multi-assignee AvatarStack** (`BoardCard.tsx`, part of v0.10.0): `AvatarStack` component renders up to 3 overlapping avatar circles with deterministic per-slug HSL hue (`assigneeHue()`), initials (`assigneeInitials()`), per-badge tooltip, and a `+N` overflow chip (tooltip lists remaining names). Fixes prior single-avatar display on multi-assignee tasks.

### 2026-06-29 - Assignee reading from person:<slug> tags (board filter, group-by, properties, gantt)
- `boardModel`: `taskAssignees()` derives assignees from `person:` tags + legacy scalar fallback; `taskAssignee()` returns primary. `matchAssignee` multi-aware.
- `KanbanBoard`: assignee option list built from all referenced persons in the task set.
- `BoardToolbar`: per-assignee filter counts are multi-aware.
- `TimelineGantt`: row label uses derived assignee, not raw scalar.
- Root cause: task detail panel writes `person:<slug>` tags and retires the scalar, but the board model read only the scalar — tag-only assignees appeared as Unassigned everywhere except the detail panel.

### 2026-06-29 - Version filter smart semantic buckets (@current / @backlog / @completed)
- `boardModel.ts`: added `VV_CURRENT/@current`, `VV_BACKLOG/@backlog`, `VV_COMPLETED/@completed` virtual token constants; `versionTokenMatches`, `matchVersionField`, `filterTasks` extended to resolve tokens against live `versionMeta` (active sprint + released-version set).
- `KanbanBoard.tsx`: builds `versionMeta` from `useActiveVersion()` + RELEASES entries; passes to `filterTasks`.
- `BoardToolbar.tsx`: renders Current / Backlog / Completed bucket chips above the literal version list, gated on applicability; folds literal backlog row into `@backlog` bucket.
- `normFilters()`: migration pass rewrites persisted literal `'backlog'` → `'@backlog'` on saved-view load, preventing ghost filter rows after the UI option folds out.
- Saved views referencing `@current` always track the live active sprint; no stale sprint name stored in view state.

### 2026-06-29 - In-app version rename + delete (shipped v0.10.0)
- `PATCH /api/releases/:version` extended: accepts `{newVersion}` — renames RELEASES.json entry, re-points all tasks via `repointTasksVersion()`, moves active-version pointer; 409 on collision; works on ghost versions (task re-point only).
- `DELETE /api/releases/:version`: removes entry, clears `version:` on referencing tasks (warn-and-clear, tasks never deleted), clears active-version pointer.
- `VersionsPopover.tsx`: every version row now has ✎ rename (inline edit) + 🗑 delete (with task-count confirm dialog).
- `useRenameVersion` + `useDeleteVersion` hooks in `useVersions.ts`. 9 new route tests green.

### 2026-06-28 - Sleep page redesign + Council redesign + board responsive toolbar + UX polish
- Sleep page: mood-driven Sleepy mascot (`getSleepMood(debt)`: awake/drowsy/asleep) with level-tinted aura and Zzz. Sleep cloud + hero merged into one unified card (hairline divider).
- Council page: empty-state with animated 6-persona showcase (FlowDiagram engine), populated-state with dismissible how-it-works banner + LAB badge on nav. `?page=` deeplink in `Shell.tsx`.
- Board toolbar responsive overflow: `ResizeObserver`-driven `⋯ More` collapse; `shell-main { min-width: 0 }` prevents board overflow at any width.
- Kanban drag-flicker fix (WKWebView `relatedTarget=null`): `dragOverKey` cleared only at board-row container level.
- Task context-menu flyout submenus for "Move to status" / "Set priority" (~190px footprint).
- Knowledge subfolder slug fix in `BrainSearch`/`DocContent`: derive slug from `hit.path`, not bare `hit.slug`.
- Page-title `<h1>` headers removed from all remaining pages (Council, Core, Settings, Sleep, Packs, Taxonomy).
- Settings page max-width aligned to `var(--page-max-width)` (was hardcoded 1080px).
- No `In Review` status color: `--color-status-in-review` pointed to `--color-error` (red) for clear visual distinction.

### 2026-06-23 - Sprint-aware version filter + cloud token entry + provision preview + task override/custom-fields UI (v0.10.0)
- `VersionFilter` component replaces the generic MultiSelectFilter for the version facet: sprint-aware with current/planning/unregistered/released status icons, Set-current + Mark-complete per-row actions, "Current" quick-pick, collapsible Completed section, status-aware sort.
- `GET/PUT /api/releases/active` backend; `state/.active-version.json` re-validates against RELEASES.json on every read.
- Settings cloud provider panel: token-status badge, masked token entry (`POST /api/tasks/token` → `.secrets.json`), dry-run provision preview, Provision button.
- `TaskOverrideEditor` in Settings: view/edit `overrides/task.md` body + custom-field CRUD (`AddCustomFieldForm`, per-field remove). `TaskCustomFields` + `CustomFieldInput` in TaskDetailPanel for per-task custom field viewing/editing. Server: `GET /api/task-overrides`, doc GET/PUT, field upsert/remove. Backed by `src/lib/overrides.ts` (pure library, malformed entries never fatal).

### 2026-06-22 - Time-axis task views: Timeline (Gantt), Calendar, Activity heatmap (PR #68, branch feat/task-timeline-calendar-heatmap-views)
- Three new `viewMode`s added to the task board, switchable from the existing TaskFilters toggle and driven by the same filtered task set as Kanban/Eisenhower/RICE/list. New components under `dashboard/src/components/tasks/`: `TimelineGantt`, `TaskCalendar`, `ActivityHeatmap` (+ CSS); wired via `KanbanBoard.tsx` render branches and a `ViewMode` union extension in `TaskFilters.tsx`.
- Timeline/Gantt: status-colored bars spanning created→due with a today rule, overdue outline, adaptive day/week/month ticks, sticky labels (priority dot + assignee), and a collapsible Unscheduled tray for due-less tasks. Calendar: Monday-first month grid, due-date chips with overdue/today states, month nav, due/unscheduled counts. Activity heatmap: GitHub-style 53-week grid with Created/Updated/Completed/Due metric toggle, intensity buckets, and an SR-only daily summary.
- Shared local-time date logic lives in `calendar-utils.ts`; `taskSpan()` reads a not-yet-existing `start_date` via a typed cast so the Gantt auto-upgrades when the date-range backend feature lands (no rework, no coupling) — see knowledge/patterns/forward-compatible-field-cast.md.
- Verified via `tsc -b`, `vite build`, and a live Playwright pass (overdue/today/future tasks, 0 console errors). Multi-reviewer (design + engineering) iterated to PASS; 5 fixes: sparse-data heatmap scaling, after-midnight `goToday`, calendar-valid `dateOf`, SR-only heatmap list, `aria-pressed` toggles. Components are prop-driven and reusable for the planned launcher cross-project task view.

### 2026-06-17 - Excalidraw canvas rendering + embedded image resolution + live refresh (PR #35, branch fix/dashboard-render-and-refresh)
- `ExcalidrawPreview` component switched from `exportToSvg()` static export to live `Excalidraw` canvas (view-mode, lazy-loaded). Boards are crisp at any zoom; native wheel-pan/pinch-zoom. `scrollToContent` called on mount + 100ms timer + ResizeObserver for reliable fit-and-center.
- New `GET /api/knowledge-assets/:slug` server route: resolves Obsidian `## Embedded Files` SHA1→path map, reads and down-scales images to WebP via sharp (mtime-cached, containment-guarded). Dashboard merges resolved files into scene before canvas mount so board screenshots render.
- SQL fence-concat fallback: multi-fence SQL files are joined before SqlPreview to fix partial rendering.
- Live-refresh button added to Header: `queryClient.invalidateQueries()` for active page — no full page reload.
- Nested diagram tree (PR companion, commit e110d9f): KnowledgePage renders knowledge/diagrams as recursive nested folder tree; build-all.mjs glob-based board resolution; generator require() depths fixed. 1978 tests green; dashboard + CLI builds green.

### 2026-06-12 - Knowledge fullscreen (#21/PR #30) + Taxonomy page + nested excalidraw grouping (#20)
- Generic `FullscreenOverlay` (in-app fixed dialog, not browser Fullscreen API): Esc + close button, document-capture keydown, focus trap excluding disabled elements, focus restore, body scroll lock with scrollbar-width compensation; hardened from review (capture listener, `:not(:disabled)`, `:only-child` CSS specificity).
- ⛶ expand on KnowledgePage covering markdown, SQL/ER, excalidraw, raw views; shared File/Preview tab state; single render site (doc never mounted twice). e2e: `knowledge-fullscreen.spec.ts`.
- Taxonomy page (facet chips, usage counts, alias arrows, audit panel) backed by read-only `GET /api/taxonomy`.
- Nested `diagrams/{title}/` boards group under Diagrams with basename leaf labels (#20 dashboard slice).

### 2026-06-09 - Eisenhower matrix drag & drop (#7) + SQL syntax highlighting in Knowledge view (#12)
- Eisenhower Matrix: tasks are now draggable between quadrants; drop updates both `priority` and `urgency` frontmatter fields via PATCH API. Implemented with native HTML5 drag-and-drop on `EisenhowerMatrix.tsx`; new `eisenhower.ts` util handles quadrant-to-field mapping.
- `MarkdownPreview`: SQL and code fences rendered with highlight.js (synchronous, small footprint, SQL grammar). Light/dark themes wired to `ThemeContext`. DOMPurify allowlist extended for `<span class="hljs-*">` output.
- Data-structures no longer shown under Core — moved to Knowledge view (follows `knowledge/data-structures/` canonical location from #12 migration).
- Full suite 1219 tests green.

### 2026-06-06 - Landing page v2 polish: scroll-scrubbed spotlight + Motion Path animation + hero copy
- "One brain, many faculties" features showcase rewritten as a pinned scroll-scrubbed spotlight (11 faculty panels, sticky header+stage, imperative scrub on refs, snap-to-nearest on idle).
- goal-skill promoted to flagship faculty with a landscape loop diagram (planner→plan-review↻→validator↻→shipped, ↻≤3 bounded retries per stage).
- FlowDiagram animation engine: stroke-dashoffset replaced with CSS Motion Path dots (offset-path + offset-distance); compositor-class, 0 jank at 27 simultaneous dots. Caption auto-wrap (wrapSub) so no text overflows boxes. Wire contrast fix (color-mix vs color-border).
- overflow-x: clip on .about fixes sticky behaviour (hidden was creating a scroll container and pinning sticky descendants to the wrong ancestor).
- Hero copy: "The persistent brain for AI natives." + "Works with Claude Code" pill.
- Sidebar "What is this?" nudge: accent fill + bounce animation until first click; localStorage flag retires it permanently.

### 2026-06-05 - Dashboard alignment + responsive fix
- Root cause: fixed 220px sidebar, no media queries → clipping at tablet/narrow.
- Added responsive CSS breakpoints (sidebar collapse + shell flex at 768px, 390px).
- 11 Playwright alignment tests green; full vitest suite green (1111+).

### 2026-06-04 - Landing page v2: About page rebuilt (9 sections, FlowDiagram engine)
- AboutPage rebuilt as 9 section components under `dashboard/src/components/about/`.
- FlowDiagram engine: instance-unique gradient IDs via useId(), inline SVG attrs, comet animation, reduced-motion guard.
- Hero: logo+wordmark + looping brain video (webm+mp4+poster).
- How-it-works: real 8-category diagram incl. RemSleep multi-agent node.
- Sleep flow + recall flow sub-sections; cortical-stack architecture; live usePacks() marquee; 26 collapsible feature cards.
- Built via goal-skill: 7 parallel opus implementers across 3 waves; reviewer + validator PASS.
- Build clean, tsc clean, light + dark screenshots pass (e2e/shots/).

### 2026-06-01 - v0.6 Control Panel: Settings, Packs, UpdateBadge, --vault (slices 1-2)
- Backend control-plane: `GET/PATCH /api/config`, `GET /api/packs`, `GET /api/version-check`, `GET /api/vaults` added to server.
- `src/lib/catalog.ts` extracted from `install-skill.ts` to keep `@inquirer/prompts` out of server bundle.
- `src/lib/vaults.ts` global vault registry + `resolveVaultContextRoot`; `vaults add/list/remove` CLI; `dashboard --vault` flag.
- Settings page (platforms checkboxes + packs toggles + read-only Vaults subsection), Packs page, UpdateBadge header component wired.
- 4 TanStack Query hooks: `useConfig`, `usePacks`, `useVersionCheck`, `useVaults`.
- `App.tsx` + `Shell.tsx` + `Sidebar.tsx` extended for `settings`/`packs` routes; `noImplicitReturns: true` added to `dashboard/tsconfig.json`.
- All safeChildPath guards applied to 7 route handlers; full suite: 962 tests green.

### 2026-05-23 - Brain 3D view toggle (v0.4)
- `BrainCanvas3D` component added: `react-force-graph-3d` + `three`-powered renderer, lazy-loaded as a separate Vite chunk.
- Billboard sprite labels (THREE.Sprite / CanvasTexture) always face camera, positioned below node sphere, opacity-dimmed on hover.
- Scene fog (`THREE.Fog 320–1100`) provides near/far depth perception; SpriteMaterial.fog=true ties label fade to scene fog.
- Click → camera fly-to: `cameraPosition()` over 900 ms moves camera along node's radial vector to 90-unit close distance.
- View toggle (`2d` | `3d`) persisted to `brain:settings:v1` localStorage; old state without `view` falls back to `'2d'`.
- `BrainSettings` extended with `SegmentedRow` component and View row at top of Display section.

### 2026-05-22 - v0.4 Dashboard: Flowchart-AC Sync + Design System + Bug Fixes
- Flowchart-to-acceptance-criteria sync: `<!-- node:<id> -->` markers bind mermaid nodes to checkboxes (bidirectional pending; checkbox→node live).
- Race-safe rapid checkbox toggles via `pendingBodyRef` pattern; failure reverts to `bodySourceRef`.
- Server PATCH body limit raised to 1 MB; `---` separator sanitization added.
- Mermaid edge-line corruption fix: EDGE_OPS_RE guard skips operator lines during node-class injection.
- Linear Midnight design system overhaul: Neon Lime accent, Inter Variable font, flat surfaces (glassmorphism removed), layered dark palette. Additive and non-breaking — old brand variables preserved.
- Filter persistence projectId hydration timing fix: filters no longer reset on page reload when projectId hydrates asynchronously.

### 2026-04-19 - Council UI + Brain Light Mode
- Council page: CouncilHall (searchable card grid) + CouncilDetail (back nav + Overview/Agents/Matrix tabs). Overview = dynamic final-report rendering. Agents = searchable TranscriptView with persona slug chips. Matrix = inline cell expand. Backend routes added. 3 UI iterations to reach accepted design (v1 gamified rejected, v2 report-buried rejected, v3 accepted).
- Brain graph light mode: theme-aware node color palettes (dark/light variants), link/canvas colors switch on isDark. Deeper light palette (#0d7bb8, #047857, #b45309, #6d28d9, #be185d, #475569).

### 2026-03-07 - in_review Status + Explore Agent Improvements
- Added in_review as 4th task status (workflow: todo->in_progress->in_review->completed)
- Kanban 4th column with purple color; in-review tasks included in snapshot, default tasks list, Eisenhower Matrix
- CLI, server validation, dashboard (Kanban column, TaskFilters, TaskDetailPanel, I18n), SQL schema updated
- 469 tests passing

### 2026-03-07 - Dashboard Phase 4c + Versions-as-Releases Unification
- Eisenhower Matrix view: 2×2 priority×urgency grid, excludes completed tasks, quadrant color tokens
- MultiSelectFilter: checkbox-based multi-select with type-ahead search (appears when >5 options), All/None toggle
- SubGroupSection: collapsible nested sections within Kanban columns (chevron, dot, label, count)
- urgency field (critical/high/medium/low, default medium) and version field added to tasks (CLI + API + UI)
- Group-by-urgency, group-by-version, group-by-tags (tasks appear in each applicable tag column)
- Versions unified with Releases: VERSIONS.json deleted, ReleaseEntry extended with status field (planning|released, backward compat)
- VersionManager redesigned: 680px modal, stats header, planning/released sections, Release button
- CLI: core releases add --status planning; Snapshot: Upcoming Versions section for planning entries
- File/Preview tabs: Core, Knowledge, Features pages all have MarkdownPreview + JsonPreview components
- Task slug extraction regex tightened (false positive fix — now anchored to JSON keys only)
- 468 tests passing

### 2026-02-27 - Project-Scoped localStorage + Zoom Controls + SubagentStart Fix
- Project-scoped localStorage: usePersistedState keys scoped by project hash (dreamcontext:{projectId}:{key}); legacy keys auto-migrated; theme remains global
- Zoom controls: 5 levels (85%-120%), persists globally, applied before React hydrates to prevent flash; font-size tokens use calc() with --zoom CSS var
- SubagentStart root cause analysis: additionalContext is lower priority than sub-agent system prompt; fixed by updating SKILL.md to make main agent smarter about delegation (include _dream_context/ paths in prompts)
- SubagentStart directive: IMPORTANT -> MANDATORY, named Glob/Grep, added actionable decision rule; feature format cleaned up
- sleep_history extracted to .sleep-history.json (separate file, auto-migrated on first read)
- 386 tests passing

### 2026-02-27 - Notion-Style TaskDetailPanel + Tool Count Scoring
- TaskDetailPanel redesigned: properties block (Notion-style bordered card) at top, full markdown body below via marked@^15
- Panel widened 520px → 680px; `.props-block`/`.prop-row` CSS grid (140px label / 1fr value)
- ExpandableText component: 3-line clamp with requestAnimationFrame detection, click to expand/collapse
- `body: string` field added to TaskData API response (from readFrontmatter content); backward compat maintained
- Added `marked@^15` to dashboard/package.json (~14KB gzipped, zero transitive deps)
- Tool count debt scoring: `scoreFromToolCount` added, session score = Math.max(change score, tool score)
- 336 tests passing

### 2026-02-26 - Update
- SQL parser rewrite + SubagentStart briefing restructure: fixed sql-parser.ts line-by-line parsing, added REFERENCES FK detection and JSONB sub-field collapsible groups in SqlPreview. Restructured SubagentStart briefing with directive at top to prevent sub-agents ignoring context files. 325 tests passing.
### 2026-02-26 - Enhanced Task Filters
- Status filter dropdown, text search (name+description), date range with field selector (created_at/updated_at)
- Filter state persisted via usePersistedState hook (localStorage prefix: dreamcontext:)
- Clear Filters button with active-count badge; preserves sortField and groupBy on clear

### 2026-02-26 - UI Polish + Bug Fix
- Fixed selectedTask stale snapshot: selectedSlug string + useMemo derivation from live TanStack Query data
- Animated brand gradient background with subtle-pulse, stagger entrance animations for Kanban columns
- CSS refinements: Header, Sidebar, Shell, KanbanColumn, TaskCard, TaskCreateModal, TaskDetailPanel, TaskFilters, CorePage, FeaturesPage, SleepPage, tokens
- Release discovery UI connected: releases list/show/add from dashboard API

### 2026-02-25 - Phase 4 Polish
- Error handling: ErrorBoundary, res.ok checks, mutation error feedback with auto-dismiss
- Field-level change tracking: FieldChange interface, net-change detection/folding, 19 new tests
- SQL ER diagram: sql-parser.ts, SqlPreview component with SVG bezier relationship lines, File/Preview tab toggle
- Server hardening: 1MB body size limit, graceful shutdown (SIGINT/SIGTERM), 30s socket timeout

### 2026-02-25 - Phase 1-4 Implementation
- Built complete server infrastructure: HTTP server, router, middleware, static file serving, 17 REST API endpoints
- Built change tracking: dashboard_changes array in .sleep.json, recorded on every mutating API call
- Built full React dashboard: Kanban board with drag-and-drop, filtering, sorting, grouping
- Built task CRUD: create modal, detail panel with status/priority editing, changelog entries
- Built sleep page: debt gauge, session history, dashboard changes timeline
- Built core file viewer/editor: file list, markdown split-pane editor with live preview
- Built knowledge page: search, pin/unpin, content viewer
- Built features page: list with status badges, full PRD section viewer
- Built design system: purple-magenta brand tokens, light/dark mode, 4px grid, HSL colors
- Built i18n infrastructure: English translations, t() function, ready for more languages
- Extended SleepState interface with dashboard_changes, updated sleep done to clear it
- Updated build pipeline: build:dashboard + build:cli, tsup copies dashboard output
- All 258 tests passing

### 2026-02-25 - Created
- Feature PRD created.
