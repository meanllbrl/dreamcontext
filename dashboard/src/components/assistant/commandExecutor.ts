/**
 * The notch's half of the relay: runs each UI verb the server sends down the Assistant's chat
 * socket (`chatSession.setCommandHandler`).
 *
 * Verbs the notch finishes itself (`notify`, `tile`) answer UP the socket. Verbs a PROJECT has
 * to carry out (`open`, `chat`, `send`, `answer`, `focus`) are DELEGATED: the notch finds or
 * opens that project's window, binds the command id to it on the server (by the window's real
 * Tauri label — the server looks up the nonce that window registered, the notch never holds
 * one), and rings the window's doorbell. The window claims the command from the server and
 * posts the result there itself, so the handler answers `null` and sends nothing back.
 *
 * AN OPEN PROJECT IS REUSED WHERE IT IS. The owner keeps several projects as tabs of one
 * window; a command for one of them lands in THAT tab. Where a project lives is asked of the
 * server first (`GET /api/assistant/windows` — every live instance registers there and
 * withdraws on unmount), because the browser-side registry is a localStorage heartbeat that
 * goes stale when macOS throttles a background window's timers: that staleness is what used
 * to make the notch build a second window for a project already open in a tab. A tab that is
 * listed but cold is woken in place ({@link ASSISTANT_WAKE_EVENT}).
 *
 * NEVER A CHIP IN SOMEBODY'S WINDOW. A project that is not open anywhere gets its OWN window
 * (`openVaultWindow`), so the per-window chip ceiling can never refuse the assistant; if even
 * the own window cannot be built, the answer is `ceiling`, which the assistant says aloud.
 */
import type { AssistantCommandHandler } from '../sleepy/chatSession';
import { openVaultWindow, sendDesktopNotification, vaultWindowLabel } from '../../lib/desktop';
import { resolveLiveWindowForVault } from '../../lib/windowRegistry';
import { ASSISTANT_COMMAND_EVENT, ASSISTANT_WAKE_EVENT } from '../../lib/assistantBridge';
import { tileWindows, type TileLayout } from './tile';

/** How long a window gets to register its nonce after being found / built. Inside the
 *  server's relay timeout (25 s) with room for the window to claim and act. */
const BIND_WINDOW_MS = 15_000;
const BIND_RETRY_MS = 250;

const DELEGATED = new Set(['open', 'chat', 'send', 'answer', 'focus']);

type Out = Awaited<ReturnType<AssistantCommandHandler>>;

async function bind(id: string, vault: string, label: string, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs;
  for (;;) {
    try {
      const res = await fetch(`/api/assistant/commands/${id}/bind`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vault, label }),
      });
      if (res.ok) return true;
    } catch { /* server hiccup — retry inside the window */ }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, BIND_RETRY_MS));
  }
}

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

async function emitDoorbell(id: string, vault: string, label: string): Promise<Out> {
  try {
    const { emitTo } = await import('@tauri-apps/api/event');
    await emitTo(label, ASSISTANT_COMMAND_EVENT, { commandId: id, vault });
  } catch (err) {
    return { ok: false, error: `could not reach the ${vault} window (${err instanceof Error ? err.message : String(err)})` };
  }
  return null;
}

/** Find (or build) the window that holds `vault`, bind the command to it, ring it. */
async function ringDoorbell(id: string, vault: string, newWindow: boolean): Promise<Out> {
  if (!newWindow) {
    const { live, cold } = await findOpenProject(vault);
    // Already live in a tab somewhere: that instance registered its nonce when it mounted.
    for (const label of live) {
      if (await bind(id, vault, label, 3_000)) return emitDoorbell(id, vault, label);
    }
    // Listed in a window but cold: rebuild the tab THERE, then bind once it has registered.
    const holder = cold ?? live[0] ?? null;
    if (holder) {
      try {
        const { emitTo } = await import('@tauri-apps/api/event');
        await emitTo(holder, ASSISTANT_WAKE_EVENT, { vault });
        if (await bind(id, vault, holder, BIND_WINDOW_MS)) return emitDoorbell(id, vault, holder);
      } catch { /* the window went away — fall through to its own window */ }
    }
  }
  try {
    await openVaultWindow(vault);
  } catch (err) {
    return { ok: false, error: `ceiling: could not open a window for ${vault} (${err instanceof Error ? err.message : String(err)})` };
  }
  const label = vaultWindowLabel(vault);
  if (!(await bind(id, vault, label, BIND_WINDOW_MS))) return { ok: false, error: `${vault} did not come up in its window in time` };
  return emitDoorbell(id, vault, label);
}

/** Listeners for `notify` — the pill pulses on an `attention` one. */
const notifyListeners = new Set<(text: string, level: 'info' | 'attention') => void>();
export function onAssistantNotify(fn: (text: string, level: 'info' | 'attention') => void): () => void {
  notifyListeners.add(fn);
  return () => { notifyListeners.delete(fn); };
}

export const executeAssistantCommand: AssistantCommandHandler = async ({ id, verb, args }) => {
  if (DELEGATED.has(verb)) {
    const vault = typeof args.vault === 'string' ? args.vault : '';
    if (!vault) return { ok: false, error: 'no project named' };
    return ringDoorbell(id, vault, verb === 'open' && args.newWindow === true);
  }
  if (verb === 'notify') {
    const text = typeof args.text === 'string' ? args.text : '';
    const level = args.level === 'attention' ? 'attention' : 'info';
    for (const fn of notifyListeners) fn(text, level);
    const shown = await sendDesktopNotification('dreamcontext Assistant', text);
    return { ok: true, result: { shown } };
  }
  if (verb === 'tile') {
    const vaults = Array.isArray(args.vaults) ? args.vaults.filter((v): v is string => typeof v === 'string') : [];
    const layout: TileLayout = args.layout === 'rows' || args.layout === 'grid' ? args.layout : 'columns';
    return tileWindows(vaults, layout);
  }
  return { ok: false, error: `unknown verb "${verb}"` };
};
