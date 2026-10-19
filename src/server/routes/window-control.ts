import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isLoopback } from './agent-spawn-shared.js';
import { sanitizeModel } from '../../lib/claude-args.js';
import { WINDOW_TOKEN_HEADER, channelFor, identityOf, sendWindowCommand } from '../../lib/window-control.js';
import { superIndex } from '../../lib/super/store.js';
import { getChat } from '../../lib/assistant/chat-registry.js';

/**
 * `/api/window/:verb` — a project chat's agent drives the chat surface it is drawn in
 * (`dreamcontext window …`, lib/window-control.ts). Loopback only, and only with the token
 * the chat's own spawn env carries; the verb then travels down THAT chat's socket, so it can
 * only act on the window showing the chat that asked.
 *
 * The server validates every argument; the window resolves tabs and refuses what its own
 * state forbids (an unknown tab, closing a busy chat without --force).
 */

type Params = Record<string, string>;

export const WINDOW_VERBS = ['state', 'new', 'split', 'join', 'focus', 'mode', 'model', 'effort', 'send', 'close'] as const;
export type WindowVerb = typeof WINDOW_VERBS[number];

const TAB_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MODES = ['basic', 'plan', 'develop'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const MAX_TEXT = 100_000;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A tab id, when given: the conversation id `state` lists. Omitted = the calling chat. */
function tabArg(b: Record<string, unknown>, key = 'tab'): string | undefined | null {
  const v = str(b[key]);
  if (v === undefined) return undefined;
  return TAB_RE.test(v) ? v : null;
}

/** The verb's arguments, or the refusal to print. Exported for tests. */
export function pickWindowArgs(verb: WindowVerb, b: Record<string, unknown>): Record<string, unknown> | string {
  const tab = tabArg(b);
  if (tab === null) return 'tab must be a tab id from `dreamcontext window state`';
  switch (verb) {
    case 'state':
      return {};
    case 'new': {
      const mode = str(b.mode) ?? 'basic';
      if (!(MODES as readonly string[]).includes(mode)) return `mode must be one of ${MODES.join(' | ')}`;
      const model = str(b.model);
      if (model && !sanitizeModel(model)) return 'model is not a model id';
      const effort = str(b.effort);
      if (effort && !(EFFORTS as readonly string[]).includes(effort)) return `effort must be one of ${EFFORTS.join(' | ')}`;
      const prompt = typeof b.prompt === 'string' ? b.prompt : '';
      if (prompt.length > MAX_TEXT) return 'prompt is too long';
      const terminal = b.terminal === true;
      if (terminal && (prompt || model || effort || mode !== 'basic')) return 'a terminal tab takes no prompt, mode, model or effort';
      return { mode, model: model ?? '', effort: effort ?? '', prompt, split: b.split === true, terminal };
    }
    case 'split':
      return { tab };
    case 'join': {
      const into = tabArg(b, 'into');
      if (!into) return 'name the tab to join with --into <tab>';
      return { tab, into };
    }
    case 'focus':
      if (!tab) return 'name the tab to focus';
      return { tab };
    case 'mode': {
      const mode = str(b.mode);
      if (!mode || !(MODES as readonly string[]).includes(mode)) return `mode must be one of ${MODES.join(' | ')}`;
      return { tab, mode };
    }
    case 'model': {
      const model = str(b.model);
      if (!model || !sanitizeModel(model)) return 'model is not a model id';
      return { tab, model };
    }
    case 'effort': {
      const level = str(b.level);
      if (!level || !(EFFORTS as readonly string[]).includes(level)) return `effort must be one of ${EFFORTS.join(' | ')}`;
      return { tab, level };
    }
    case 'send': {
      const text = typeof b.text === 'string' ? b.text : '';
      if (!tab) return 'name the tab to send to';
      if (!text.trim()) return 'text is required';
      if (text.length > MAX_TEXT) return 'text is too long';
      return { tab, text };
    }
    case 'close':
      if (!tab) return 'name the tab to close';
      return { tab, force: b.force === true };
  }
}

// ─── The Super Agent's boundaries on window verbs (plan-r7 D4b) ─────────────────

/** The tab ids that name `sessionId`'s chat: its pin id and its live conversation id. */
function tabIdsOf(sessionId: string): Set<string> {
  const ids = new Set([sessionId]);
  const conv = getChat(sessionId)?.conversationId;
  if (conv) ids.add(conv);
  return ids;
}

/**
 * Why the caller may not run `verb` with `args`, or null. Every tab argument (`tab`, and `into`
 * for `join`) is matched against the super session by pin id AND conversation id:
 *  - `mode` on the super tab is refused for EVERY token, the super's own included (only the
 *    owner's button leaves `super`);
 *  - no token but the super session's own may target the super tab;
 *  - the super session's token reaches only its recorded children and its own tab, and calls no
 *    `new`/`split` while handed over (`super delegate` is the one spawn path, so the cap sees
 *    every child);
 *  - a recorded child's token, while handed over, reaches no sibling and calls no `new`/`split`.
 * A channel minted with no identity (tests) is nobody and gets no super rule. The browser
 * executor re-checks what it can (its own tab ids).
 */
export function superWindowRefusal(token: string, verb: WindowVerb, args: Record<string, unknown>): string | null {
  const who = identityOf(token);
  if (!who) return null;
  const idx = superIndex(who.contextRoot);
  if (!idx.session) return null;
  const superTabs = tabIdsOf(idx.session);
  const callerIsSuper = who.sessionId === idx.session && who.mode === 'super';
  const callerTabs = tabIdsOf(who.sessionId);
  const named = [args.tab, args.into].filter((t): t is string => typeof t === 'string' && !!t);
  const targetsSelfImplicitly = verb !== 'state' && verb !== 'new' && args.tab === undefined;
  const isSuperTab = (t: string) => superTabs.has(t);
  const childTabs = new Set<string>();
  for (const sid of idx.children) for (const id of tabIdsOf(sid)) childTabs.add(id);

  if (verb === 'mode' && (named.some(isSuperTab) || (targetsSelfImplicitly && (callerIsSuper || who.sessionId === idx.session)))) {
    return 'the Super Agent\'s mode changes only with the owner\'s Take back button';
  }
  if (!callerIsSuper && named.some(isSuperTab)) return 'the Super Agent\'s tab is not yours to drive';
  if (callerIsSuper) {
    if (idx.enabled && (verb === 'new' || verb === 'split')) return 'use `dreamcontext super delegate` to start a child (it counts against the cap)';
    for (const t of named) if (!isSuperTab(t) && !childTabs.has(t)) return 'you drive only your own children (`dreamcontext super state` lists them)';
    return null;
  }
  if (idx.enabled && idx.children.has(who.sessionId)) {
    if (verb === 'new' || verb === 'split') return 'while the Super Agent leads this project, only it starts chats';
    for (const t of named) if (childTabs.has(t) && !callerTabs.has(t)) return 'a sibling chat is not yours to drive; ask the Super Agent';
  }
  return null;
}

/** A `state` result without the super tab (what every caller but the super itself sees). */
export function omitSuperTabs(result: unknown, superTabs: ReadonlySet<string>): unknown {
  if (Array.isArray(result)) {
    return result
      .filter((x) => !(x && typeof x === 'object' && typeof (x as { tab?: unknown }).tab === 'string' && superTabs.has((x as { tab: string }).tab)))
      .map((x) => omitSuperTabs(x, superTabs));
  }
  if (result && typeof result === 'object') {
    return Object.fromEntries(Object.entries(result as Record<string, unknown>).map(([k, v]) => [k, omitSuperTabs(v, superTabs)]));
  }
  return result;
}

/** POST /api/window/:verb */
export async function handleWindowCommand(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!isLoopback(req)) { sendError(res, 403, 'window_local_only', 'Window control is only reachable from this machine.'); return; }
  const token = channelFor(req.headers[WINDOW_TOKEN_HEADER]);
  if (!token) { sendError(res, 401, 'not_a_chat', 'only an agent running in a dreamcontext chat can drive its window (or that chat has ended)'); return; }
  const verb = params.verb as WindowVerb;
  if (!(WINDOW_VERBS as readonly string[]).includes(verb)) { sendError(res, 404, 'unknown_verb', `No window verb "${params.verb}". Verbs: ${WINDOW_VERBS.join(', ')}.`); return; }
  const args = pickWindowArgs(verb, (await parseJsonBody(req)) ?? {});
  if (typeof args === 'string') { sendError(res, 400, 'invalid_args', args); return; }
  const refusal = superWindowRefusal(token, verb, args);
  if (refusal) { sendError(res, 403, 'super_refused', refusal); return; }
  const r = await sendWindowCommand(token, verb, args);
  if (r.ok && verb === 'state') {
    const who = identityOf(token);
    const session = who ? superIndex(who.contextRoot).session : null;
    if (session && who && who.sessionId !== session) {
      sendJson(res, 200, { ok: true, result: omitSuperTabs(r.result, tabIdsOf(session)) });
      return;
    }
  }
  if (r.ok) { sendJson(res, 200, { ok: true, result: r.result }); return; }
  sendJson(res, r.error === 'no_window' ? 409 : 200, {
    ok: false,
    error: r.error,
    ...(r.error === 'no_window' ? { message: 'no window is showing this chat right now (it is closed, or the app is in the background on a phone)' } : {}),
  });
}
