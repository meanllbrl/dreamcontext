---
id: know_task_override_custom_fields
type: knowledge
name: decision-task-format-override-and-custom-fields
description: "Why and how dreamcontext added per-project task format overrides and custom fields: brain-based discovery, file-presence zero-regression, agent briefing integration, per-backend sync mapping, required flag hard-fail, and ask-before-create for human-judgment fields."
tags:
  - decisions
  - architecture
  - topic:task-backend
  - backend
  - topic:cli
created: '2026-06-23'
updated: '2026-06-23'
pinned: false
---

# Decision: Per-Project Task Format Override and Custom Fields

## Why this exists

Projects that use dreamcontext for task tracking often need domain-specific data attached to every task (e.g. a sprint goal, a complexity score, a business vertical tag). The shipped task model covers generic agile attributes (priority, urgency, RICE, dates, assignees) but has no first-class extension point. Before v0.10.0, a project had two bad options: (a) abuse free-text tags, losing type safety and sync; or (b) fork the shipped CLI templates, losing upgrade safety.

The override system gives every project a **first-class, upgrade-safe, agent-aware extension point** for declaring additional fields and, optionally, a custom task template.

## The design

**File:** `_dream_context/overrides/task.md` — inside the brain, versioned with the project, never touched by `dreamcontext update`.

**Discovery:** purely by file presence. Absent file → every consumer is byte-identical to shipped defaults (zero-regression invariant). No config flag, no migration, no setup step required.

**Shape:** YAML frontmatter (`custom_fields:` list) + optional body (scaffold template + optional `## Agent Instructions` block).

**Custom field def:** `name`, `key` (defaults to snake_case of name), `type` (text|number|select|date), `options` (select only), `sync` (clickup|github, defaults to both), `prompt` (agent instructions for filling this field).

**Implementation:** `src/lib/overrides.ts` — pure module (no network, no writes except `writeTaskOverrideDoc`/`upsertCustomField`/`removeCustomField`). `loadTaskOverride()` parses + validates; malformed entries are dropped with `warnings[]` — never thrown, never fatal. gray-matter's string-interned parse cache is **cloned** before mutation in `upsertCustomField` to prevent cache poisoning across successive calls on the same serialized string.

## Key architectural decisions

**1. Brain-based location (`overrides/`, not `.claude/` or config)**
Overrides live in `_dream_context/overrides/` so they travel with the project and survive `dreamcontext update`. `.claude/` is the installed-skill surface (overwritten on update); `.config.json` is for platform/pack settings, not schema. The brain is the right home: it is versioned, human-readable, and already the single source of truth for project shape.

**2. File-presence discovery = zero-regression**
No opt-in flag, no migration: the CLI checks `existsSync(taskOverridePath(contextRoot))` and only activates the override path if the file is present. Existing projects without the file are provably unaffected.

**3. Agent briefing injection (`renderOverrideBriefing`)**
Soul/user/memory body text is NOT inlined into sub-agent context (only listed). A format rule written in `1.user.md` is invisible to `sleep-tasks`. The override briefing is injected via `generateSubagentBriefing()` into both the main-agent SessionStart snapshot and every sub-agent SubagentStart briefing. This is the lever that makes overrides reach all agents reliably — same mechanism that surfaces pinned knowledge.

**4. Per-backend sync mapping**
- **ClickUp:** `select` → native `drop_down` list custom field (provisioned by name, reuses existing fields by folded-name match in `buildSpecs`/`matchCustomFields`); `number` → number field; `text`/`date` → `short_text` field. User fields that collide with built-in ClickUp bridge keys (urgency, description, rice fields, version, etc.) are silently dropped — the built-in wins, preventing double-binding.
- **GitHub:** `select` → `key:value` label (same namespace as priority/tags/version labels); all others → `<!-- dc:fields -->` body block (composed above prose on push, parsed + stripped before 3-way prose merge on pull — same pattern as `<!-- dc:dates -->`).
- A field can target one or both backends via its `sync:` list. `customFieldsFor(defs, target)` filters the list at push/pull time.

**5. Non-fatal validation**
A broken override must never block task creation or a sync. `loadTaskOverride()` collects all violations into `warnings[]` and drops the offending entries; the returned `customFields` array always contains only valid, usable defs. `dreamcontext doctor` surfaces the warnings; API responses include them.

## v0.10.0 additions (same sprint, same branch)

### 6. Required flag on custom fields

`CustomFieldDef` accepts `required?: boolean`. When set, `checkRequiredFields(task, override)` — a pure helper — gates `tasks create`, `tasks complete`, and `tasks status … completed|in_review`. On failure: exit code 1, descriptive error listing the unset fields. The action is refused; the task file is not mutated.

