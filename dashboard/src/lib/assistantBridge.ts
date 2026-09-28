/**
 * The vault-window half of the dreamcontext Assistant's relay: how a command the assistant
 * issued in the notch reaches the chat surface of ONE project in ONE window.
 *
 * THE EVENT IS A DOORBELL, NEVER THE COMMAND. Tauri v2 cannot scope `emitTo` by target, so
 * any webview holding `core:event:allow-emit-to` can emit {@link ASSISTANT_COMMAND_EVENT} at
 * any window. The event therefore carries only `{commandId, vault}`; the command itself
 * (`{verb, args}`) is CLAIMED from the server, which hands it over only for an id it minted
 * behind the token-gated `/api/assistant/*` routes, bound to THIS vault and THIS window's
 * nonce, unclaimed, inside its TTL (`src/lib/assistant/relay.ts`). A forged, reused or
 * mis-addressed id is a 404 and the window does nothing. `vault` in the payload is a routing
 * hint that saves the other projects in this window a request — never a credential.
 *
 * THE NONCE STAYS HERE. Each project instance registers its window at mount
 * (`POST /api/assistant/windows`) and keeps the nonce in this module's closure. Nothing
 * exports it and nothing renders it, so script inside a chat bubble cannot read it — the
 * defence-in-depth half should a card type ever lose its sandbox.
 */
import { isDesktop } from './desktop';
import { thisWindowLabel } from './windowRegistry';

export const ASSISTANT_COMMAND_EVENT = 'dream://assistant-command';

export interface AssistantWindowCommand {
  verb: string;
  args: Record<string, unknown>;
}

export type AssistantWindowResult = { ok: true; result?: unknown } | { ok: false; error: string };

export type AssistantWindowHandler = (cmd: AssistantWindowCommand) => Promise<AssistantWindowResult>;

/** A relay id: 128 random bits, hex. Anything else is not worth a request. */
const COMMAND_ID_RE = /^[0-9a-f]{32}$/;

async function post(path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return null;
  }
}

/** Register this window for `vault`; the nonce never leaves this module. */
async function registerWindow(vault: string): Promise<string | null> {
  const label = await thisWindowLabel();
  if (!label) return null;
  const res = await post('/api/assistant/windows', { vault, label });
  if (!res?.ok) return null;
  try {
    const { nonce } = await res.json() as { nonce?: unknown };
    return typeof nonce === 'string' ? nonce : null;
  } catch {
    return null;
  }
}

/**
 * Registered once per project instance by `AgentSurface` (it owns the sessions for the
 * instance's lifetime). Every project in a window listens; the claim is what decides which
 * one acts, and only a valid claim ever reaches `handler`.
 */
export function listenForAssistantCommands(vault: string, handler: AssistantWindowHandler): () => void {
  if (!isDesktop() || !vault) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  const noncePromise = registerWindow(vault);
  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const fn = await listen<{ commandId?: unknown; vault?: unknown }>(ASSISTANT_COMMAND_EVENT, (event) => {
        const p = event.payload;
        if (!p || typeof p.commandId !== 'string' || !COMMAND_ID_RE.test(p.commandId)) return;
        if (p.vault !== vault) return;
        void answer(p.commandId);
      });
      if (cancelled) { fn(); return; }
      unlisten = fn;
    } catch { /* ACL / non-desktop — no command will ever be claimed here */ }
  })();

  async function answer(commandId: string): Promise<void> {
    const nonce = await noncePromise;
    if (!nonce || cancelled) return;
    const claim = await post(`/api/assistant/commands/${commandId}/claim`, { vault, nonce });
    if (!claim?.ok) return; // not ours, forged, reused or expired — do nothing at all
    let cmd: AssistantWindowCommand;
    try {
      const raw = await claim.json() as { verb?: unknown; args?: unknown };
      if (typeof raw.verb !== 'string') return;
      cmd = { verb: raw.verb, args: raw.args && typeof raw.args === 'object' ? raw.args as Record<string, unknown> : {} };
    } catch {
      return;
    }
    let out: AssistantWindowResult;
    try {
      out = await handler(cmd);
    } catch (err) {
      out = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await post(`/api/assistant/commands/${commandId}/result`, { vault, nonce, ...out });
  }

  return () => {
    cancelled = true;
    unlisten?.();
  };
}
