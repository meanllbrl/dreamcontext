import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';
import {
  DEFAULT_STATUSES,
  DONE_STATUS_KEY,
  KIND_COLORS,
  SHIPPED_STATUS_KEYS,
  STATUS_KINDS,
  PARENT_BY_KIND,
  parentOf,
  sortByOrder,
  type StatusDef,
  type StatusKind,
} from './task-status.js';

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
 * Discovery is purely by file presence: absent the file, every consumer falls
 * back to the shipped defaults. The override lives INSIDE the brain, so it
 * survives `dreamcontext update` and travels with the project. A malformed
 * override is surfaced as warnings (by `dreamcontext doctor`) — never silently
 * ignored, and never fatal to task creation or sync.
 *
 * ONE DOCUMENTED EXCEPTION to "absent the file, nothing changes" (task_adYgpCxk,
 * multi-reviewer 2026-09-06): a task carrying a status OUTSIDE the loaded set is
 * now PRESERVED rather than silently rewritten to `todo` (see `readTaskFile`).
 * On a project that declares nothing, a stray value (a typo, a hand-edit, a
 * migration) therefore surfaces as itself — a `doctor` warning naming the file,
 * and its own board column — where it used to read as `todo`.
 *
 * That is deliberate and it is the SAFER side of the trade. The alternative,
 * gating the preservation on the override file existing, would coerce a
 * teammate's declared status to `todo` on exactly the machine that has not
 * pulled `overrides/task.md` yet — silently rewriting their data and pushing the
 * rewrite back. A spurious warning is recoverable; a destroyed status is not.
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

/** Structured input for adding/updating a status def from the dashboard. */
export interface StatusDefInput {
  /** Display label. */
  name: string;
  /** Explicit status key; defaults to the snake_case of `name`. ALWAYS written explicitly. */
  key?: string;
  /** Required for a new status; must be absent or unchanged for a shipped key. */
  kind?: StatusKind;
  /** Which shipped status this one lives under (the remote carrier). Defaults from `kind`. */
  parent?: string;
  order?: number;
  /** 6-hex (with or without `#`). */
  color?: string;
  /** Remote-backend status-name aliases (written to the `clickup:` frontmatter key). */
  remoteAliases?: string[];
}

export interface TaskOverride {
  /** Scaffold-ready template body (Agent-Instructions section removed), or null. */
  template: string | null;
  /** The `## Agent Instructions` prose sub-agents follow, or null. */
  agentInstructions: string | null;
  /** Declared custom fields (validated; malformed entries dropped → warnings). */
  customFields: CustomFieldDef[];
  /**
   * The EFFECTIVE status set: the four shipped statuses (relabelled / reordered /
   * recoloured by any matching `statuses:` entry) plus every valid declared
   * status, sorted by `order`. Never shorter than the shipped four. Malformed
   * entries are dropped → warnings.
   */
  statuses: StatusDef[];
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
      statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
      warnings: [`overrides/task.md: malformed frontmatter (${(err as Error).message ?? err})`],
    };
  }

  const customFields = parseCustomFields(data.custom_fields, warnings);
  const statuses = parseStatuses(data.statuses, customFields.map((f) => f.key), warnings);
  const { template, agentInstructions } = splitTemplate(body);
  return { template, agentInstructions, customFields, statuses, warnings };
}

/**
 * The project's EFFECTIVE status set: the override's `statuses` when the file
 * exists, else the shipped four. This is the one loader every consumer that
 * needs the set calls (CLI, backends, dashboard routes, snapshot, doctor).
 */
