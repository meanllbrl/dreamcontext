import { readSleepState, writeSleepState } from '../cli/commands/sleep.js';

export type FieldValue =
  | string
  | number
  | boolean
  | string[]
  | Record<string, unknown>
  | null;

export interface FieldChange {
  field: string;
  from: FieldValue;
  to: FieldValue;
}

export interface DashboardChange {
  timestamp: string;
  entity: 'task' | 'core' | 'knowledge' | 'feature' | 'sleep';
  action: 'create' | 'update' | 'delete';
  target: string;
  field?: string;
  fields?: FieldChange[];
  summary: string;
}

function valuesEqual(a: FieldValue, b: FieldValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function formatValue(v: FieldValue): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  return String(v);
}

export function buildFieldSummary(entity: string, target: string, fields: FieldChange[]): string {
  const name = target.replace(/^(state|knowledge|core)\//, '').replace(/\.md$/, '');
  const transitions = fields.map(f => `${f.field} ${formatValue(f.from)} -> ${formatValue(f.to)}`);
  return `${entity} '${name}': ${transitions.join(', ')}`;
}

/**
 * Apply net-change detection: fold cumulative changes, cancel net-zero changes.
 * Mutates the changes array in place.
 */
function applyNetChangeDetection(changes: DashboardChange[], incoming: DashboardChange): void {
  const remainingFields: FieldChange[] = [];

  for (const fc of incoming.fields ?? []) {
    let handled = false;

    for (let i = 0; i < changes.length; i++) {
      const existing = changes[i];
      if (existing.target !== incoming.target || !existing.fields) continue;

      const existingFieldIdx = existing.fields.findIndex(ef => ef.field === fc.field);
      if (existingFieldIdx === -1) continue;

      const existingField = existing.fields[existingFieldIdx];

      if (valuesEqual(fc.to, existingField.from)) {
        // Net zero: new.to === old.from, cancel both
        existing.fields.splice(existingFieldIdx, 1);
        if (existing.fields.length === 0) {
          changes.splice(i, 1);
        } else {
          existing.field = existing.fields.map(f => f.field).join(', ');
          existing.summary = buildFieldSummary(existing.entity, existing.target, existing.fields);
        }
      } else {
        // Cumulative: update existing entry's `to`
        existingField.to = fc.to;
        existing.field = existing.fields.map(f => f.field).join(', ');
        existing.summary = buildFieldSummary(existing.entity, existing.target, existing.fields);
      }

      handled = true;
      break;
    }

    if (!handled) {
      remainingFields.push(fc);
    }
  }

  if (remainingFields.length > 0) {
    incoming.fields = remainingFields;
    incoming.field = remainingFields.map(f => f.field).join(', ');
    incoming.summary = buildFieldSummary(incoming.entity, incoming.target, remainingFields);
    changes.unshift(incoming);
  }
}

/**
 * Record a dashboard change in .sleep.json for rem-sleep consolidation.
 * Every mutating dashboard API call should use this.
 *
 * For field-level updates (with `fields` array), applies net-change detection:
 * - A->B then B->A on same target+field = cancelled (net zero)
 * - A->B then B->C on same target+field = folded to A->C
 */
export function recordDashboardChange(
  contextRoot: string,
  change: Omit<DashboardChange, 'timestamp'>,
): void {
  const state = readSleepState(contextRoot);
  const changes: DashboardChange[] = state.dashboard_changes ?? [];

  const timestamped: DashboardChange = {
    ...change,
    timestamp: new Date().toISOString(),
  };

  if (change.action === 'update' && change.fields && change.fields.length > 0) {
    applyNetChangeDetection(changes, timestamped);
  } else {
    changes.unshift(timestamped);
  }

  state.dashboard_changes = changes;
  writeSleepState(contextRoot, state);
}
