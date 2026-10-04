import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { isLoopback } from './agent-spawn-shared.js';
import {
  ASSISTANT_VAULT, assistantContextRoot, assistantExists, assistantProjectRoot,
  readAssistantConfig, writeAssistantConfig, sanitizeConfigPatch,
} from '../../lib/assistant/home.js';
import { checkAssistantToken, isTainted, markTainted } from '../../lib/assistant/session-state.js';
import { decide, wrapUntrusted, type AssistantVerb } from '../../lib/assistant/autonomy.js';
import { abandonProposal, createProposal, listProposals, resolveProposal } from '../../lib/assistant/proposals.js';
import { getChat, listChats, watchChat, activityOf, CHAT_STATUSES, type ChatEntry, type ChatStatus, type WatchUntil } from '../../lib/assistant/chat-registry.js';
import { collectRoster } from '../../lib/assistant/roster.js';
import { broadcast, type BroadcastRow } from '../../lib/assistant/broadcast.js';
import { AvatarError, findAvatar, writeAvatar, AVATAR_MAX_BYTES } from '../../lib/assistant/avatar.js';
import {
  bindCommandToWindow, claimCommand, deliverResult, registerWindow, relayCommand, windowVault,
  releaseWindowNonce, windowLabelsForVault,
} from '../../lib/assistant/relay.js';
import { listVaults } from '../../lib/vaults.js';
import { dismissDelegation, listDelegations, recordDelegation } from '../../lib/assistant/delegations.js';
import { notifyAssistantAutonomy } from './agent-chat.js';
import { captureScreens } from '../../lib/assistant/screen.js';
import {
  dismissNotchEvent, listNotchEvents, lookingAt, readMutedAutomations, setAutomationMuted, setPresence,
  syncAccountRejections, wireNotchInbox,
} from '../../lib/assistant/notch-inbox.js';
import { markThreadRead, plainPostText } from '../../lib/automations/threads.js';
import { getAutomation } from '../../lib/automations/store.js';
import { automationProject, invalidateAutomationInbox, runningAutomations, unreadAutomationPosts } from '../assistant-inbox.js';

/**
 * `/api/assistant/*` — the dreamcontext Assistant's server surface.
 *
 * TWO GATES, and every route states which it takes:
 *   • `ownerGate`     — loopback + desktop. The Launcher wizard, the notch, a vault window's
 *                       doorbell claim. No token: these callers are webviews of THIS app.
 *   • `assistantGate` — loopback + desktop + the per-boot assistant token, which only the
 *                       `__assistant__` chat's spawn env carries. Every verb the assistant's
 *                       CLI runs goes through here; the tailnet is never accepted.
 *
 * Every project-derived string a response carries is wrapped in
 * `<untrusted-project-output>`, and serving one TAINTS the assistant session (autonomy.ts).
 */

type Params = Record<string, string>;

export const ASSISTANT_TOKEN_HEADER = 'x-dreamcontext-assistant-token';

function ownerGate(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopback(req) || !isDesktop()) {
    sendError(res, 403, 'assistant_local_only', 'The dreamcontext Assistant is only reachable from this machine\'s desktop app.');
    return false;
  }
  return true;
}

/** Named refusals, in the words the assistant will repeat to the owner. */
export function assistantGate(req: IncomingMessage, res: ServerResponse): boolean {
  if (!ownerGate(req, res)) return false;
  const check = checkAssistantToken(req.headers[ASSISTANT_TOKEN_HEADER]);
  if (check === 'ok') return true;
  if (check === 'stale') {
    sendError(res, 401, 'app_restarted', 'the app restarted — this turn cannot drive it');
  } else if (check === 'missing') {
    sendError(res, 401, 'not_assistant', 'only the dreamcontext Assistant can drive the app');
  } else {
    sendError(res, 401, 'bad_token', 'only the dreamcontext Assistant can drive the app (the token does not match)');
  }
  return false;
}

/**
 * The dashboard server idles sockets out after 30 s (`server.setTimeout(30000)`). A `watch`
 * long-poll, a broadcast, and a gated verb waiting on the owner's approval legitimately stay
 * silent for minutes — so those routes lift the timeout on THEIR socket only.
 */
function holdOpen(req: IncomingMessage): void {
  try { req.socket?.setTimeout?.(0); } catch { /* a test double without a real socket */ }
}

const q = (req: IncomingMessage) => new URL(req.url || '/', 'http://localhost').searchParams;
const autonomy = () => (readAssistantConfig() ?? { autonomy: 'ask' as const }).autonomy;

// ─── Project-text rendering (always wrapped) ─────────────────────────────────────────

