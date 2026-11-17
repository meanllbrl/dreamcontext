/**
 * Which automations run a plugin's commands (Mağaza D1, C3): the remove confirm and
 * `plugins remove` list them, because after a remove such a run exits 3 `plugin_not_installed`.
 */
import { listAutomationFileTargets } from '../automations/store.js';
import { getPlugin } from './registry.js';

export interface AffectedAutomation {
  slug: string;
  title: string;
  enabled: boolean;
}

/** Command aliases the prompt may use for a plugin root. */
const ROOT_ALIASES: Record<string, string[]> = { marketing: ['mk'] };

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `text` runs one of the plugin's roots: `dreamcontext lab sync`, `dreamcontext mk today`. */
export function textRunsPlugin(text: string, id: string): boolean {
  const def = getPlugin(id);
  if (!def || def.cliRoots.length === 0) return false;
  const names = def.cliRoots.flatMap((r) => [r, ...(ROOT_ALIASES[r] ?? [])]).map(escape);
  return new RegExp(`\\bdreamcontext\\s+(?:${names.join('|')})\\b`).test(text);
}

export function automationsUsingPlugin(contextRoot: string, id: string): AffectedAutomation[] {
  try {
    return listAutomationFileTargets(contextRoot)
      .filter((m) => textRunsPlugin(`${m.prompt ?? ''}\n${m.outputInstructions ?? ''}`, id))
      .map((m) => ({ slug: m.slug, title: m.title, enabled: m.enabled }));
  } catch {
    return [];
  }
}
