import type { StartIntent } from './desktop';

/**
 * The onboarding hand-off's last hop: a project window asked to START a chat with a fixed
 * intent ("Start with Claude" on the Launcher). It arrives two ways, and both pass through
 * {@link acceptStartIntent} before anything acts on them:
 *
 *  - the `&start=initializer` param of a window the Launcher just BUILT (`openVaultWindow`), read
 *    once by `App.tsx` and handed to that window's first project;
 *  - the Tauri `START_INTENT_EVENT` (`emitStartIntent`) for a project whose window was already
 *    open, which every window hears and only the one holding that project takes.
 *
 * The OS `dreamcontext://` link path never carries a start intent: a link any app can open must
 * not be able to start an agent.
 *
 * From there it is the same bus bridge every other "spawn an agent" request uses: the project's
 * `StartIntentBridge` asks with {@link START_CHAT_INTENT_EVENT} until the always-mounted
 * `AgentSurface` ACKs, and the surface reports a refusal on {@link START_CHAT_REFUSED_EVENT} so
 * the user sees why nothing started instead of a silent no-op.
 */
export const START_CHAT_INTENT_EVENT = 'dreamcontext-start-chat-intent';

/** The surface took the intent but could not start Claude here (not set up, switched off). */
export const START_CHAT_REFUSED_EVENT = 'dreamcontext-start-chat-refused';

/** What the bridge hands the surface. `accepted` is the surface's synchronous ACK. */
export interface StartChatIntentDetail {
  intent: StartIntent;
  accepted?: boolean;
}

/** An intent that passed {@link acceptStartIntent}. */
export interface AcceptedStartIntent {
  vault: string;
  intent: StartIntent;
}

/**
 * Filter one incoming start intent. Returns null unless:
 *  - `intent` is exactly `'initializer'` (the closed set; anything else is dropped);
 *  - `vault` names a project this window holds (`ownVaults`);
 *  - `nonce` is a non-empty string not seen before (it is then recorded in `seen`, so a
 *    re-delivered broadcast never starts a second chat).
 *
 * Pure apart from writing the nonce into `seen`, and total: any malformed payload is null.
 */
export function acceptStartIntent(
  p: unknown,
  ownVaults: readonly string[],
  seen: Set<string>,
): AcceptedStartIntent | null {
  if (!p || typeof p !== 'object') return null;
  const { vault, intent, nonce } = p as { vault?: unknown; intent?: unknown; nonce?: unknown };
  if (intent !== 'initializer') return null;
  if (typeof vault !== 'string' || !vault || !ownVaults.includes(vault)) return null;
  if (typeof nonce !== 'string' || !nonce || seen.has(nonce)) return null;
  seen.add(nonce);
  return { vault, intent };
}