function viewChat(c: ChatEntry, lastN = 3): Record<string, unknown> {
  return {
    sessionId: c.sessionId,
    vault: c.vault,
    mode: c.mode,
    status: c.status,
    activity: activityOf(c),
    updatedAt: c.updatedAt,
    lastFrameAt: c.lastFrameAt,
    title: c.title ? wrapUntrusted(c.vault, c.title) : '',
    lastAssistantText: c.lastAssistantText.slice(-lastN).map((t) => wrapUntrusted(c.vault, t)),
    pendingQuestion: c.pendingQuestion
      ? { id: c.pendingQuestion.requestId, kind: c.pendingQuestion.isPermission ? 'permission' : 'question', tool: c.pendingQuestion.toolName, text: wrapUntrusted(c.vault, c.pendingQuestion.text), options: c.pendingQuestion.options.map((o) => wrapUntrusted(c.vault, o)) }
      : null,
  };
}

// ─── Assistant verbs (token-gated) ──────────────────────────────────────────────────

/** GET /api/assistant/projects */
export async function handleAssistantProjects(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!assistantGate(req, res)) return;
  const roster = collectRoster();
  const projects = roster.vaults.map((v) => ({
    name: v.name,
    path: v.path,
    missing: v.missing,
    whatItIs: v.whatItIs ? wrapUntrusted(v.name, v.whatItIs) : '',
    activeTask: v.activeTask ? wrapUntrusted(v.name, v.activeTask) : '',
    topTags: v.topTags.length ? wrapUntrusted(v.name, v.topTags.join(', ')) : '',
    connections: v.connections,
    live: v.live,
  }));
  if (roster.carriesProjectText) markTainted();
  sendJson(res, 200, { projects });
}

/** GET /api/assistant/sessions?project=<vault>&status=<status> */
export async function handleAssistantSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!assistantGate(req, res)) return;
  const p = q(req);
  const status = p.get('status');
  const filter: { vault?: string; status?: ChatStatus } = {};
  if (p.get('project')) filter.vault = p.get('project')!;
  if (status && (CHAT_STATUSES as readonly string[]).includes(status)) filter.status = status as ChatStatus;
  const sessions = listChats(filter);
  if (sessions.some((c) => c.title || c.lastAssistantText.length || c.pendingQuestion)) markTainted();
  sendJson(res, 200, { sessions: sessions.map((c) => viewChat(c)) });
}

/** GET /api/assistant/watch?session=<id>&until=settled|idle|asking|any&timeout=<sec> */
export async function handleAssistantWatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!assistantGate(req, res)) return;
  holdOpen(req);
  const p = q(req);
  const sessionId = p.get('session') ?? '';
  const untilRaw = p.get('until') ?? 'settled';
  const until: WatchUntil = untilRaw === 'idle' || untilRaw === 'asking' || untilRaw === 'any' ? untilRaw : 'settled';
  const timeoutSec = Math.min(Math.max(Number(p.get('timeout') ?? 590) || 590, 1), 3600);
  const r = await watchChat(sessionId, until, timeoutSec * 1000);
  if (r.unknown) { sendError(res, 404, 'unknown_session', `No live or recent chat "${sessionId}".`); return; }
  if (r.entry) markTainted();
  sendJson(res, 200, {
    ended: !!r.ended,
    timedOut: !!r.timedOut,
    session: r.entry ? viewChat(r.entry, 5) : null,
  });
}

/**
 * Run a gated verb through the autonomy gate. `pass` → run now; `propose` → a proposal the
 * owner decides in the notch, and THIS request blocks until they do.
 */
async function gated(
  res: ServerResponse,
  verb: AssistantVerb,
  target: string,
  text: string,
  answersToolPermission: boolean,
  run: (finalText: string) => Promise<{ status: number; body: Record<string, unknown> }>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const tainted = isTainted();
  const decision = decide({ autonomy: autonomy(), verb, tainted, answersToolPermission });
  if (decision === 'pass') return run(text);
  const provenance = autonomy() === 'ask' ? 'autonomy is ask'
    : tainted ? 'you read project output since the owner last spoke'
      : 'answering another agent\'s tool-permission prompt';
  const { view, decision: pending } = createProposal({ verb, target, text, provenance });
  // A proposal lives exactly as long as the call that asked for it (see `abandonProposal`).
  const onGone = () => { if (!res.writableEnded) abandonProposal(view.id); };
  res.once('close', onGone);
  // The caller may have gone while the body was parsed, before this listener existed.
  if (res.destroyed || res.socket?.destroyed) onGone();
  const d = await pending;
  res.off('close', onGone);
  if (d.outcome === 'declined') return { status: 200, body: { proposal: view.id, declined: d.reason } };
  const out = await run(d.text);
  return { status: out.status, body: { ...out.body, proposal: view.id, approved: true } };
}