export function loadStatuses(contextRoot: string): StatusDef[] {
  return loadTaskOverride(contextRoot)?.statuses ?? DEFAULT_STATUSES.map((s) => ({ ...s }));
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

// ─── Statuses (`statuses:` frontmatter) ──────────────────────────────────────

/** Keys a status may never take: sync sentinels and the "no status" bucket. */
const RESERVED_STATUS_KEYS = new Set(['deleted', '__deleted__', 'unknown', 'none']);
/** Reserved GitHub label namespaces — a status key must not impersonate one. */
const RESERVED_LABEL_PREFIX = /^(priority|urgency|version|dc):/i;
/** A declared status with no usable `order` slots here, by kind. */
const DEFAULT_ORDER_BY_KIND: Record<StatusKind, number> = { open: 5, active: 15, review: 25, done: 30, cancelled: 99 };

/** Normalise a colour to 6-hex (no `#`), or null when it is not one. */
function parseHexColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const hex = raw.trim().replace(/^#/, '').toLowerCase();
  return /^[0-9a-f]{6}$/.test(hex) ? hex : null;
}

/**
 * Parse + validate the `statuses:` list into the EFFECTIVE set. Mirrors
 * `parseCustomFields` rule for rule: every failure is a WARNING and the entry
 * is DROPPED — never coerced into something that silently misbehaves, never
 * fatal. The shipped four are always present; a matching entry may relabel /
 * reorder / recolour one but never re-kind it.
 */
function parseStatuses(raw: unknown, customFieldKeys: readonly string[], warnings: string[]): StatusDef[] {
  const effective: StatusDef[] = DEFAULT_STATUSES.map((s) => ({ ...s }));
  if (raw === undefined || raw === null) return effective;
  if (!Array.isArray(raw)) {
    warnings.push('overrides/task.md: `statuses` must be a list — ignored.');
    return effective;
  }

  const fieldKeys = new Set(customFieldKeys);
  const seenDeclared = new Set<string>();
  const aliasOwner = new Map<string, string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      warnings.push('overrides/task.md: a statuses entry is not an object — skipped.');
      continue;
    }
    const e = entry as Record<string, unknown>;
    const labelRaw = typeof e.name === 'string' ? e.name : typeof e.label === 'string' ? e.label : '';
    const label = labelRaw.trim();
    const rawKey = typeof e.key === 'string' ? e.key.trim() : '';
    if (!label && !rawKey) {
      warnings.push('overrides/task.md: a statuses entry has neither `name` nor `key` — skipped.');
      continue;
    }
    if (rawKey && RESERVED_LABEL_PREFIX.test(rawKey)) {
      warnings.push(`overrides/task.md: status key "${rawKey}" uses a reserved label prefix (priority:/urgency:/version:/dc:) — skipped.`);
      continue;
    }
    const key = rawKey ? fieldKey(rawKey) : fieldKey(label);
    const display = label || key;
    if (!key) {
      warnings.push(`overrides/task.md: status "${display}" yields no usable key — skipped.`);
      continue;
    }
    if (seenDeclared.has(key)) {
      warnings.push(`overrides/task.md: duplicate status key "${key}" (from "${display}") — skipped.`);
      continue;
    }
    if (RESERVED_STATUS_KEYS.has(key)) {
      warnings.push(`overrides/task.md: status key "${key}" is reserved — skipped.`);
      continue;
    }
    if (fieldKeys.has(key)) {
      warnings.push(`overrides/task.md: status key "${key}" collides with a custom field of the same key — skipped.`);
      continue;
    }

    const kindRaw = typeof e.kind === 'string' ? e.kind.trim().toLowerCase() : undefined;
    const parentRaw = typeof e.parent === 'string' && e.parent.trim() ? fieldKey(e.parent) : undefined;
    const color = e.color === undefined || e.color === null ? undefined : parseHexColor(e.color);
    if (e.color !== undefined && e.color !== null && color === null) {
      warnings.push(`overrides/task.md: status "${display}" colour "${String(e.color)}" is not a 6-hex colour — using the kind's default.`);
    }
    const clickup = Array.isArray(e.clickup)
      ? e.clickup.map((a) => String(a).trim()).filter((a) => a !== '')
      : undefined;
    const orderRaw = e.order;
    const orderNum = typeof orderRaw === 'number' ? orderRaw : typeof orderRaw === 'string' && orderRaw.trim() !== '' ? Number(orderRaw) : NaN;

    const shipped = effective.find((s) => s.key === key && SHIPPED_STATUS_KEYS.includes(key));
    if (shipped) {
      // Shipped keys are immutable in KIND; relabel / reorder / recolour only.
      if (kindRaw !== undefined && kindRaw !== shipped.kind) {
        warnings.push(`overrides/task.md: shipped status "${key}" cannot be re-kinded (${shipped.kind} → ${kindRaw}) — entry ignored.`);
        continue;
      }
      seenDeclared.add(key);
      if (label) shipped.label = label;
      if (Number.isFinite(orderNum)) shipped.order = orderNum;
      else if (orderRaw !== undefined && orderRaw !== null) warnings.push(`overrides/task.md: status "${key}" has a non-numeric order — keeping ${shipped.order}.`);
      if (color) shipped.color = color;
      if (clickup && clickup.length > 0) shipped.clickup = clickup;
      for (const a of clickup ?? []) aliasOwner.set(a.toLowerCase(), key);
      continue;
    }

    if (kindRaw === undefined) {
      warnings.push(`overrides/task.md: status "${display}" has no \`kind\` (use ${STATUS_KINDS.join(' | ')}) — skipped.`);
      continue;
    }
    if (!(STATUS_KINDS as readonly string[]).includes(kindRaw)) {
      warnings.push(`overrides/task.md: status "${display}" has unknown kind "${kindRaw}" (use ${STATUS_KINDS.join(' | ')}) — skipped.`);
      continue;
    }
    const kind = kindRaw as StatusKind;
    // The PARENT is the remote carrier: a declared status pushes as one of the
    // four shipped statuses, so nothing ever has to be created on ClickUp or
    // GitHub. An unusable parent is dropped to the kind's natural one (warned)
    // rather than dropping the whole status.
    let parent = parentRaw;
    if (parent !== undefined && !SHIPPED_STATUS_KEYS.includes(parent)) {
      warnings.push(
        `overrides/task.md: status "${display}" has parent "${parentRaw}", which is not one of the four shipped statuses `
        + `(${SHIPPED_STATUS_KEYS.join(', ')}) — using ${PARENT_BY_KIND[kind]} (the ${kind} default) instead.`,
      );
      parent = undefined;
    }
    if (kind === 'done') {
      warnings.push(`overrides/task.md: status "${display}" is done-kind — only \`${DONE_STATUS_KEY}\` may be done-kind (exactly one done status) — skipped.`);
      continue;
    }
    let order = orderNum;
    if (!Number.isFinite(order)) {
      if (orderRaw !== undefined && orderRaw !== null) {
        warnings.push(`overrides/task.md: status "${display}" has a non-numeric order — defaulting to ${DEFAULT_ORDER_BY_KIND[kind]}.`);
      }
      order = DEFAULT_ORDER_BY_KIND[kind];
    }
    if (effective.some((s) => s.kind === kind && s.order === order)) {
      warnings.push(`overrides/task.md: status "${display}" shares order ${order} with another ${kind}-kind status — declaration order breaks the tie.`);
    }
    for (const a of clickup ?? []) {
      const owner = aliasOwner.get(a.toLowerCase());
      if (owner && owner !== key) warnings.push(`overrides/task.md: ClickUp alias "${a}" is claimed by both "${owner}" and "${key}" — "${owner}" wins on pull.`);
      else aliasOwner.set(a.toLowerCase(), key);
    }
    seenDeclared.add(key);
    effective.push({
      key,
      label: display,
      kind,
      ...(parent ? { parent } : {}),
      order,
      ...(color ? { color } : {}),
      ...(clickup && clickup.length > 0 ? { clickup } : {}),
    });
  }
  return sortByOrder(effective);
}

