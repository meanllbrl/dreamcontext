import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';

/**
 * Project-local task format & custom-field overrides (task_dlhc0fFQ).
 *
 * A project shadows the shipped task shape by dropping
 * `_dream_context/overrides/task.md` into its brain. The file carries two
 * things at once:
 *
 *  - FRONTMATTER `custom_fields:` — a user-defined field schema. These fields
 *    sync to ClickUp (native list custom fields) and GitHub (`<select>` →
 *    `key:value` label, everything else → a `<!-- dc:fields -->` body block),
 *    reusing a remote field/label that already exists BY NAME rather than
 *    creating a duplicate.
 *  - BODY — the task template the CLI scaffolds from, plus an optional
 *    `## Agent Instructions` section that sub-agents read at runtime (and which
 *    is stripped from scaffolded tasks — it is meta, not per-task content).
 *
 * Discovery is purely by file presence: absent the file, every consumer is
 * byte-identical to the shipped defaults (zero-regression for existing
 * projects). The override lives INSIDE the brain, so it survives
 * `dreamcontext update` and travels with the project. A malformed override is
 * surfaced as warnings (by `dreamcontext doctor`) — never silently ignored,
 * and never fatal to task creation or sync.
 *
 * Pure module aside from reading the one file: no network, no writes.
 */

export type CustomFieldType = 'text' | 'number' | 'select' | 'date';
export type SyncTarget = 'clickup' | 'github';

export interface CustomFieldDef {
  /** Field name exactly as declared — drives the remote folded-name match. */
  name: string;
  /**
   * Stable local key / field id: the `custom_fields:` map key (and the GitHub
   * label namespace). Defaults to the snake_case of `name`, but may be set
   * explicitly so a renamed field keeps the same id.
   */
  key: string;
  type: CustomFieldType;
  /**
   * Whether the agent MUST set this field on every task (true) or MAY leave it
   * empty (false, the default). Required fields are flagged in the agent
   * briefing and surfaced as "missing" wherever a task is shown.
   */
  required: boolean;
  /** Allowed values for a `select` field (ClickUp drop_down options). */
  options?: string[];
  /** Backends this field targets. Defaults to BOTH when unspecified. */
  sync: SyncTarget[];
  /**
   * System prompt telling the agent HOW to determine this field's value for a
   * task. Surfaced to the main agent (SessionStart snapshot) and every
   * sub-agent (briefing), so Claude fills the field consistently.
   */
  prompt?: string;
  /**
   * Whether this field captures a HUMAN judgment the agent must NOT fabricate
   * (e.g. a time estimate, a business-impact call). When true, the agent asks
   * the user for the value during interactive task creation — using `prompt`
   * as the question framing — instead of inferring it. In a no-user context
   * (autonomous reconcile / sleep) it leaves the field unset and flags it.
   */
  ask?: boolean;
}

/** Structured input for adding/updating a field def from the dashboard. */
export interface CustomFieldDefInput {
  name: string;
  /** Explicit field id; defaults to the snake_case of `name`. */
  key?: string;
  type: CustomFieldType;
  required?: boolean;
  options?: string[];
  sync?: SyncTarget[];
  prompt?: string;
  ask?: boolean;
}

export interface TaskOverride {
  /** Scaffold-ready template body (Agent-Instructions section removed), or null. */
  template: string | null;
  /** The `## Agent Instructions` prose sub-agents follow, or null. */
  agentInstructions: string | null;
  /** Declared custom fields (validated; malformed entries dropped → warnings). */
  customFields: CustomFieldDef[];
  /** Non-fatal validation warnings — surfaced by doctor, never silently dropped. */
  warnings: string[];
}

const FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'select', 'date'];
/** The canonical remote sync targets. Lives here (a provider-aware lib module)
 * so callers like the server route can stay provider-agnostic — see the boundary
 * test in tests/unit/task-backend.test.ts. */
export const SYNC_TARGETS: SyncTarget[] = ['clickup', 'github'];

/** Absolute path to a project's task override file. */
export function taskOverridePath(contextRoot: string): string {
  return join(contextRoot, 'overrides', 'task.md');
}

/** Whether a project ships a task override. */
export function hasTaskOverride(contextRoot: string): boolean {
  return existsSync(taskOverridePath(contextRoot));
}

/** snake_case ascii key form of a field name (the local + GitHub-label key). */
export function fieldKey(name: string): string {
  return String(name)
    .replace(/ı/g, 'i').replace(/İ/g, 'i')
    .replace(/ş/g, 's').replace(/Ş/g, 's')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'g')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Load + validate a project's task override. Returns null when absent.
 * Malformed `custom_fields` entries are dropped with a warning rather than
 * thrown — a broken override must never break task creation or a sync.
 */