/** POST /api/assistant/broadcast {message, to?: string[], timeoutSec?} */
export async function handleAssistantBroadcast(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!assistantGate(req, res)) return;
  holdOpen(req);
  const body = await parseJsonBody(req);
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) { sendError(res, 400, 'invalid_body', 'message must be a non-empty string.'); return; }
  const to = Array.isArray(body?.to) ? (body!.to as unknown[]).filter((x): x is string => typeof x === 'string' && !!x) : undefined;
  const timeoutSec = typeof body?.timeoutSec === 'number' ? Math.min(Math.max(body.timeoutSec, 10), 1800) : undefined;
  const target = to?.length ? to.join(', ') : 'all projects';
  const out = await gated(res, 'broadcast', target, message, false, async (finalText) => {
    const rows: BroadcastRow[] = await broadcast(finalText, { to, timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined });
    if (rows.some((r) => r.text)) markTainted();
    const replied = rows.filter((r) => r.status === 'replied').length;
    return {
      status: 200,
      body: {
        summary: `written in ${replied} of ${rows.length}`,
        rows: rows.map((r) => ({ vault: r.vault, status: r.status, text: r.text ? wrapUntrusted(r.vault, r.text) : '' })),
      },
    };
  });
  sendJson(res, out.status, out.body);
}

/**
 * POST /api/assistant/look {display?} — a screenshot of the owner's screen(s), for the
 * assistant to Read. Gated like `chat`: free while the owner's own words are the last thing
 * the session heard, a proposal once it has read project output (autonomy.ts).
 */
export async function handleAssistantLook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!assistantGate(req, res)) return;
  holdOpen(req);
  const body = (await parseJsonBody(req)) ?? {};
  const display = typeof body.display === 'number' ? body.display : undefined;
  const target = display ? `display ${display}` : 'every display';
  const out = await gated(res, 'look', target, 'Take a screenshot so the assistant can see your screen.', false, async () => {
    const r = await captureScreens({ dir: join(assistantContextRoot(), 'tmp', 'screens'), display });
    if (!r.ok) return { status: r.error === 'unsupported' ? 501 : 409, body: { ok: false, error: r.error, message: r.message } };
    return { status: 200, body: { ok: true, shots: r.shots, next: 'Read each path to see the screen.' } };
  });
  sendJson(res, out.status, out.body);
}

const UI_VERBS = ['open', 'chat', 'send', 'answer', 'focus', 'tile', 'notify'] as const;
type UiVerb = typeof UI_VERBS[number];

/** Strict-pick each UI verb's args — the body is never spread into the command. */
/** A project page the assistant may open: the same three the chat's `dream-actions` reach. */
const PAGE_RE = /^(tasks|knowledge|core)\/[A-Za-z0-9._-]{1,160}$/;

function pickUiArgs(verb: UiVerb, b: Record<string, unknown>): Record<string, unknown> | string {
  const str = (k: string, max = 20_000) => (typeof b[k] === 'string' && (b[k] as string).length <= max ? (b[k] as string) : '');
  const known = (v: string) => listVaults().some((x) => x.name === v);
  switch (verb) {
    case 'open': {
      const vault = str('vault', 200);
      if (!known(vault)) return `unknown project "${vault}"`;
      const page = str('page', 200);
      if (page && !PAGE_RE.test(page)) return 'page must be tasks/<slug>, knowledge/<slug> or core/<slug>';
      return { vault, page: page || null, newWindow: b.newWindow === true };
    }
    case 'chat': {
      const vault = str('vault', 200);
      if (!known(vault)) return `unknown project "${vault}"`;
      const prompt = str('prompt');
      if (!prompt.trim()) return 'prompt is required';
      const mode = ['basic', 'plan', 'develop'].includes(str('mode', 20)) ? str('mode', 20) : 'basic';
      return { vault, prompt, mode };
    }
    case 'send': {
      const sessionId = str('sessionId', 100);
      const text = str('text');
      if (!sessionId || !text.trim()) return 'sessionId and text are required';
      return { sessionId, text };
    }
    case 'answer': {
      const sessionId = str('sessionId', 100);
      const question = str('question', 200);
      const choice = str('choice', 2000);
      const text = str('text');
      if (!sessionId || !question || (!choice && !text)) return 'sessionId, question and one of choice/text are required';
      return { sessionId, question, choice: choice || null, text: text || null };
    }
    case 'focus': {
      const vault = str('vault', 200);
      if (!known(vault)) return `unknown project "${vault}"`;
      return { vault };
    }
    case 'tile': {
      const vaults = Array.isArray(b.vaults) ? (b.vaults as unknown[]).filter((v): v is string => typeof v === 'string') : [];
      const bad = vaults.find((v) => !known(v));
      if (vaults.length < 1 || bad !== undefined) return bad ? `unknown project "${bad}"` : 'name at least one project';
      const layout = ['columns', 'rows', 'grid'].includes(str('layout', 20)) ? str('layout', 20) : 'columns';
      return { vaults: vaults.slice(0, 12), layout };
    }
    case 'notify': {
      const text = str('text', 500);
      if (!text.trim()) return 'text is required';
      return { text, level: str('level', 20) === 'attention' ? 'attention' : 'info' };
    }
  }
}

