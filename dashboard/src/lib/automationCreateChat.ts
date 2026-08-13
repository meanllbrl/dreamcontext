import { emitInstance } from '../context/VaultContext';
import { preparePrompt } from './agentPrompt';

/**
 * The "New automation" bridge — D3: creating an automation opens a chat whose agent
 * interviews the user and then writes the manifest (frontmatter + `## Prompt` + `## Flow`)
 * the same way a human authoring one by hand would: through the CLI's own `automations
 * create` verb, never by hand-writing the manifest file's bytes itself.
 *
 * Same decoupled event pattern as `delegateAgent.ts` / `automationRunChat.ts`, for the same
 * reason: the Automations board lives deep in the page router, the always-mounted
 * `AgentSurface` that actually owns Claude sessions is mounted once ABOVE that router, and
 * the two can't share a ref. The board fires on its project's instance bus; that project's
 * `AgentSurface` listens.
 *
 * Unlike `delegateAgent.ts` (which hands an EXISTING task's spec to a possibly-backgrounded
 * agent), this always starts a brand new session and always shows it: creating an automation
 * is a deliberate, foreground, one-off action a human just asked for by name, not a
 * fire-and-forget delegation — so there is no `reveal` choice to make and no `bypass` to
 * consider (the interview runs in the CLI's normal permission mode; the human answering the
 * agent's questions IS the approval loop). That is also why this owns its own event name
 * rather than reusing `DELEGATE_AGENT_EVENT` — the two model different actions even though
 * the transport underneath (spawn a fresh `claude` session with a prompt) is the same shape.
 */

export const AUTOMATION_CREATE_CHAT_EVENT = 'dreamcontext-automation-create-chat';

/** What travels on the event: the fresh session's brief, plus the surface's ACK. */
export interface AutomationCreateChatDetail {
  /** The new tab's title. Fixed rather than derived — there is no automation yet to name
   *  the tab after; the agent's own first reply is what actually introduces itself. */
  title: string;
  /** The interview brief, INLINE. Empty when {@link promptToken} is set instead — see
   *  `agentPrompt.ts`'s `preparePrompt`, which this bridge routes through exactly like
   *  `delegateTaskToAgent` does. */
  prompt: string;
  /** Token redeeming a prompt too large to inline. Empty when {@link prompt} is used. */
  promptToken: string;
  /**
   * Set to true by the AgentSurface listener once it has actually spawned the session.
   * Left false when its guards reject (not desktop / prereqs missing / the Agents surface
   * switched off in Settings), or when no surface is mounted to listen at all — the same ACK
   * contract as `DelegateAgentDetail.accepted` / `AutomationRunChatDetail.accepted`. A button
   * that silently does nothing is the failure this exists to make impossible.
   */
  accepted?: boolean;
}

/**
 * Ask THIS project's agent surface to open a fresh "author an automation" chat. Returns
 * whether it actually did.
 *
 * Synchronous by construction: `dispatchEvent` runs every listener before it returns, so the
 * ACK is readable on the next line — see `delegateAgent.ts`'s header for why nothing async
 * may sit between the dispatch and the read.
 */
export function requestAutomationCreateChat(bus: EventTarget, detail: AutomationCreateChatDetail): boolean {
  const payload: AutomationCreateChatDetail = { ...detail, accepted: false };
  emitInstance<AutomationCreateChatDetail>(bus, AUTOMATION_CREATE_CHAT_EVENT, payload);
  return payload.accepted === true;
}

/**
 * The interview brief. Plain-language and CLI-anchored, not a form: the agent asks what a
 * human author would (what should this do, how often, should it ever stop and ask), then
 * scaffolds with the exact verb a human typing the command themselves would use —
 * `dreamcontext automations create` (see `src/cli/commands/automations.ts`). That is what
 * keeps a chat-authored automation and a hand-authored one indistinguishable afterward,
 * approval included: `createAutomation` auto-approves on this machine (D-A path 1, "local
 * authorship") because the human directing this interview IS the approver.
 */
export function buildAutomationCreatePrompt(): string {
  return [
    'Interview me to design a new dreamcontext automation, then create it. Ask me — one '
      + 'question at a time, briefly — for:',
    '1. What should it do each time it runs? This becomes its `## Prompt` body, so get enough '
      + 'detail to write a real one, not a placeholder.\n'
      + '2. A short title.\n'
      + '3. How often: daily, or specific weekdays — and what time (24h local).\n'
      + '4. Should it ever stop and ask me before its work takes effect? Options: never '
      + '(default), the run decides on its own ("agent"), or always on the output document '
      + '("output").\n'
      + '5. Anything else worth setting — a model override, a reasoning effort level, a '
      + 'timeout, whether it should stay private to this machine or publish to the shared '
      + 'brain. Skip any of these and let the defaults stand if I have no opinion.',
    'Once you have enough to proceed, scaffold it with:\n'
      + '  dreamcontext automations create <slug> --title "<title>" --days <daily|mon,wed,...> '
      + '--at HH:MM [--model <model>] [--effort <level>] [--timeout <minutes>] '
      + '[--catchup <hours>] [--review off|agent|output] [--shared] [--no-notify] '
      + '[--no-learning]\n'
      + '`<slug>` is a short kebab-case name you derive from the title.',
    'The command scaffolds a stub `## Prompt` — replace it by editing '
      + '`automations/<slug>.md` directly so the body is exactly what I described in step 1, '
      + 'not the placeholder. It also derives a `## Flow` graph for you automatically from the '
      + 'schedule/model/review you set; leave it unless I asked for something the derived '
      + 'graph does not capture (a specific connector, an extra step), in which case edit the '
      + '`## Flow` JSON block by hand — see the manifest\'s own comments for its shape.',
    'The command auto-approves on this machine, since I am the one telling you to run it. '
      + 'Once it is created, tell me its slug and a one-line summary of what you set up — do '
      + 'not ask me anything else after that.',
  ].join('\n\n');
}

/**
 * Prepare + dispatch in one step, mirroring `delegateAgent.ts`'s `delegateTaskToAgent`: route
 * the interview brief to whichever transport can carry it (inline for a short prompt, a
 * POSTed token for a long one — the brief above comfortably inlines, but routing through
 * `preparePrompt` rather than hand-rolling that choice keeps this bridge honest if the brief
 * ever grows), then ask the surface for a fresh, revealed session. Resolves to the surface's
 * ACK, exactly like {@link requestAutomationCreateChat}.
 */
export async function openAutomationCreateChat(bus: EventTarget, vault: string | null): Promise<boolean> {
  const { inline, token } = await preparePrompt(vault, buildAutomationCreatePrompt());
  return requestAutomationCreateChat(bus, { title: 'New automation', prompt: inline, promptToken: token });
}