export function loadTaskOverride(contextRoot: string): TaskOverride | null {
  const path = taskOverridePath(contextRoot);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  const warnings: string[] = [];
  let data: Record<string, unknown> = {};
  let body = '';
  try {
    const parsed = matter(raw);
    data = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content ?? '';
  } catch (err) {
    return {
      template: null,
      agentInstructions: null,
      customFields: [],
      warnings: [`overrides/task.md: malformed frontmatter (${(err as Error).message ?? err})`],
    };
  }

  const customFields = parseCustomFields(data.custom_fields, warnings);
  const { template, agentInstructions } = splitTemplate(body);
  return { template, agentInstructions, customFields, warnings };
}

/** Split the override body into the scaffold template and the agent-instructions prose. */
function splitTemplate(body: string): { template: string | null; agentInstructions: string | null } {
  if (!body.trim()) return { template: null, agentInstructions: null };
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => /^#{1,3}\s+agent\s+instructions\s*$/i.test(l.trim()));
  if (idx === -1) return { template: body, agentInstructions: null };
  const template = lines.slice(0, idx).join('\n').trimEnd() + '\n';
  const agentInstructions = lines.slice(idx + 1).join('\n').trim() || null;
  return { template: template.trim() ? template : null, agentInstructions };
}

function parseCustomFields(raw: unknown, warnings: string[]): CustomFieldDef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push('overrides/task.md: `custom_fields` must be a list — ignored.');
    return [];
  }

  const out: CustomFieldDef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      warnings.push('overrides/task.md: a custom_fields entry is not an object — skipped.');
      continue;
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!name) {
      warnings.push('overrides/task.md: a custom_fields entry has no `name` — skipped.');
      continue;
    }
    const type = (typeof e.type === 'string' ? e.type.trim().toLowerCase() : 'text') as CustomFieldType;
    if (!FIELD_TYPES.includes(type)) {
      warnings.push(
        `overrides/task.md: field "${name}" has unknown type "${String(e.type)}" ` +
          `(use ${FIELD_TYPES.join(' | ')}) — skipped.`,
      );
      continue;
    }
    // Explicit `key` (the field id) wins; otherwise derive from the name.
    const key = typeof e.key === 'string' && e.key.trim() ? fieldKey(e.key) : fieldKey(name);
    if (!key) {
      warnings.push(`overrides/task.md: field "${name}" yields no usable key — skipped.`);
      continue;
    }
    if (seen.has(key)) {
      warnings.push(`overrides/task.md: duplicate field key "${key}" (from "${name}") — skipped.`);
      continue;
    }
    seen.add(key);

    const options = Array.isArray(e.options)
      ? e.options.map((o) => String(o)).filter((o) => o.trim() !== '')
      : undefined;
    if (type === 'select' && (!options || options.length === 0)) {
      warnings.push(`overrides/task.md: select field "${name}" has no options — values won't be constrained.`);
    }

    let sync = Array.isArray(e.sync)
      ? e.sync
          .map((s) => String(s).trim().toLowerCase())
          .filter((s): s is SyncTarget => (SYNC_TARGETS as string[]).includes(s))
      : SYNC_TARGETS.slice();
    if (sync.length === 0) sync = SYNC_TARGETS.slice();

    const prompt = typeof e.prompt === 'string' && e.prompt.trim() ? e.prompt.trim() : undefined;
    const required = e.required === true || e.required === 'true';
    const ask = e.ask === true || e.ask === 'true';

    out.push({ name, key, type, required, ...(options ? { options } : {}), sync, ...(prompt ? { prompt } : {}), ...(ask ? { ask } : {}) });
  }
  return out;
}

/** Custom-field defs that target a given backend. */
export function customFieldsFor(defs: CustomFieldDef[], target: SyncTarget): CustomFieldDef[] {
  return defs.filter((d) => d.sync.includes(target));
}