/** POST /api/assistant/ui/:verb — relayed to the notch (`no_surface` without one). */
export async function handleAssistantUi(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!assistantGate(req, res)) return;
  holdOpen(req);
  const verb = params.verb as UiVerb;
  if (!(UI_VERBS as readonly string[]).includes(verb)) { sendError(res, 404, 'unknown_verb', `No assistant verb "${params.verb}".`); return; }
  const body = (await parseJsonBody(req)) ?? {};
  const args = pickUiArgs(verb, body);
  if (typeof args === 'string') { sendError(res, 400, 'invalid_args', args); return; }

  const relay = async (a: Record<string, unknown>) => {
    const r = await relayCommand(verb, a);
    return r.ok
      ? { status: 200, body: { ok: true, result: r.result } }
      : { status: r.error === 'no_surface' ? 409 : 200, body: { ok: false, error: r.error } };
  };

  if (verb === 'send' || verb === 'answer') {
    const chat = getChat(String(args.sessionId));
    if (!chat) { sendError(res, 404, 'unknown_session', `No live chat "${String(args.sessionId)}".`); return; }
    // FAIL CLOSED: the registry holds only the LATEST pending prompt, so a permission request
    // it no longer shows (a later question overwrote it, or was answered and cleared it) would
    // read as "not a permission". Only the plain question the registry names is treated as one.
    const pq = chat.pendingQuestion;
    const isPermission = verb === 'answer' && !(pq && pq.requestId === args.question && !pq.isPermission);
    const text = verb === 'send' ? String(args.text) : String(args.choice ?? args.text);
    const out = await gated(res, verb, `${chat.vault} · ${chat.sessionId}`, text, isPermission, (finalText) =>
      relay({ ...args, vault: chat.vault, ...(verb === 'send' ? { text: finalText } : args.choice ? { choice: finalText } : { text: finalText }) }));
    // The Assistant is told when this session next asks, finishes a turn, or closes.
    if (out.body.ok === true) recordDelegation(args.sessionId, chat.vault, verb === 'send' ? args.text : undefined);
    sendJson(res, out.status, out.body);
    return;
  }
  if (verb === 'chat') {
    const out = await gated(res, 'chat', String(args.vault), String(args.prompt), false, (finalPrompt) =>
      relay({ ...args, prompt: finalPrompt }));
    // The window answers `{vault, sessionId}` — the new tab's CLI session id, the one the chat
    // registry keys on (useAssistantDoorbell.ts).
    if (out.body.ok === true) {
      const result = out.body.result as { sessionId?: unknown } | null | undefined;
      recordDelegation(result?.sessionId, args.vault, args.prompt);
    }
    sendJson(res, out.status, out.body);
    return;
  }
  const out = await relay(args);
  sendJson(res, out.status, out.body);
}

// ─── Owner routes (loopback + desktop) ──────────────────────────────────────────────

/**
 * POST /api/assistant/open {vault, page} — the owner clicked a detail button in a notch
 * answer. It rides the SAME relay as the assistant's own `open` (minted here, delivered down
 * the notch's socket, claimed by the project window with its nonce), so a click reaches a
 * project exactly the way a verb does and no second path into a window exists.
 */
export async function handleAssistantOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  holdOpen(req);
  const args = pickUiArgs('open', (await parseJsonBody(req)) ?? {});
  if (typeof args === 'string') { sendError(res, 400, 'invalid_args', args); return; }
  const r = await relayCommand('open', args);
  if (r.ok) sendJson(res, 200, { ok: true, result: r.result });
  else sendJson(res, r.error === 'no_surface' ? 409 : 200, { ok: false, error: r.error });
}

/** GET /api/assistant/status — does the assistant exist, and its public profile. */
export async function handleAssistantStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const exists = assistantExists();
  sendJson(res, 200, {
    exists,
    vault: ASSISTANT_VAULT,
    config: exists ? readAssistantConfig() : null,
    avatar: exists && findAvatar() ? '/api/assistant/avatar' : null,
    proposals: listProposals().length,
  });
}

/**
 * GET /api/assistant/rollup — the notch pill's glance: how many chats are starting / working /
 * stale / asking / idle and how many proposals wait. Counted by ACTIVITY (`activityOf`), not
 * raw status: `working` is only a turn genuinely in flight, a restored tab nobody has typed in
 * is `idle`, and a turn that went silent is `stale`. COUNTS ONLY: no project-derived text, so
 * it neither needs the untrusted wrapper nor taints anything, and the owner gate is enough.
 */
export async function handleAssistantRollup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const counts = { starting: 0, working: 0, stale: 0, asking: 0, idle: 0 };
  const now = Date.now();
  for (const c of listChats({})) {
    const a = activityOf(c, now);
    if (a !== 'gone') counts[a] += 1;
  }
  sendJson(res, 200, { ...counts, proposals: listProposals().length });
}

