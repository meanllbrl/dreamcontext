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
 * NEVER A CHIP IN SOMEBODY'S WINDOW. A project that is not live anywhere gets its OWN window
 * (`openVaultWindow`), so the per-window chip ceiling can never refuse the assistant; if even
 * the own window cannot be built, the answer is `ceiling`, which the assistant says aloud.
 */
import type { AssistantCommandHandler } from '../sleepy/chatSession';
import { openVaultWindow, sendDesktopNotification, vaultWindowLabel } from '../../lib/desktop';
import { resolveLiveWindowForVault } from '../../lib/windowRegistry';
import { ASSISTANT_COMMAND_EVENT } from '../../lib/assistantBridge';
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

/** Find (or build) the window that holds `vault`, bind the command to it, ring it. */
async function ringDoorbell(id: string, vault: string, newWindow: boolean): Promise<Out> {
  let label = newWindow ? null : await resolveLiveWindowForVault(vault);
  // Already live somewhere: that window registered its nonce when the project mounted.
  let bound = label ? await bind(id, vault, label, 3_000) : false;
  if (!bound) {
    try {
      await openVaultWindow(vault);
    } catch (err) {
      return { ok: false, error: `ceiling: could not open a window for ${vault} (${err instanceof Error ? err.message : String(err)})` };
    }
    label = vaultWindowLabel(vault);
    bound = await bind(id, vault, label, BIND_WINDOW_MS);
  }
  if (!bound || !label) return { ok: false, error: `${vault} did not come up in its window in time` };
  try {
    const { emitTo } = await import('@tauri-apps/api/event');
    await emitTo(label, ASSISTANT_COMMAND_EVENT, { commandId: id, vault });
  } catch (err) {
    return { ok: false, error: `could not reach the ${vault} window (${err instanceof Error ? err.message : String(err)})` };
  }
  return null;
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