/** Whether a set differs from the shipped four in ANY way (extra, relabelled, reordered, recoloured). */
export function hasCustomStatuses(defs: readonly StatusDef[]): boolean {
  if (defs.length !== DEFAULT_STATUSES.length) return true;
  return defs.some((d) => {
    const s = DEFAULT_STATUSES.find((x) => x.key === d.key);
    return !s || s.label !== d.label || s.order !== d.order || d.color !== undefined || (d.clickup?.length ?? 0) > 0;
  });
}

/** The colour every status of a set renders with (declared → kind default), keyed by status key. */
export function statusColors(defs: readonly StatusDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of defs) out[d.key] = d.color && /^[0-9a-f]{6}$/i.test(d.color) ? d.color.toLowerCase() : KIND_COLORS[d.kind];
  return out;
}

/**
 * Add or replace ONE status definition (matched by key), preserving the body
 * and every other frontmatter key. ALWAYS writes an explicit `key:` so a later
 * rename of the label cannot silently change the derived key and orphan every
 * synced `dc:<oldkey>` GitHub label. A shipped key may only be relabelled /
 * reordered / recoloured — its kind is never written. Returns the reloaded
 * override; throws on an invalid input (the route maps that to a 400).
 */
export function upsertStatus(contextRoot: string, input: StatusDefInput): TaskOverride {
  const path = taskOverridePath(contextRoot);
  let data: Record<string, unknown> = {};
  let body = '';
  if (existsSync(path)) {
    const parsed = matter(readFileSync(path, 'utf-8'));
    // Clone — gray-matter caches parsed objects by string content (see upsertCustomField).
    data = structuredClone(parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content ?? '';
  }

  const name = input.name.trim();
  const rawKey = input.key && input.key.trim() ? input.key.trim() : name;
  if (RESERVED_LABEL_PREFIX.test(rawKey)) throw new Error(`Status key "${rawKey}" uses a reserved label prefix.`);
  const key = fieldKey(rawKey);
  if (!key) throw new Error('Status key could not be derived.');
  if (RESERVED_STATUS_KEYS.has(key)) throw new Error(`Status key "${key}" is reserved.`);
  const shipped = DEFAULT_STATUSES.find((s) => s.key === key);
  if (shipped) {
    if (input.kind !== undefined && input.kind !== shipped.kind) {
      throw new Error(`Shipped status "${key}" cannot be re-kinded (it is ${shipped.kind}).`);
    }
  } else {
    if (!input.kind || !(STATUS_KINDS as readonly string[]).includes(input.kind)) {
      throw new Error(`kind must be one of: ${STATUS_KINDS.join(', ')}`);
    }
    if (input.kind === 'done') throw new Error(`Only \`${DONE_STATUS_KEY}\` may be done-kind.`);
  }
  const color = input.color === undefined || input.color === null || input.color === '' ? undefined : parseHexColor(input.color);
  if (input.color && !color) throw new Error('color must be a 6-hex colour.');

  const parentIn = input.parent && input.parent.trim() ? fieldKey(input.parent) : undefined;
  if (parentIn !== undefined && !SHIPPED_STATUS_KEYS.includes(parentIn)) {
    throw new Error(`parent must be one of: ${SHIPPED_STATUS_KEYS.join(', ')}`);
  }
  const entry: Record<string, unknown> = { name: name || key, key };
  if (!shipped) {
    entry.kind = input.kind;
    // Always explicit: the parent is the remote wire contract, so it must not
    // silently move when a kind's default parent is ever revisited.
    entry.parent = parentIn ?? PARENT_BY_KIND[input.kind as StatusKind];
  }
  if (input.order !== undefined && Number.isFinite(input.order)) entry.order = input.order;
  if (color) entry.color = color;
  if (input.remoteAliases && input.remoteAliases.length > 0) entry.clickup = input.remoteAliases.map((a) => a.trim()).filter(Boolean);

  const list = Array.isArray(data.statuses) ? (data.statuses as Record<string, unknown>[]) : [];
  const idxOf = (s: Record<string, unknown>): string => fieldKey(String(s.key ?? s.name ?? s.label ?? ''));
  const existingIdx = list.findIndex((s) => idxOf(s) === key);
  if (existingIdx >= 0) list[existingIdx] = entry;
  else list.push(entry);
  data.statuses = list;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, matter.stringify(body, data), 'utf-8');
  return loadTaskOverride(contextRoot)!;
}