/** How many live chats the glance lists — a notch row each, never a transcript. */
const GLANCE_MAX = 6;
/** The glance's per-string cap: one line in the notch, not the whole command. */
const GLANCE_TEXT_CAP = 240;

/**
 * GET /api/assistant/glance — the open notch's "what is happening" rows: every chat that is
 * asking, working, starting or stale (idle and gone are left out), asking first. Unlike the
 * rollup this carries project text (the pending prompt), so every such string is wrapped in
 * `<untrusted-project-output>` like any other route; the notch strips the wrapper to draw it.
 * It does NOT taint: the notch is the owner's eyes, not the assistant's.
 */
export async function handleAssistantGlance(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const now = Date.now();
  const rank: Record<string, number> = { asking: 0, working: 1, starting: 2, stale: 3 };
  const clip = (s: string) => (s.length > GLANCE_TEXT_CAP ? `${s.slice(0, GLANCE_TEXT_CAP)}…` : s);
  const chats = listChats({})
    .map((c) => ({ c, activity: activityOf(c, now) }))
    .filter(({ activity }) => activity in rank)
    .sort((a, b) => rank[a.activity] - rank[b.activity] || Date.parse(b.c.lastFrameAt) - Date.parse(a.c.lastFrameAt))
    .slice(0, GLANCE_MAX)
    .map(({ c, activity }) => ({
      sessionId: c.sessionId,
      vault: c.vault,
      activity,
      since: c.updatedAt,
      title: c.title ? wrapUntrusted(c.vault, clip(c.title)) : '',
      ask: activity === 'asking' && c.pendingQuestion
        ? {
          id: c.pendingQuestion.requestId,
          kind: c.pendingQuestion.isPermission ? 'permission' : 'question',
          tool: c.pendingQuestion.toolName,
          text: wrapUntrusted(c.vault, clip(c.pendingQuestion.text)),
        }
        : null,
    }));
  // What the Assistant handed off, live first then the recently closed. The brief is the
  // Assistant's own words, but those may echo project output, so it is wrapped like the rest.
  const delegations = listDelegations(now).map((d) => ({
    sessionId: d.sessionId,
    vault: d.vault,
    activity: d.activity,
    startedAt: d.startedAt,
    endedAt: d.endedAt,
    brief: d.brief ? wrapUntrusted(d.vault, clip(d.brief)) : '',
    lastText: d.lastText ? wrapUntrusted(d.vault, clip(plainPostText(d.lastText))) : '',
    ask: d.pending
      ? { id: d.pending.id, kind: d.pending.kind, tool: d.pending.tool, text: wrapUntrusted(d.vault, clip(d.pending.text)) }
      : null,
  }));
  sendJson(res, 200, { chats, delegations });
}

// ─── The notch inbox (owner) ─────────────────────────────────────────────────────────

const INBOX_TEXT_CAP = 400;
const VAULT_NAME_MAX = 200;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * GET /api/assistant/inbox — what happened while the owner looked elsewhere: chats that
 * finished a turn, account limits and switches (`notch-inbox.ts`), every unread automation post
 * and every automation running right now (`assistant-inbox.ts`), plus which project the owner is
 * looking at. Project text is wrapped like the glance's; the notch only draws it. Never taints:
 * this is the owner's view, not the Assistant's.
 */
export async function handleAssistantInbox(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  wireNotchInbox();
  syncAccountRejections();
  const clip = (s: string) => (s.length > INBOX_TEXT_CAP ? `${s.slice(0, INBOX_TEXT_CAP)}…` : s);
  const events = listNotchEvents().map((e) => (e.kind === 'finished'
    ? { ...e, title: e.title ? wrapUntrusted(e.vault, clip(e.title)) : '', lastText: e.lastText ? wrapUntrusted(e.vault, clip(plainPostText(e.lastText))) : '' }
    : e));
  let posts: ReturnType<typeof unreadAutomationPosts> = [];
  let running: ReturnType<typeof runningAutomations> = [];
  try { posts = unreadAutomationPosts(); } catch { posts = []; }
  try { running = runningAutomations(); } catch { running = []; }
  const muted = readMutedAutomations();
  const vaultOf = new Map(listVaults().map((v) => [v.path, v.name]));
  sendJson(res, 200, {
    lookingAt: lookingAt(),
    events,
    posts: posts.map((p) => ({
      ...p,
      title: wrapUntrusted(p.vault, p.title),
      text: p.text ? wrapUntrusted(p.vault, p.text) : '',
    })),
    running: running.map((r) => ({ ...r, title: wrapUntrusted(r.vault, r.title) })),
    muted: Object.entries(muted).flatMap(([root, slugs]) => {
      const vault = vaultOf.get(root);
      return vault ? slugs.map((slug) => ({ vault, slug })) : [];
    }),
  });
}

