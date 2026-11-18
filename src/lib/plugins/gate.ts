/**
 * The plugin gate (Mağaza D1, contract C4): one rule for the CLI and the server.
 *
 *   When plugin P is not installed in the resolved vault, everything P owns that creates or
 *   changes data or starts a job is refused; everything that reads passes; P's switch passes.
 *
 * The decision reads the command path or the registered route pattern only, never arguments
 * (plan Decision 9). Reads and switches are exact paths, never prefixes.
 */
import { PLUGINS, pluginForApiWrite, pluginForCliRoot, type PluginDef } from './registry.js';
import { isPluginInstalled } from './store.js';

export const PLUGIN_NOT_INSTALLED_EXIT = 3;

/** The plugin that would refuse this CLI path if it were not installed (null = not owned, a read, or a switch). */
export function cliPathOwner(path: string[]): PluginDef | null {
  if (path.length === 0) return null;
  const def = pluginForCliRoot(path[0]);
  if (!def) return null;
  const joined = path.join(' ');
  if (def.cliReads.includes(joined) || def.cliSwitch.includes(joined)) return null;
  return def;
}

/** The plugin that refuses this CLI path in this vault right now, or null. Never throws. */
export function cliRefusal(path: string[], contextRoot: string | null): PluginDef | null {
  if (!contextRoot) return null;
  const def = cliPathOwner(path);
  if (!def) return null;
  return isPluginInstalled(contextRoot, def.id) ? null : def;
}

export function cliRefusalMessage(def: PluginDef): string {
  return (
    `plugin_not_installed: ${def.id} — this project has not installed the ${def.label} plugin. `
    + `Ask the owner; on yes run: dreamcontext plugins install ${def.id}`
  );
}

/** The plugin that refuses this registered route in this vault right now, or null. */
export function apiRefusal(method: string, pattern: string, contextRoot: string | null): PluginDef | null {
  if (!contextRoot) return null;
  const def = pluginForApiWrite(method, pattern);
  if (!def) return null;
  return isPluginInstalled(contextRoot, def.id) ? null : def;
}

/** Every top-level command a plugin owns (the root hook's cheap first check). */
export function pluginCliRoots(): string[] {
  return PLUGINS.flatMap((p) => p.cliRoots);
}
