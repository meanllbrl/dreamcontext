import { join } from 'node:path';
import { today } from './id.js';
import { applyTaskFeatureLink, resolveFeature } from './feature-links.js';
import { loadStatuses } from './overrides.js';
import type { TaskBackend } from './task-backend/types.js';
import { checkParentLink, loadFamily } from './task-parent.js';

/**
 * Put a task under a parent: the one implementation behind `tasks parent` and
 * the 0.33.0 task migration, so both check the same two-level rules and
 * inherit the same fields.
 */

export type ParentLinkResult =
  | { ok: true; parent: string; was: string | null; already: boolean; inherited: string[] }
  | { ok: false; reason: string };

export async function linkTaskToParent(
  contextRoot: string,
  backend: TaskBackend,
  slug: string,
  parentSlug: string,
): Promise<ParentLinkResult> {
  const task = await backend.get(slug);
  if (!task) return { ok: false, reason: `Task not found: ${slug}` };
  const check = checkParentLink(loadFamily(join(contextRoot, 'state')), loadStatuses(contextRoot), slug, parentSlug);
  if (!check.ok) return check;
  const was = task.parent_task ?? null;
  if (was === check.parent) return { ok: true, parent: check.parent, was, already: true, inherited: [] };
  const parent = await backend.get(check.parent);
  if (!parent) return { ok: false, reason: `Task not found: ${check.parent}` };
  // Inherit what binds a step to its deliverable, but never overwrite what
  // the task already says about itself.
  const inherit: Record<string, unknown> = {};
  if (task.objectives.length === 0 && parent.objectives.length > 0) inherit.objectives = [...parent.objectives];
  const featureFromParent = !task.related_feature && parent.related_feature ? resolveFeature(contextRoot, parent.related_feature) : null;
  if (!task.raw.cycle && typeof parent.raw.cycle === 'string' && parent.raw.cycle) inherit.cycle = parent.raw.cycle;
  const from = was ? ` (moved from ${was})` : '';
  await backend.addJournal(slug, { kind: 'log', body: `- placed under ${check.parent}${from}` });
  await backend.updateFields(slug, { parent_task: check.parent, ...inherit, updated_at: today() });
  if (featureFromParent?.ok) {
    applyTaskFeatureLink(contextRoot, slug, { slug: featureFromParent.slug });
    inherit.related_feature = featureFromParent.slug;
  }
  return { ok: true, parent: check.parent, was, already: false, inherited: Object.keys(inherit) };
}
