/**
 * Recommended GitHub LABEL set for provisioning — the GitHub analog of
 * ClickUp's `RECOMMENDED_FIELD_DEFS`. `provisionRemote()` (a later dispatch)
 * creates these on the target repo (POST /repos/{o}/{r}/labels) so the
 * dreamcontext↔GitHub map binds cleanly.
 *
 * Pure module: no I/O. Names MUST stay in lock-step with `github-map.ts`:
 *  - sub-status labels: `dc:in-progress`, `dc:in-review` (the map emits exactly
 *    these; `todo` carries NO label, so there is intentionally no `dc:todo`).
 *  - convention labels: `priority:*` / `urgency:*` (these are the values the map
 *    splits out of the label set; provisioning them gives users a tidy palette).
 */

import { DC_PREFIX, PRIORITY_PREFIX, URGENCY_PREFIX } from './github-map.js';

export interface RecommendedLabel {
  name: string;
  /** 6-hex GitHub label color (no leading #). */
  color: string;
  description: string;
}

/**
 * The label set `provisionRemote()` creates. Sub-status labels are required for
 * the status round-trip; the priority/urgency convention labels are optional
 * palette and safe to create idempotently (GitHub no-ops a duplicate name with
 * a 422 the provisioner swallows).
 */
export const RECOMMENDED_LABELS: RecommendedLabel[] = [
  // ── Sub-status (required by the map; absence of a dc: label = todo) ──
  { name: `${DC_PREFIX}in-progress`, color: 'fbca04', description: 'dreamcontext: task in progress' },
  { name: `${DC_PREFIX}in-review`, color: '0e8a16', description: 'dreamcontext: task in review' },

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