/** POST /api/assistant/inbox/dismiss {id} — the owner waved a finish or account notice away. */
export async function handleAssistantInboxDismiss(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  const id = typeof b.id === 'string' && b.id.length <= 200 ? b.id : '';
  if (!id) { sendError(res, 400, 'invalid_args', 'id is required'); return; }
  sendJson(res, 200, { ok: dismissNotchEvent(id) });
}

/** The `{vault, slug}` of an inbox automation call, checked against the registry and the
 *  project's own manifests, or the refusal to send. */
function pickAutomation(b: Record<string, unknown>): { vault: string; slug: string; projectRoot: string; contextRoot: string } | string {
  const vault = typeof b.vault === 'string' && b.vault.length <= VAULT_NAME_MAX ? b.vault : '';
  const slug = typeof b.slug === 'string' && SLUG_RE.test(b.slug) ? b.slug : '';
  if (!vault || !slug) return 'vault and slug are required';
  const p = automationProject(vault);
  if (!p) return `unknown project "${vault}"`;
  if (!getAutomation(p.contextRoot, slug)) return `no automation "${slug}" in ${vault}`;
  return { vault, slug, ...p };
}

/**
 * POST /api/assistant/inbox/seen {vault, slug, upToId} — the eye button, or a click that took the
 * owner to the post. Advances the project's own read watermark (monotonic), the same one its
 * `#agents` channel reads, so the post is read everywhere at once.
 */
export async function handleAssistantInboxSeen(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  const a = pickAutomation(b);
  if (typeof a === 'string') { sendError(res, 400, 'invalid_args', a); return; }
  const upToId = typeof b.upToId === 'string' && b.upToId.length <= 200 ? b.upToId : '';
  if (!upToId) { sendError(res, 400, 'invalid_args', 'upToId is required'); return; }
  markThreadRead(a.contextRoot, a.slug, upToId);
  invalidateAutomationInbox();
  sendJson(res, 200, { ok: true });
}

/** POST /api/assistant/inbox/mute {vault, slug, muted} — never (or again) show this agent's posts in the notch. */
export async function handleAssistantInboxMute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  const a = pickAutomation(b);
  if (typeof a === 'string') { sendError(res, 400, 'invalid_args', a); return; }
  setAutomationMuted(a.projectRoot, a.slug, b.muted !== false);
  invalidateAutomationInbox();
  sendJson(res, 200, { ok: true, muted: b.muted !== false });
}

/**
 * POST /api/assistant/presence {label, vault|null} — a project window says which project it is
 * showing while it has focus (`null` when it lost focus). Decides whether a finished turn is
 * news, and tells the Assistant what the owner is looking at.
 */
export async function handleAssistantPresence(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  const label = typeof b.label === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(b.label) ? b.label : '';
  if (!label) { sendError(res, 400, 'invalid_args', 'label is required'); return; }
  const vault = typeof b.vault === 'string' && listVaults().some((v) => v.name === b.vault) ? b.vault : null;
  wireNotchInbox();
  setPresence(label, vault);
  sendJson(res, 200, { ok: true });
}

/** POST /api/assistant/delegations/dismiss {sessionId} — the owner cleared a closed hand-off. */
export async function handleAssistantDelegationDismiss(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  const sessionId = typeof b.sessionId === 'string' && b.sessionId.length <= 100 ? b.sessionId : '';
  if (!sessionId) { sendError(res, 400, 'invalid_args', 'sessionId is required'); return; }
  sendJson(res, 200, { ok: dismissDelegation(sessionId) });
}

/**
 * POST /api/assistant/answer {sessionId, question, choice: 'allow'|'deny'} — the owner pressed
 * Allow or Deny on a permission row in the notch. The OWNER decided, so no autonomy gate and no
 * proposal: it rides the same `answer` relay the assistant's verb does (claimed by the project
 * window that holds the chat), and is not recorded as a delegation.
 */
export async function handleAssistantOwnerAnswer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  holdOpen(req);
  const b = (await parseJsonBody(req)) ?? {};
  const sessionId = typeof b.sessionId === 'string' && b.sessionId.length <= 100 ? b.sessionId : '';
  const question = typeof b.question === 'string' && b.question.length <= 200 ? b.question : '';
  const choice = b.choice === 'allow' || b.choice === 'deny' ? b.choice : '';
  if (!sessionId || !question || !choice) { sendError(res, 400, 'invalid_args', 'sessionId, question and choice (allow|deny) are required'); return; }
  const chat = getChat(sessionId);
  if (!chat) { sendError(res, 404, 'unknown_session', `No live chat "${sessionId}".`); return; }
  // Only the prompt the registry still shows: a stale row must not answer a newer one.
  if (chat.pendingQuestion?.requestId !== question) { sendError(res, 409, 'not_waiting', 'that prompt is no longer waiting'); return; }
  const r = await relayCommand('answer', { sessionId, question, choice, text: null, vault: chat.vault });
  if (r.ok) sendJson(res, 200, { ok: true, result: r.result });
  else sendJson(res, r.error === 'no_surface' ? 409 : 200, { ok: false, error: r.error });
}