/** Raw override markdown (empty string when absent) — for the dashboard editor. */
export function readTaskOverrideRaw(contextRoot: string): string {
  const path = taskOverridePath(contextRoot);
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

/** Write the override markdown verbatim (creating overrides/ if needed). */
export function writeTaskOverrideDoc(contextRoot: string, raw: string): TaskOverride | null {
  const path = taskOverridePath(contextRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw, 'utf-8');
  return loadTaskOverride(contextRoot);
}

/**
 * Add or replace ONE custom-field definition (matched by field id/key),
 * preserving the override body. Creates the file (frontmatter-only) when none
 * exists — the task format then stays the shipped default until a body is
 * added. Returns the reloaded override.
 */
export function upsertCustomField(contextRoot: string, input: CustomFieldDefInput): TaskOverride {
  const path = taskOverridePath(contextRoot);
  let data: Record<string, unknown> = {};
  let body = '';
  if (existsSync(path)) {
    const parsed = matter(readFileSync(path, 'utf-8'));
    // gray-matter caches parsed objects by string content; clone so mutating
    // the field list never corrupts that shared cache (a later reload of an
    // identical string would otherwise return our mutated array).
    data = structuredClone(parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content ?? '';
  }

  const key = input.key && input.key.trim() ? fieldKey(input.key) : fieldKey(input.name);
  const entry: Record<string, unknown> = { name: input.name.trim(), key, type: input.type };
  if (input.required) entry.required = true;
  if (input.options && input.options.length > 0) entry.options = input.options;
  entry.sync = input.sync && input.sync.length > 0 ? input.sync : SYNC_TARGETS.slice();
  if (input.prompt && input.prompt.trim()) entry.prompt = input.prompt.trim();
  if (input.ask) entry.ask = true;

  const list = Array.isArray(data.custom_fields)
    ? (data.custom_fields as Record<string, unknown>[])
    : [];
  const idxOf = (f: Record<string, unknown>): string =>
    fieldKey(String(f.key ?? f.name ?? ''));
  const existingIdx = list.findIndex((f) => idxOf(f) === key);
  if (existingIdx >= 0) list[existingIdx] = entry;
  else list.push(entry);
  data.custom_fields = list;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, matter.stringify(body, data), 'utf-8');
  return loadTaskOverride(contextRoot)!;
}

/** Remove a custom-field definition by id/key. Returns the reloaded override. */
export function removeCustomField(contextRoot: string, key: string): TaskOverride | null {
  const path = taskOverridePath(contextRoot);
  if (!existsSync(path)) return null;
  const parsed = matter(readFileSync(path, 'utf-8'));
  // Clone — gray-matter hands back a CACHED object; mutating it would poison the
  // cache for identical strings (see upsertCustomField).
  const data = structuredClone(parsed.data ?? {}) as Record<string, unknown>;
  const target = fieldKey(key);
  const list = Array.isArray(data.custom_fields)
    ? (data.custom_fields as Record<string, unknown>[])
    : [];
  data.custom_fields = list.filter((f) => fieldKey(String(f.key ?? f.name ?? '')) !== target);
  writeFileSync(path, matter.stringify(parsed.content ?? '', data), 'utf-8');
  return loadTaskOverride(contextRoot);
}

/**
 * Agent-facing briefing for an active override — shared by the SessionStart
 * snapshot (main agent) and the sub-agent briefing so BOTH honor the project's
 * task format, fill every custom field per its prompt, and never drift.
 */
export function renderOverrideBriefing(ov: TaskOverride): string {
  const lines: string[] = [];
  lines.push('This project OVERRIDES the default task shape via `_dream_context/overrides/task.md`.');
  lines.push('When you CREATE or RECONCILE a task, follow THAT file — its section layout and its');
  lines.push('`## Agent Instructions` — not the defaults, and set the custom fields below.');
  if (ov.customFields.length > 0) {
    const required = ov.customFields.filter((f) => f.required);
    lines.push('');
    lines.push('**This project defines custom fields on EVERY task.** They live in the task\'s `custom_fields:`');
    lines.push('frontmatter, sync to ClickUp/GitHub, and are shown when you read or list a task. Set them with');
    lines.push('`dreamcontext tasks field <slug> <key> <value>` (or `tasks create --field key=value`):');
    for (const f of ov.customFields) {
      const tag = f.required ? '**[REQUIRED]**' : '[optional]';
      const askTag = f.ask ? ' **[ASK THE USER]**' : '';
      const opts = f.type === 'select' && f.options?.length ? ` — one of: ${f.options.join(', ')}` : '';
      const how = f.prompt ? ` — ${f.prompt}` : '';
      lines.push(`- ${tag}${askTag} **${f.name}** (id \`${f.key}\`, ${f.type}${opts})${how}`);
    }
    const askFields = ov.customFields.filter((f) => f.ask);
    if (askFields.length > 0) {
      lines.push('');
      lines.push(
        `ASK-FIRST: the field(s) marked **[ASK THE USER]** — ${askFields.map((f) => `\`${f.key}\``).join(', ')} — ` +
          'capture a HUMAN judgment (e.g. how long the work will take, its business impact). Do NOT make up a value. ' +
          'When you create a task on the user\'s request, ASK the user for each one BEFORE creating the task — a single ' +
          'concise question per field, using its prompt above as the framing (use the AskUserQuestion tool if you have ' +
          'it, otherwise just ask in chat) — and wait for the answer. Only if there is NO user to ask (an autonomous ' +
          'reconcile or a sleep cycle): leave the field unset and note it, rather than inventing a value.',
      );
    }
    if (required.length > 0) {
      lines.push('');
      lines.push(
        `RULE: the REQUIRED field(s) — ${required.map((f) => `\`${f.key}\``).join(', ')} — must be filled on ` +
          'every task before it leaves `todo`. Never create or complete a task with a required custom field left empty.',
      );
    }
  }
  if (ov.agentInstructions) {
    lines.push('');
    lines.push('Agent Instructions (verbatim from the override):');
    lines.push(ov.agentInstructions);
  }
  return lines.join('\n');
}
