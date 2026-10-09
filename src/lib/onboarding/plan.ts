import type { CheckId, CheckTier, FixId, ReadinessCheck } from './types.js';

/** Statuses a fix is planned for. `unknown`, `blocked` and `unsupported` never are. */
function needsFix(c: ReadinessCheck): boolean {
  return (c.status === 'missing' || c.status === 'needs-action') && !!c.fix && c.fix.runnable;
}

function pick(checks: ReadinessCheck[], tier: CheckTier, interactive: boolean): FixId[] {
  return checks
    .filter((c) => c.tier === tier && needsFix(c) && (c.fix!.kind === 'auto') !== interactive)
    .map((c) => c.fix!.id);
}

/**
 * The fixes "Set everything up" runs, in order:
 *  1. `git-install` first: it opens a macOS window and installs in the background, so
 *     starting it first lets that download overlap everything else;
 *  2. required automatic fixes, then required interactive ones (sign-ins);
 *  3. recommended automatic fixes, then recommended interactive ones.
 * Optional checks are never planned (they are row buttons only); manual, blocked or
 * non-runnable fixes never appear. Within a group the order is {@link CHECK_IDS} order.
 */
export function planFixes(checks: ReadinessCheck[]): FixId[] {
  const git = checks.find((c) => c.id === 'git');
  const first: FixId[] = git && needsFix(git) && git.fix!.id === 'git-install' && git.fix!.kind === 'system-dialog'
    ? ['git-install']
    : [];
  const rest = [
    ...pick(checks, 'required', false),
    ...pick(checks, 'required', true),
    ...pick(checks, 'recommended', false),
    ...pick(checks, 'recommended', true),
  ].filter((id) => !first.includes(id));
  return [...first, ...rest];
}

/**
 * The first required (then recommended) check that is not done and cannot be finished
 * by an automatic fix: the one that needs the person. Null when nothing does.
 */
export function nextNeedingUser(checks: ReadinessCheck[]): CheckId | null {
  for (const tier of ['required', 'recommended'] as const) {
    const hit = checks.find((c) =>
      c.tier === tier
      && (c.status === 'missing' || c.status === 'needs-action')
      && (!c.fix || c.fix.kind !== 'auto' || !c.fix.runnable));
    if (hit) return hit.id;
  }
  return null;
}
