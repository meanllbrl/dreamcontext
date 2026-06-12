import { foldAscii } from './clickup-map.js';

/**
 * Custom-field bridge — issue #11 follow-up.
 *
 * dreamcontext fields that ClickUp's native task model can't hold (urgency,
 * the one-line summary, RICE numbers, related feature, attribution) sync
 * through LIST CUSTOM FIELDS — opt-in by construction: create a field on the
 * list with a recognizable name and the next sync starts writing/reading it.
 * No field on the list → that value simply stays local. Pure module: no I/O.
 */

export interface ClickUpFieldOption {
  id: string;
  name?: string;
  label?: string;
  orderindex?: number;
}

export interface ClickUpFieldDef {
  id: string;
  name: string;
  type: string; // 'drop_down' | 'number' | 'short_text' | 'text' | …
  type_config?: { options?: ClickUpFieldOption[] };
}

/** One ClickUp custom field's value as it appears on a task. */
export interface ClickUpFieldValue extends ClickUpFieldDef {
  value?: unknown;
}

/** Canonical local keys the bridge can sync. */
export type CustomFieldKey =
  | 'urgency'
  | 'description'
  | 'reach'
  | 'impact'
  | 'confidence'
  | 'effort'
  | 'score'
  | 'related_feature'
  | 'version'
  | 'created_by'
  | 'updated_by';

interface KeySpec {
  key: CustomFieldKey;
  /** Folded name candidates that bind a list field to this key. */
  names: string[];
  kind: 'string' | 'number';
  /** score is pushed for visibility but NEVER pulled (recomputed locally). */
  pull: boolean;
}

const KEY_SPECS: KeySpec[] = [
  { key: 'urgency', names: ['urgency', 'aciliyet'], kind: 'string', pull: true },
  { key: 'description', names: ['summary', 'description', 'desc', 'ozet'], kind: 'string', pull: true },
  { key: 'reach', names: ['reach', 'rice reach'], kind: 'number', pull: true },
  { key: 'impact', names: ['impact', 'rice impact'], kind: 'number', pull: true },
  { key: 'confidence', names: ['confidence', 'rice confidence'], kind: 'number', pull: true },
  { key: 'effort', names: ['effort', 'rice effort'], kind: 'number', pull: true },
  { key: 'score', names: ['score', 'rice score', 'rice'], kind: 'number', pull: false },
  { key: 'related_feature', names: ['feature', 'related feature'], kind: 'string', pull: true },
  { key: 'version', names: ['version', 'milestone', 'surum'], kind: 'string', pull: true },
  { key: 'created_by', names: ['created by'], kind: 'string', pull: false },
  { key: 'updated_by', names: ['updated by'], kind: 'string', pull: false },
];

export interface FieldBinding {
  key: CustomFieldKey;
  spec: KeySpec;
  field: ClickUpFieldDef;
}

/** Bind the list's custom fields to canonical keys (folded-name match). */
export function matchCustomFields(defs: ClickUpFieldDef[]): FieldBinding[] {
  const bindings: FieldBinding[] = [];
  const taken = new Set<string>();
  for (const spec of KEY_SPECS) {
    const def = defs.find(
      (d) => !taken.has(d.id) && spec.names.includes(foldAscii(d.name ?? '')),
    );
    if (def) {
      taken.add(def.id);
      bindings.push({ key: spec.key, spec, field: def });
    }
  }
  return bindings;
}

/** Read the local value for a key from raw task frontmatter. */
export function localFieldValue(
  fm: Record<string, unknown>,
  key: CustomFieldKey,
): string | number | null {
  const rice = (fm.rice ?? null) as Record<string, unknown> | null;
  switch (key) {
    case 'urgency': return strOrNull(fm.urgency);
    case 'description': return strOrNull(fm.description);
    case 'reach': return numOrNull(rice?.reach);
    case 'impact': return numOrNull(rice?.impact);
    case 'confidence': return numOrNull(rice?.confidence);
    case 'effort': return numOrNull(rice?.effort);
    case 'score': return numOrNull(rice?.score);
    case 'related_feature': return strOrNull(fm.related_feature);
    case 'version': return strOrNull(fm.version);
    case 'created_by': return strOrNull(fm.created_by);
    case 'updated_by': return strOrNull(fm.updated_by);
  }
}

/** Encode a local value for POST /task/:id/field/:fieldId. */
export function encodeFieldValue(
  binding: FieldBinding,
  value: string | number | null,
): unknown {
  if (value === null) return null;
  if (binding.field.type === 'drop_down') {
    const options = binding.field.type_config?.options ?? [];
    const folded = foldAscii(String(value));
    const opt = options.find((o) => foldAscii(o.name ?? o.label ?? '') === folded);
    return opt ? opt.id : null; // unknown option → don't write garbage
  }
  if (binding.spec.kind === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return String(value);
}

/** Decode a remote custom-field value back into the local domain. */
export function decodeFieldValue(
  field: ClickUpFieldValue,
  binding: FieldBinding,
): string | number | null {
  const v = field.value;
  if (v === undefined || v === null || v === '') return null;
  if (binding.field.type === 'drop_down') {
    const options = binding.field.type_config?.options ?? [];
    const opt = options.find(
      (o) => o.id === v || String(o.orderindex) === String(v),
    );
    const name = opt?.name ?? opt?.label;
    return name ? foldAscii(name) : null;
  }
  if (binding.spec.kind === 'number') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return String(v);
}

/** Whether this key participates in pull merges (score/attribution are push-only). */
export function isPullable(binding: FieldBinding): boolean {
  return binding.spec.pull;
}

/**
 * The recommended field set `tasks provision` creates on the list
 * (POST /list/:id/field — verified live). Names match the KEY_SPECS above so
 * the bridge binds them immediately.
 */
export const RECOMMENDED_FIELD_DEFS: Array<{
  key: CustomFieldKey;
  name: string;
  type: string;
  options?: string[];
}> = [
  { key: 'urgency', name: 'Urgency', type: 'drop_down', options: ['low', 'medium', 'high', 'critical'] },
  { key: 'description', name: 'Summary', type: 'short_text' },
  { key: 'reach', name: 'Reach', type: 'number' },
  { key: 'impact', name: 'Impact', type: 'number' },
  { key: 'confidence', name: 'Confidence', type: 'number' },
  { key: 'effort', name: 'Effort', type: 'number' },
  { key: 'score', name: 'RICE Score', type: 'number' },
  { key: 'related_feature', name: 'Feature', type: 'short_text' },
  { key: 'version', name: 'Version', type: 'short_text' },
];

/** RICE sub-keys (pulled values rebuild the rice block; score recomputes locally). */
export const RICE_KEYS: CustomFieldKey[] = ['reach', 'impact', 'confidence', 'effort'];

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' ? null : s;
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
