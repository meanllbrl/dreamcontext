/**
 * "Where is this project open right now?" — asked by every surface that wants to land on a
 * project in the window the owner ALREADY has instead of building a second one: the Assistant's
 * relay (`components/assistant/commandExecutor.ts`) and the `dreamcontext://` link router
 * (`lib/appLink.ts`).
 *
 * Lives here rather than in the executor because the link router runs in every project window
 * and the launcher, and importing the executor would drag the notch's tiling and verb table into
 * each of them.
 */
import { resolveLiveWindowForVault } from './windowRegistry';

/** Labels of the windows alive right now, or null when they cannot be listed. */
async function liveLabels(): Promise<Set<string> | null> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    return new Set((await WebviewWindow.getAll()).map((w) => w.label));
  } catch {
    return null;
  }
}

/** The server's answer to "which windows hold a live instance of `vault`?", newest first. */
async function serverLabels(vault: string): Promise<string[]> {
  try {
    const res = await fetch(`/api/assistant/windows?vault=${encodeURIComponent(vault)}`);
    if (!res.ok) return [];
    const { labels } = await res.json() as { labels?: unknown };
    return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Where `vault` already is: windows with a live instance of it (server, then the browser
 * registry), and — separately — a window that lists it as a tab without a live instance
 * (a cold chip), which can be woken in place. Only windows that are alive right now count.
 */
export async function findOpenProject(vault: string): Promise<{ live: string[]; cold: string | null }> {
  const [fromServer, fromRegistry, alive] = await Promise.all([
    serverLabels(vault), resolveLiveWindowForVault(vault), liveLabels(),
  ]);
  const isAlive = (l: string) => l !== 'assistant' && (alive ? alive.has(l) : true);
  const live = fromServer.filter(isAlive);
  // The registry knows the tabs a window HOLDS, cold ones included; the server only knows
  // mounted instances. A registry window the server does not list is holding it cold.
  const cold = fromRegistry && !live.includes(fromRegistry) && isAlive(fromRegistry) ? fromRegistry : null;
  return { live, cold };
}
