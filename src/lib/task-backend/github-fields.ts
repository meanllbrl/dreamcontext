/**
 * Recommended GitHub LABEL set for provisioning — the GitHub analog of
 * ClickUp's `RECOMMENDED_FIELD_DEFS`. `provisionRemote()` (a later dispatch)
 * creates these on the target repo (POST /repos/{o}/{r}/labels) so the
 * dreamcontext↔GitHub map binds cleanly.
 *
 * Pure module: no I/O. Names MUST stay in lock-step with `github-map.ts`:
 *  - sub-status labels: `dc:<key>` for every status of the loaded set except
 *    `todo` (NO label — absence is todo) and the done status (a bare close).
 *    The shipped set yields `dc:in-progress`, `dc:in-review`; a declared status
 *    adds its own, in its declared colour.
 *  - convention labels: `priority:*` / `urgency:*` (these are the values the map
 *    splits out of the label set; provisioning them gives users a tidy palette).
 */

import { PRIORITY_PREFIX, URGENCY_PREFIX } from './github-map.js';
import { DEFAULT_STATUSES, dcLabelFor, statusColor, type StatusDef } from '../task-status.js';

export interface RecommendedLabel {
  name: string;
  /** 6-hex GitHub label color (no leading #). */
  color: string;
  description: string;
}

/**
 * The label set `provisionRemote()` creates for a given status set. Sub-status
 * labels are required for the status round-trip — one `dc:<key>` per status
 * that carries a label (every status except `todo` and the done status), in
 * the status's declared colour (else its kind's default). This is how a
 * declared status (PLANNED, CANCELLED, …) auto-provisions its GitHub label
 * through the existing `createMissingLabels` path. The priority/urgency
 * convention labels are optional palette and safe to create idempotently
 * (GitHub no-ops a duplicate name with a 422 the provisioner swallows).
 */
export function recommendedLabels(statuses: readonly StatusDef[] = DEFAULT_STATUSES): RecommendedLabel[] {
  const sub: RecommendedLabel[] = [];
  for (const s of statuses) {
    if (s.key === 'todo' || s.kind === 'done') continue;
    sub.push({
      name: dcLabelFor(s.key),
      color: statusColor(s),
      description: `dreamcontext: task ${s.label.toLowerCase()}${s.kind === 'cancelled' ? ' (cancelled)' : ''}`,
    });
  }
  return [...sub, ...CONVENTION_LABELS];
}

const CONVENTION_LABELS: RecommendedLabel[] = [
  // ── Priority convention (map carrier; one applies per issue) ──
  { name: `${PRIORITY_PREFIX}critical`, color: 'b60205', description: 'dreamcontext priority: critical' },
  { name: `${PRIORITY_PREFIX}high`, color: 'd93f0b', description: 'dreamcontext priority: high' },
  { name: `${PRIORITY_PREFIX}medium`, color: 'fbca04', description: 'dreamcontext priority: medium' },
  { name: `${PRIORITY_PREFIX}low`, color: 'c2e0c6', description: 'dreamcontext priority: low' },

  // ── Urgency convention ──
  { name: `${URGENCY_PREFIX}critical`, color: '8b0000', description: 'dreamcontext urgency: critical' },
  { name: `${URGENCY_PREFIX}high`, color: 'e99695', description: 'dreamcontext urgency: high' },
  { name: `${URGENCY_PREFIX}medium`, color: 'f9d0c4', description: 'dreamcontext urgency: medium' },
  { name: `${URGENCY_PREFIX}low`, color: 'd4c5f9', description: 'dreamcontext urgency: low' },
];

/** The shipped-set label list (what a project with no override provisions). */
export const RECOMMENDED_LABELS: RecommendedLabel[] = recommendedLabels(DEFAULT_STATUSES);
