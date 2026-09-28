import { useEffect, useRef } from 'react';
import type { ChatSession } from '../sleepy/chatSession';
import type { ChatMode } from '../../lib/chatModes';
import { postToSession } from '../sleepy/chat/postToSession';
import { preparePrompt } from '../../lib/agentPrompt';
import { listenForAssistantCommands, type AssistantWindowResult } from '../../lib/assistantBridge';

/**
 * The project side of the dreamcontext Assistant: what a project's chat surface does when the
 * notch rings its doorbell (`lib/assistantBridge.ts`). Mounted once per project instance by
 * `AgentSurface`, which owns the sessions; this hook owns the verbs.
 *
 * A command reaches {@link runVerb} only after the server released it for THIS vault and THIS
 * window's nonce, so the verb itself is trusted — but every session is still resolved by its
 * conversation id (the id the Assistant's chat registry lists), never by position.
 */
export interface AssistantDoorbellDeps {
  vault: string | null;
  /** The live chat with this conversation id in this project, or null. */
  findChat: (claudeId: string) => ChatSession | null;
  /** Spawn a new chat with the prepared prompt in `mode`, give it a pane and reveal it. */
  openChat: (inlinePrompt: string, promptToken: string, mode: ChatMode) => ChatSession;
  /** Bring this project's chat surface to the front (chip + overlay). */
  reveal: () => void;
  /** Bring this project to the front on one of its pages (a notch detail button, `open --page`). */
  openPage: (page: 'tasks' | 'knowledge' | 'core', id: string) => void;
}

/** `tasks/<slug>` → its parts; anything else → null (the server already refused it). */
export function parsePage(page: unknown): { page: 'tasks' | 'knowledge' | 'core'; id: string } | null {
  const m = typeof page === 'string' ? /^(tasks|knowledge|core)\/([A-Za-z0-9._-]{1,160})$/.exec(page) : null;
  return m ? { page: m[1] as 'tasks' | 'knowledge' | 'core', id: m[2] } : null;
}

const ALLOW_RE = /^(allow|yes|y|approve|ok|evet)\b/i;
const DENY_RE = /^(deny|no|n|reject|hayir|hayır)\b/i;

async function focusThisWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setFocus();
  } catch { /* browser / ACL — the chip is still revealed */ }
}

/** Exported for tests: one verb against the deps, no bridge. */
export async function runVerb(
  deps: AssistantDoorbellDeps,
  verb: string,
  args: Record<string, unknown>,
): Promise<AssistantWindowResult> {
  const { vault } = deps;
  // `open` reaches a project only once its window exists (the notch built or found it), so
  // here it is the same act as `focus` — plus, with a page, landing on that page.
  const target = verb === 'open' ? parsePage(args.page) : null;
  if (target) {
    deps.openPage(target.page, target.id);
    await focusThisWindow();
    return { ok: true, result: { vault, page: `${target.page}/${target.id}` } };
  }
  if (verb === 'focus' || verb === 'open') {
    deps.reveal();
    await focusThisWindow();
    return { ok: true, result: { vault } };
  }
  if (verb === 'chat') {
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    if (!prompt.trim() || !vault) return { ok: false, error: 'prompt is required' };
    const mode: ChatMode = args.mode === 'plan' || args.mode === 'develop' ? args.mode : 'basic';
    const prepared = await preparePrompt(vault, prompt);
    const s = deps.openChat(prepared.inline, prepared.token, mode);
    await focusThisWindow();
    return { ok: true, result: { vault, sessionId: s.claudeId } };
  }
  if (verb === 'send') {
    const chat = typeof args.sessionId === 'string' ? deps.findChat(args.sessionId) : null;
    const text = typeof args.text === 'string' ? args.text : '';
    if (!chat) return { ok: false, error: 'that chat is not open in this project any more' };
    if (!text.trim()) return { ok: false, error: 'text is required' };
    postToSession(chat, text);
    return { ok: true, result: { sessionId: args.sessionId } };
  }
  if (verb === 'answer') {
    const chat = typeof args.sessionId === 'string' ? deps.findChat(args.sessionId) : null;
    if (!chat) return { ok: false, error: 'that chat is not open in this project any more' };
    const pending = chat.getModel().pending.find((p) => p.requestId === args.question);
    if (!pending) return { ok: false, error: 'that question is no longer waiting' };
    const said = String(args.choice ?? args.text ?? '').trim();
    if (!said) return { ok: false, error: 'an answer is required' };
    if (pending.kind === 'question') {
      // The pick goes to the question that offers it as an option, else the first question.
      const target = pending.questions.find((q) => q.options.some((o) => o.label === said)) ?? pending.questions[0];
      if (!target) return { ok: false, error: 'that question has nothing to answer' };
      chat.answerQuestion(pending.requestId, pending.questions, { [target.question]: said });
      return { ok: true, result: { answered: said } };
    }
    const allow = ALLOW_RE.test(said);
    if (!allow && !DENY_RE.test(said)) return { ok: false, error: 'answer a permission or plan prompt with allow or deny' };
    chat.answer(pending.requestId, allow
      ? { behavior: 'allow', updatedInput: pending.input }
      : { behavior: 'deny', message: 'Declined by the owner through the Assistant.' });
    return { ok: true, result: { answered: allow ? 'allow' : 'deny' } };
  }
  return { ok: false, error: `this project cannot run "${verb}"` };
}

/** Listen for the Assistant's doorbell for this project, for as long as the surface lives. */
export function useAssistantDoorbell(deps: AssistantDoorbellDeps): void {
  // Latest deps through a ref: the listener is registered once per vault (registering
  // re-mints the window nonce), while the sessions it acts on change every render.
  const ref = useRef(deps);
  ref.current = deps;
  const { vault } = deps;
  useEffect(() => {
    if (!vault) return;
    return listenForAssistantCommands(vault, ({ verb, args }) => runVerb(ref.current, verb, args));
  }, [vault]);
}