/** Runs a bundled-CLI subcommand in `cwd` — injectable for tests. */
export type AssistantCliRunner = (args: string[], cwd: string) => Promise<void>;
const execFileAsync = promisify(execFile);
const defaultRunner: AssistantCliRunner = async (args, cwd) => {
  const cliEntry = process.env.DREAMCONTEXT_CLI || process.argv[1];
  if (!cliEntry) throw new Error('Could not locate the dreamcontext CLI entry.');
  await execFileAsync(process.execPath, [cliEntry, ...args], { cwd, timeout: 120_000, env: { ...process.env, DREAMCONTEXT_SETUP_INTERNAL: '1' } });
};

/** Write the owner's character into the hidden vault's soul, under ONE `## Character`
 *  section (replaced on every save, never appended twice). */
export function writeCharacter(character: string, home?: string): void {
  const soul = join(assistantContextRoot(home), 'core', '0.soul.md');
  if (!existsSync(soul)) return;
  const raw = readFileSync(soul, 'utf-8');
  const section = `## Character\n\n${character.trim()}\n`;
  const re = /## Character\n[\s\S]*?(?=\n## |$)/;
  const next = re.test(raw) ? raw.replace(re, section) : `${raw.trimEnd()}\n\n${section}`;
  writeFileSync(soul, next, 'utf-8');
}

/**
 * Scaffold the hidden vault with the SAME init + setup the Launcher uses for any project —
 * but never register it. Idempotent: an existing hidden vault only gets its config updated.
 */
export async function createAssistant(
  input: { name: string; character?: string; autonomy?: string },
  runner: AssistantCliRunner = defaultRunner,
  home?: string,
): Promise<void> {
  const root = assistantProjectRoot(home);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(root, { recursive: true });
  if (!assistantExists(home)) {
    await runner(['init', '--yes', '--platforms', 'claude', '--name', input.name, '--description', `${input.name} — the owner's dreamcontext Assistant`], root);
    await runner(['setup', '--defaults', '--platforms', 'claude'], root);
  }
  const config = writeAssistantConfig(sanitizeConfigPatch({ name: input.name, autonomy: input.autonomy }), home);
  // Re-running create on an existing Assistant may change its autonomy under a live session.
  notifyAssistantAutonomy(config.autonomy);
  if (input.character?.trim()) writeCharacter(input.character.slice(0, 4000), home);
}

/** POST /api/assistant/create {name, character?, autonomy?} */
export async function handleAssistantCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const body = await parseJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 40) { sendError(res, 400, 'invalid_name', 'name must be 1-40 characters.'); return; }
  try {
    await createAssistant({ name, character: typeof body?.character === 'string' ? body.character : '', autonomy: typeof body?.autonomy === 'string' ? body.autonomy : undefined });
  } catch (err) {
    sendError(res, 500, 'create_failed', `Could not create the assistant: ${(err as Error).message}`);
    return;
  }
  sendJson(res, 200, { created: true, config: readAssistantConfig() });
}

/** GET /api/assistant/profile */
export async function handleAssistantProfileGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  if (!assistantExists()) { sendError(res, 404, 'no_assistant', 'The dreamcontext Assistant has not been created yet.'); return; }
  let character = '';
  try {
    const soul = readFileSync(join(assistantContextRoot(), 'core', '0.soul.md'), 'utf-8');
    character = /## Character\n\n?([\s\S]*?)(?=\n## |$)/.exec(soul)?.[1]?.trim() ?? '';
  } catch { /* no soul */ }
  sendJson(res, 200, { config: readAssistantConfig(), character, avatar: findAvatar() ? '/api/assistant/avatar' : null });
}

/** POST /api/assistant/profile {…config patch, character?} */
export async function handleAssistantProfileSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  if (!assistantExists()) { sendError(res, 404, 'no_assistant', 'The dreamcontext Assistant has not been created yet.'); return; }
  const body = (await parseJsonBody(req)) ?? {};
  const config = writeAssistantConfig(sanitizeConfigPatch(body));
  // Autonomy is argv on the live session (permission mode, --allowedTools): a change respawns
  // it in place with --resume before its next turn. A no-op when it did not change.
  notifyAssistantAutonomy(config.autonomy);
  if (typeof body.character === 'string') writeCharacter(body.character.slice(0, 4000));
  sendJson(res, 200, { config });
}

/** Read a raw request body with a hard byte cap. Over the cap → null (and the socket is
 *  drained, not destroyed, so the 413 can still be written). */
function readRawBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { over = true; chunks.length = 0; return; }
      if (!over) chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/** POST /api/assistant/avatar — raw image bytes. The file NAME is never read from the client. */
