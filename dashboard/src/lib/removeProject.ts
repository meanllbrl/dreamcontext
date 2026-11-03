/**
 * "Remove from app" on a project's right-click menu (owner 2026-11-03, option A): the project
 * leaves the app's list, its folder stays on disk exactly as it is, and it can be added back.
 *
 * The question goes through `confirmAction` (never `window.confirm`: a silent no-op in the
 * desktop WebView). Only a yes reaches `POST /api/launcher/unregister`, which drops the registry
 * entry and never touches the folder. Pure over its deps so the yes/no paths are testable.
 */
import type { ConfirmOptions } from './desktop';

export interface RemoveProjectDeps {
  confirm(opts: ConfirmOptions): Promise<boolean>;
  unregister(name: string): Promise<unknown>;
  t(key: string): string;
}

/** Ask, then remove. Resolves true only when the owner said yes AND the registry dropped it. */
export async function confirmRemoveProject(name: string, path: string | null, deps: RemoveProjectDeps): Promise<boolean> {
  const body = deps.t('shell.drawer.removeBody').replace('{path}', path ?? name);
  const yes = await deps.confirm({
    title: deps.t('shell.drawer.removeTitle').replace('{name}', name),
    body,
    confirmLabel: deps.t('shell.drawer.removeConfirm'),
    cancelLabel: deps.t('shell.drawer.removeCancel'),
  });
  if (!yes) return false;
  await deps.unregister(name);
  return true;
}

/**
 * Where the window lands when the removed project is the one on screen: the next project in the
 * owner's order (then the one before), never the removed one. Null when none is left.
 */
export function nextProjectAfterRemove(order: readonly string[], removed: string): string | null {
  const i = order.indexOf(removed);
  const rest = order.filter((n) => n !== removed);
  if (rest.length === 0) return null;
  if (i === -1) return rest[0];
  return rest[Math.min(i, rest.length - 1)];
}