/**
 * Remove a DECLARED status by key. Refuses a shipped key (they cannot be
 * removed — throws). The caller is responsible for the in-use check (a status
 * still carried by a task must not be removed; the dashboard route answers
 * 409 with the count). Returns the reloaded override.
 */
export function removeStatus(contextRoot: string, key: string): TaskOverride | null {
  const target = fieldKey(key);
  if (SHIPPED_STATUS_KEYS.includes(target)) {
    throw new Error(`Shipped status "${target}" cannot be removed.`);
  }
  const path = taskOverridePath(contextRoot);
  if (!existsSync(path)) return null;
  const parsed = matter(readFileSync(path, 'utf-8'));
  const data = structuredClone(parsed.data ?? {}) as Record<string, unknown>;
  const list = Array.isArray(data.statuses) ? (data.statuses as Record<string, unknown>[]) : [];
  data.statuses = list.filter((s) => fieldKey(String(s.key ?? s.name ?? s.label ?? '')) !== target);
  writeFileSync(path, matter.stringify(parsed.content ?? '', data), 'utf-8');
  return loadTaskOverride(contextRoot);
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
  if (hasCustomStatuses(ov.statuses)) {
    const KIND_MEANING: Record<StatusKind, string> = {
      open: 'queued, not started',
      active: 'being worked on right now',
      review: 'done pending a human\'s verification',
      done: 'finished — the ONLY status that closes the work',
      cancelled: 'abandoned / superseded / obsoleted — never finished, never live',
    };
    lines.push('');
    lines.push('**This project declares its own task statuses.** Use EXACTLY these keys with');
    lines.push('`dreamcontext tasks status <slug> <key>` (and `tasks list -s <key>`); the shipped keys still exist:');
    for (const s of sortByOrder(ov.statuses)) {
      const under = SHIPPED_STATUS_KEYS.includes(s.key) ? '' : `, under \`${parentOf(ov.statuses, s.key)}\``;
      lines.push(`- \`${s.key}\` — ${s.label} (kind: ${s.kind} — ${KIND_MEANING[s.kind]}${under})`);
    }
    const cancelled = ov.statuses.filter((s) => s.kind === 'cancelled');
    if (cancelled.length > 0) {
      lines.push('');
      lines.push(
        `RULE: work that is abandoned, superseded or obsoleted goes to \`${cancelled[0].key}\` (cancelled-kind) — ` +
          'NOT to `in_review "confirm close"`. A cancelled task leaves every progress count and is never live.',
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