export async function handleAssistantAvatarSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  if (!assistantExists()) { sendError(res, 404, 'no_assistant', 'The dreamcontext Assistant has not been created yet.'); return; }
  const buf = await readRawBody(req, AVATAR_MAX_BYTES);
  if (!buf) { sendError(res, 413, 'too_large', 'the image is over 2 MB'); return; }
  try {
    const { ext } = writeAvatar(buf);
    sendJson(res, 200, { ok: true, ext, url: '/api/assistant/avatar' });
  } catch (err) {
    if (err instanceof AvatarError) { sendError(res, err.code === 'too_large' ? 413 : 400, err.code, err.message); return; }
    throw err;
  }
}

/** GET /api/assistant/avatar */
export async function handleAssistantAvatarGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const a = findAvatar();
  if (!a) { sendError(res, 404, 'no_avatar', 'No avatar.'); return; }
  const type = a.ext === 'png' ? 'image/png' : a.ext === 'jpg' ? 'image/jpeg' : 'image/webp';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': statSync(a.path).size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  createReadStream(a.path).pipe(res);
}

/** GET /api/assistant/proposals */
export async function handleAssistantProposalsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  sendJson(res, 200, { proposals: listProposals() });
}

/** POST /api/assistant/proposals/:id {action: approve|edit|reject, text?} */
export async function handleAssistantProposalDecide(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!ownerGate(req, res)) return;
  const body = (await parseJsonBody(req)) ?? {};
  const action = body.action;
  if (action !== 'approve' && action !== 'edit' && action !== 'reject') { sendError(res, 400, 'invalid_action', 'action must be approve, edit or reject.'); return; }
  const ok = resolveProposal(params.id, action, typeof body.text === 'string' ? body.text : undefined);
  if (!ok) { sendError(res, 404, 'unknown_proposal', 'No such pending proposal.'); return; }
  sendJson(res, 200, { ok: true });
}

// ─── Relay plumbing (vault windows + notch) ──────────────────────────────────────────

/** POST /api/assistant/windows {vault, label} → {nonce} — a vault window registers itself. */
export async function handleAssistantWindowRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const body = (await parseJsonBody(req)) ?? {};
  const vault = typeof body.vault === 'string' ? body.vault : '';
  const label = typeof body.label === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(body.label) ? body.label : '';
  if (!listVaults().some((v) => v.name === vault) || !label) { sendError(res, 400, 'invalid_window', 'Unknown vault or bad window label.'); return; }
  const page = typeof body.page === 'string' && /^[0-9a-f]{16,64}$/.test(body.page) ? body.page : '';
  sendJson(res, 200, { nonce: registerWindow(vault, label, page) });
}

/** POST /api/assistant/windows/release {nonce} — a project instance unmounted. */
export async function handleAssistantWindowRelease(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  const body = (await parseJsonBody(req)) ?? {};
  releaseWindowNonce(String(body.nonce ?? ''));
  sendJson(res, 200, { ok: true });
}

/** GET /api/assistant/windows?vault=<v> → {labels} — which windows hold a live instance of it. */
export async function handleAssistantWindowLookup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerGate(req, res)) return;
  sendJson(res, 200, { labels: windowLabelsForVault(q(req).get('vault') ?? '') });
}

/** POST /api/assistant/commands/:id/bind {vault, label} — the notch names the target window. */
export async function handleAssistantCommandBind(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!ownerGate(req, res)) return;
  const body = (await parseJsonBody(req)) ?? {};
  const ok = bindCommandToWindow(params.id, String(body.vault ?? ''), String(body.label ?? ''));
  if (!ok) { sendError(res, 404, 'unknown_command', 'No bindable command.'); return; }
  sendJson(res, 200, { ok: true });
}

/** POST /api/assistant/commands/:id/claim {vault, nonce} — a doorbell is answered. */
export async function handleAssistantCommandClaim(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!ownerGate(req, res)) return;
  const body = (await parseJsonBody(req)) ?? {};
  const vault = String(body.vault ?? '');
  const nonce = String(body.nonce ?? '');
  const cmd = windowVault(nonce) === vault ? claimCommand(params.id, vault, nonce) : null;
  if (!cmd) { sendError(res, 404, 'unknown_command', 'No such command for this window.'); return; }
  sendJson(res, 200, cmd);
}

/** POST /api/assistant/commands/:id/result {vault, nonce, ok, result?, error?} */
export async function handleAssistantCommandResult(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!ownerGate(req, res)) return;
  const body = (await parseJsonBody(req)) ?? {};
  const from = { vault: String(body.vault ?? ''), windowNonce: String(body.nonce ?? '') };
  const r = body.ok === true
    ? { ok: true as const, result: body.result ?? null }
    : { ok: false as const, error: typeof body.error === 'string' ? body.error.slice(0, 300) : 'failed' };
  if (!deliverResult(params.id, r, from)) { sendError(res, 404, 'unknown_command', 'No such command for this window.'); return; }
  sendJson(res, 200, { ok: true });
}