**Why hard-fail and not warn?** Advisory-only briefing (the snapshot's `⚠ UNSET` annotation) works for active sessions that read the snapshot carefully, but stale sessions — where the agent jumped straight to completing a task without re-reading the briefing — would silently create malformed records. A hard-fail at the CLI gate is the only lever that works regardless of whether the agent read the briefing.

**Why not enforce in the dashboard create flow?** The dashboard is used for quick draft entry; blocking on required fields would break the workflow of creating skeleton tasks first and filling fields later. Dashboard shows a visual `*` indicator and warning but does not hard-fail. The invariant is enforced at the CLI level where done-state transitions happen.

**Draft escape:** `--allow-missing-required` flag or `DREAMCONTEXT_ALLOW_MISSING_REQUIRED=1` env var. This allows automation pipelines or seed scripts to create skeleton tasks before the required data is known. The escape is intentional and named (not a silent bypass).

**Blast radius:** CLI command paths only (`tasks.ts`). Backend adapters (local/ClickUp/GitHub), the server PATCH route, and the dashboard create endpoint are unaffected — they operate on whatever frontmatter they receive.

### 7. Two-part agent visibility lever

Required field state is visible to agents via two complementary surfaces:

1. **Snapshot Active Tasks block** — `Custom fields: key=value / key=⚠ UNSET (required)` rendered per task when an override is active. Fires at every session start, so an agent beginning work on a task sees field state immediately without opening the task file.

2. **`tasks list --long`** — emits `TaskRecord.custom_fields` in the per-task line. Scriptable surface; allows sub-agents and automation to query field state without file I/O.

The two surfaces are complementary: the snapshot is the zero-tool-call path; `--long` is the programmable path. Neither alone is sufficient (the snapshot doesn't support filtering; `--long` requires a tool call).

### 8. Dashboard override editor

The override markdown panel in Settings is **read-only** (not an editable textarea). Rationale: direct YAML/markdown editing bypasses the `upsertCustomField` validation path (key dedup, type checking, required flag), and gray-matter cache poisoning is already a known footgun. The structured `AddCustomFieldForm` (which passes `required` via `POST /api/task-overrides/fields`) is the canonical edit surface. Raw file editing remains a CLI / text-editor operation.

The Settings page gained a left-rail section-nav (Platforms / Cloud Tasks / Task Format / Memory / Connections / Sleepy). Task Format is above Sleepy because it relates to the task model (adjacent to Cloud Tasks conceptually). BETA badge signals the schema is still evolving.

### 9. `ask: true` — ask-before-create for human-judgment fields

`CustomFieldDef` accepts `ask?: boolean`. When set on a field, the agent is instructed to **ask the user for the value at interactive task-creation time** rather than fabricating it. This is the complement to `required`: `required` enforces that a value is present before done-state transitions; `ask` captures *whose* judgment fills the field — the user's, not the agent's.

**Why a separate flag instead of using `prompt`?** The `prompt` field already gives agents instructions on HOW to fill a value. But `prompt` alone cannot prevent an agent from filling it autonomously (possibly wrong) in a no-user-context (autonomous reconcile / sleep). The `ask` flag adds a **hard behavioral rule** to the override briefing: the agent must never invent an `ask`-flagged value — it asks first when a user is present, and leaves the field unset (with a note) in no-user contexts (sleep, autonomous reconcile). This prevents agents from satisfying a `required` gate by inventing a number.

**Agent briefing surface:** `renderOverrideBriefing()` tags `ask` fields as `[ASK THE USER]` in the emitted briefing text and appends an `ASK-FIRST:` rule block at the end of the briefing (if any `ask` fields exist). The rule reads: "capture a HUMAN judgment — do NOT make up a value. When creating a task on the user's request, ASK the user for each `ask` field BEFORE creating the task." This fires at every SessionStart and sub-agent SubagentStart.

**Implementation:** `src/lib/overrides.ts` — `ask` is parsed in `loadTaskOverride()` alongside `required`; `upsertCustomField()` persists `ask: true` when the input carries it. `renderOverrideBriefing()` produces the `[ASK THE USER]` annotations and the rule block. Dashboard: `AddCustomFieldForm` has an "Ask me" toggle adjacent to the Required toggle; the field def is sent via `POST /api/task-overrides/fields` with `ask: true`; `useTasks.ts` types carry `ask`. No CLI hard-fail was added for `ask` fields (there is nothing to enforce at the CLI gate — the value may legitimately be left unset in no-user contexts, unlike `required`).

**Canonical example (from the real override in this project):**
```yaml
custom_fields:
  - name: Time estimate
    key: time_estimate
    type: text
    required: true
    ask: true
    prompt: "How long will this take? Answer in ClickUp shorthand, e.g. 45m, 2h 30m, 1w 2d."
```
The field is simultaneously `required` (no done-state transition without a value) and `ask` (agent asks the user, never invents). In sleep/autonomous mode the agent leaves it unset and notes it rather than guessing.

## What is NOT in scope (v0.10.0)

- **Feature/knowledge format overrides:** the override file currently only covers tasks. Feature and knowledge format overrides are tracked in `state/per-project-format-rule-overrides-for-specialist-agents-task-feature-knowledge.md` (the general override framework issue) but are deferred.
- **Per-agent policy overrides** (status rules, tagging strictness): deferred to the same general framework.
- **GitHub Projects v2 GraphQL custom fields** for native status-field fidelity: deferred (see `knowledge/decisions/decision-github-task-backend.md`).

## Sources

- `src/lib/overrides.ts` — primary implementation
- `src/lib/task-backend/clickup-fields.ts` — ClickUp bridge (`buildSpecs`, `matchCustomFields`, `userProvisionDefs`)
- `src/lib/task-backend/github-map.ts` — GitHub `<!-- dc:fields -->` block
- `_dream_context/core/features/task-management.md` — feature PRD (source of truth for what the capability IS)
- Task: `state/per-project-format-rule-overrides-for-specialist-agents-task-feature-knowledge.md`

## Last verified

2026-06-23 — updated to capture the `ask: true` flag (ask-before-create for human-judgment fields), shipped in the same v0.10.0 sprint. The `ask` + `required` combination is the canonical pattern for fields that must be present at done time but whose value is a human judgment (e.g. time estimate). Also previously captured: `required` flag, hard-fail enforcement, two-part agent visibility, draft escape, dashboard read-only override editor.
