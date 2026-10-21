import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isCrossSiteRequest, isLoopback, requireLocalDesktop } from './agent-spawn-shared.js';
import {
  WINDOW_TOKEN_HEADER, channelFor, identityOf, sendSuperCommand, sendWindowCommand, type WindowIdentity,
} from '../../lib/window-control.js';
import { SuperStoreRefused, isReservedId, readSuperState } from '../../lib/super/store.js';
import {
  CONTAINER_KINDS, CONTAINER_SHAPES, MAX_BRIEF, MAX_CONTAINERS, MAX_OWNER_TEXT, MAX_PRESENT, MAX_READ_BYTES,
  MAX_TITLE, MIN_GROUP_CARDS, SESSION_ID_RE, SUPER_VERBS, applyGroupOp, defaultShape, dissolveGroups, leaveGroups,
  type ContainerKind, type ContainerShape, type SuperChild, type SuperState, type SuperStateView, type SuperVerb,
} from '../../lib/super/types.js';
import {
  containerIdFor, ensureChatContainer, newQueueId, noteOwnerActivity, pumpSuper, superQueueHead,
  superSanitizeOpts, superVaultName, superView, writeSuper,
} from '../../lib/super/inbox.js';
import { disableSuper, enableSuper } from '../../lib/super/handover.js';
import { findLiveChat } from './agent-chat-live.js';
import { delegationAllowed, readCapacityFacts } from '../../lib/super/capacity.js';
import {
  WorktreeRefused, createChildWorktree, discardFreshWorktree, mergeChildren, removeChildWorktree, repoOfWorktree,
  worktreeStatus, type CreatedWorktree,
} from '../../lib/super/worktrees.js';
import { DEFAULT_READ_BYTES, readLastReply, readTail, renderTail } from '../../lib/super/transcript-tail.js';
import { validateSuperWebUrl } from '../../lib/super/web-url.js';
import { activityOf, getChat } from '../../lib/assistant/chat-registry.js';
import { wrapUntrusted } from '../../lib/assistant/autonomy.js';
import { liveTranscriptPath } from '../../lib/transcript-locate.js';
import { sanitizeModel } from '../../lib/claude-args.js';
import { findParkable, parkChat, parkedSince, type ParkOutcome } from '../chat-park.js';
import { readLimitSignal } from '../../lib/claude-limit-signal.js';
import { SUCCESSOR_STOP_TEXT, ownershipWarnings, succeedChild } from '../../lib/super/succession.js';
import { addToOutbox } from '../../lib/super/outbox.js';
import { cachedLeftovers, defaultPlaces, diskUsage, forgetLeftovers, oldTestTmp } from '../../lib/super/disk-leftovers.js';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * The Super Agent's routes (task chat-gets-a-super-agent-mode…, plan-r7 D4).
 *
 * TWO DOORS, two kinds of caller:
 *
 *  - `POST /api/super/v/:verb` — the super agent's own verbs (`dreamcontext super <verb>`).
 *    Loopback first, then the per-chat window token, and the token must belong to THE vault's
 *    recorded super session, spawned in `super` mode. A basic chat's token, another vault's
 *    super token, a child's token: all refused. Vault-agnostic like `/api/window`: the token
 *    names the vault.
 *
 *  - `GET /api/super/state`, `POST /api/super/enable|disable|layout|activity|recap` — the
 *    OWNER's window. Desktop app + loopback + loopback Host (`requireLocalDesktop`), refused
 *    as a cross-site request (a foreign `Origin` or `Sec-Fetch-Site: cross-site`), and denied
 *    on the phone/tunnel surface by the route policy. Vault-bound: the window names its vault.
 *
 * These checks bind dreamcontext's OWN verbs. The super agent's shell is a chat's shell like
 * any other (D15, the stated limit): nothing here pretends otherwise.
 *
 * Child text reaching the agent (`state`'s briefs and last lines, `read`) is fenced with
 * `wrapUntrusted` (D10).
 */

type Params = Record<string, string>;

const MAX_TEXT = 100_000;
const MODES = ['basic', 'plan', 'develop'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const SLUG_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const DELEGATE_TIMEOUT_MS = 30_000;
/** How long past the frame's `deadline` the server still waits for the window's answer. */
const DELEGATE_GRACE_MS = 5_000;

/** The vault's registered name for a context root (the chat registry's own fallback otherwise). */
export function vaultNameOf(contextRoot: string): string {
  return superVaultName(contextRoot);
}

export function superStateView(contextRoot: string, state: SuperState): SuperStateView {
  return superView(contextRoot, state);
}

/** Why a store read failed, as the route's answer. */
function storeRefusal(res: ServerResponse, err: unknown): void {
  if (err instanceof SuperStoreRefused) { sendError(res, 409, 'super_state_refused', err.message); return; }
  if (err instanceof WorktreeRefused) { sendJson(res, 409, { ok: false, error: err.code, message: err.message, ...err.details }); return; }
  sendError(res, 500, 'super_state_unreadable', 'The Super Agent state could not be read.');
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
// eslint-disable-next-line no-control-regex
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const refuse = (res: ServerResponse, status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  sendJson(res, status, { ok: false, error, message, ...extra });

// ─── The agent's door ────────────────────────────────────────────────────────

export interface SuperCaller {
  /** The calling chat's live window token (its own socket). */
  token: string;
  who: WindowIdentity;
  state: SuperState;
}

export type SuperVerbHandler = (caller: SuperCaller, body: Record<string, unknown>, res: ServerResponse) => Promise<void>;

/**
 * Who may call an agent verb: a live window token whose chat is the vault's recorded super
 * session and runs in `super` mode. Sends the refusal itself; null = refused.
 */
export async function authorizeSuperAgent(req: IncomingMessage, res: ServerResponse): Promise<SuperCaller | null> {
  if (!isLoopback(req)) { sendError(res, 403, 'super_local_only', 'The Super Agent is only reachable from this machine.'); return null; }
  const token = channelFor(req.headers[WINDOW_TOKEN_HEADER]);
  if (!token) { sendError(res, 401, 'not_a_chat', 'only the Super Agent running in a dreamcontext chat can use these verbs (or that chat has ended)'); return null; }
  const who = identityOf(token);
  if (!who || who.mode !== 'super') { sendError(res, 403, 'not_the_super_agent', 'only the project\'s Super Agent can use `dreamcontext super`'); return null; }
  let state: SuperState;
  try {
    state = await readSuperState(who.contextRoot, superSanitizeOpts());
  } catch (err) { storeRefusal(res, err); return null; }
  if (!state.session || state.session !== who.sessionId) {
    sendError(res, 403, 'not_the_super_agent', 'this chat is not the project\'s recorded Super Agent');
    return null;
  }
  return { token, who, state };
}

/** A recorded child of the caller's vault, or the refusal sent. */
/** Own keys only: a caller-given id never reaches Object.prototype (`__proto__`, `constructor`). */
const hasChild = (state: SuperState, id: string): boolean =>
  !isReservedId(id) && Object.prototype.hasOwnProperty.call(state.children, id);

function childArg(c: SuperCaller, b: Record<string, unknown>, res: ServerResponse): string | null {
  const child = str(b.child);
  if (!child || !SESSION_ID_RE.test(child) || !hasChild(c.state, child)) {
    refuse(res, 404, 'unknown_child', 'name one of your children (`dreamcontext super state` lists them)');
    return null;
  }
  return child;
}

function requireHandedOver(c: SuperCaller, res: ServerResponse): boolean {
  if (c.state.enabled) return true;
  refuse(res, 409, 'not_handed_over', 'the owner has taken the screen back; you wait until the next hand-over');
  return false;
}

/** A container ref, validated for its kind (D10: a web URL is https on another host). */
/** A container ref, validated for its kind against a record (the agent's `open` and the owner's
 *  `layout` both run it). */
export function refForState(state: SuperState, kind: ContainerKind, raw: unknown): { ref: string } | { error: string } {
  return refFor({ state } as SuperCaller, kind, raw);
}

function refFor(c: Pick<SuperCaller, 'state'>, kind: ContainerKind, raw: unknown): { ref: string } | { error: string } {
  const ref = typeof raw === 'string' ? raw.trim() : '';
  if (!ref) return { error: 'ref is required' };
  switch (kind) {
    case 'chat':
      return hasChild(c.state, ref) ? { ref } : { error: 'a chat container shows one of your children: give its session id' };
    case 'web': {
      const w = validateSuperWebUrl(ref);
      return w.ok ? { ref: w.href } : { error: `a web container shows an https page on another host (${w.reason})` };
    }
    case 'image': {
      if (ref.length > 1024 || ref.startsWith('/') || ref.includes('\\') || ref.split('/').some((s) => s === '..' || s === '' || s === '.')) {
        return { error: 'an image is a project-relative path with no ".." steps' };
      }
      return IMAGE_EXT_RE.test(ref) ? { ref } : { error: 'an image is a .png, .jpg, .gif, .webp or .svg file' };
    }
    default:
      if (!SLUG_REF_RE.test(ref) || ref.split('/').some((s) => s === '..' || s === '.' || s === '')) return { error: `a ${kind} container names its slug` };
      return { ref };
  }
}

function containerArg(c: SuperCaller, b: Record<string, unknown>, res: ServerResponse): string | null {
  const id = str(b.container);
  if (!id || !c.state.containers.some((k) => k.id === id)) {
    refuse(res, 404, 'unknown_container', 'no such container (`dreamcontext super state` lists them)');
    return null;
  }
  return id;
}

const ok = (res: ServerResponse, result: unknown) => sendJson(res, 200, { ok: true, result });

/** A card or a group the record holds, by id (`super stack|float` take either). */
function targetArg(c: SuperCaller, b: Record<string, unknown>, res: ServerResponse): { id: string; group: boolean } | null {
  const id = str(b.container);
  if (id && c.state.groups.some((g) => g.id === id)) return { id, group: true };
  if (id && c.state.containers.some((k) => k.id === id)) return { id, group: false };
  refuse(res, 404, 'unknown_container', 'no such card or group (`dreamcontext super state` lists them)');
  return null;
}

/** A new group's id: never a container id (those start with their kind). */
function newGroupId(): string {
  return `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `delegate` calls in flight per vault, counted against the cap until they settle. */
const delegating = new Map<string, number>();

function worktreePreamble(w: CreatedWorktree): string {
  return `You work in your own git worktree: ${w.path} (branch ${w.branch}, repo ${w.repo}). `
    + 'cd there first, then work and commit only there. Never push and never merge into another branch.';
}

const firstLine = (text: string, max: number) => {
  const line = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Each verb's work. */
export const SUPER_VERB_HANDLERS: Record<SuperVerb, SuperVerbHandler> = {
  state: async (c, _b, res) => {
    const root = c.who.contextRoot;
    const vault = vaultNameOf(root);
    const now = Date.now();
    const children: Record<string, SuperChild & Record<string, unknown>> = {};
    const status: Array<Record<string, unknown>> = [];
    for (const [sid, ch] of Object.entries(c.state.children)) {
      const e = getChat(sid);
      const live = liveChildStatus(ch, e ? activityOf(e, now) : null, parkedSince(sid) !== null);
      const { line: last, limit } = childLastLine(e?.lastAssistantText ?? [], live);
      const row = {
        status: live,
        ...(ch.endedAt !== undefined ? { endedAt: ch.endedAt } : {}),
        elapsedMs: Math.max(0, now - ch.startedAt),
        lastLine: last ? wrapUntrusted(vault, last.length > 600 ? `${last.slice(0, 600)}…` : last) : '',
        ...(limit ? { limit: wrapUntrusted(vault, limit) } : {}),
        asking: e?.pendingQuestion ? { requestId: e.pendingQuestion.requestId, kind: e.pendingQuestion.isPermission ? 'permission' : 'question' } : null,
      };
      // The live row rides on the child itself; `status[]` stays for older readers.
      children[sid] = { ...ch, brief: ch.brief ? wrapUntrusted(vault, ch.brief) : '', ...row };
      status.push({ sessionId: sid, ...row, ...(ch.worktree ? { worktree: ch.worktree, branch: ch.branch } : {}) });
    }
    let machine: unknown = null;
    try { machine = await readCapacityFacts(); } catch { machine = null; }
    // The largest leftovers on disk (last measurement; the next one runs in the background).
    if (machine && typeof machine === 'object') {
      const left = cachedLeftovers(() => defaultPlaces([dirname(root)]));
      machine = { ...machine, leftovers: left.top, leftoversMeasuredAt: left.measuredAt };
    }
    // Container titles can be child text (an adopted chat's tab title or last reply): fenced
    // like every other child-derived string (D10).
    const containers = c.state.containers.map((k) => (k.title ? { ...k, title: wrapUntrusted(vault, k.title) } : k));
    const fenceQ = (q: SuperState['queue'][number]) => (q.ownerText ? { ...q, ownerText: wrapUntrusted(vault, q.ownerText) } : q);
    const head = superQueueHead(c.state);
    const warnings = ownershipWarnings(c.state, (sid) => {
      const st = (children[sid] as { status?: unknown } | undefined)?.status;
      return st !== 'ended' && st !== 'gone' && st !== 'parked';
    });
    ok(res, { ...superStateView(root, c.state), children, containers, queue: c.state.queue.map(fenceQ), status, head: head ? fenceQ(head) : null, machine, ...(warnings.length ? { warnings } : {}) });
  },

  delegate: async (c, b, res) => {
    if (!requireHandedOver(c, res)) return;
    const root = c.who.contextRoot;
    const prompt = typeof b.prompt === 'string' ? b.prompt : '';
    if (!prompt.trim()) { refuse(res, 400, 'invalid_args', '--prompt is required'); return; }
    if (prompt.length > MAX_TEXT) { refuse(res, 400, 'invalid_args', 'the prompt is too long'); return; }
    const mode = str(b.mode) ?? 'basic';
    if (!(MODES as readonly string[]).includes(mode)) { refuse(res, 400, 'invalid_args', `mode must be one of ${MODES.join(' | ')}`); return; }
    const model = str(b.model);
    if (model && !sanitizeModel(model)) { refuse(res, 400, 'invalid_args', 'model is not a model id'); return; }
    const effort = str(b.effort);
    if (effort && !(EFFORTS as readonly string[]).includes(effort)) { refuse(res, 400, 'invalid_args', `effort must be one of ${EFFORTS.join(' | ')}`); return; }
    const brief = oneLine(str(b.brief) ?? '').slice(0, MAX_BRIEF);
    // One job, one owner: the child this one takes the work over from (succession.ts).
    const succeeds = str(b.succeeds);
    if (succeeds !== undefined && (!SESSION_ID_RE.test(succeeds) || !c.state.children[succeeds] || succeeds === c.state.session)) {
      refuse(res, 404, 'unknown_child', '--succeeds names none of your children (`dreamcontext super state` lists them)');
      return;
    }
    const title = (brief || (succeeds ? c.state.children[succeeds].brief : '') || firstLine(prompt, 60)).slice(0, MAX_TITLE);

    // D11: the cap binds NEW delegations (calls in flight count too).
    const inFlight = delegating.get(root) ?? 0;
    const room = delegationAllowed(c.state);
    if (room.live + inFlight >= room.max) {
      let machine: unknown = null;
      try { machine = await readCapacityFacts(); } catch { machine = null; }
      refuse(res, 409, 'held', `${room.live + inFlight} children are running (at most ${room.max}); queue this work until one finishes, or ask the owner`, {
        held: true, live: room.live + inFlight, max: room.max, machine,
      });
      return;
    }
    delegating.set(root, inFlight + 1);
    let wt: CreatedWorktree | null = null;
    try {
      if (b.worktree !== undefined && b.worktree !== null && b.worktree !== '') {
        wt = await createChildWorktree({ projectRoot: dirname(root), repo: b.worktree, slug: b.slug, base: b.base });
      }
      // The window refuses the frame after `deadline` (epoch ms); the server waits that long
      // plus a grace, so a child the window opens is (almost always) answered in time. A frame
      // that may still have opened a child never loses its worktree (review W2 #1).
      const deadline = Date.now() + DELEGATE_TIMEOUT_MS;
      const r = await sendSuperCommand(c.token, 'delegate', {
        prompt: wt ? `${worktreePreamble(wt)}\n\n${prompt}` : prompt,
        mode, model: model ?? '', effort: effort ?? '', brief, title, deadline,
      }, { timeoutMs: DELEGATE_TIMEOUT_MS + DELEGATE_GRACE_MS });
      const sid = r.ok && r.result && typeof r.result === 'object' ? (r.result as { sessionId?: unknown }).sessionId : undefined;
      if (!r.ok || typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) {
        // Unconfirmed: the window timed out (it may still have opened the child) or answered
        // without a session id. The worktree stays; the agent checks before delegating again.
        // Discard ONLY when no child can exist: the window refused (its own error), or the frame
        // never reached a window (`sent: false`). A frame that was sent and not answered — a
        // timeout, or the super process ending under it — may have opened a child (M4).
        const unconfirmed = r.ok || (r.error === 'no_window' && r.sent !== false);
        if (unconfirmed) {
          refuse(res, 409, 'delegate_unconfirmed', 'the window did not confirm the child in time; it may still have opened. Check `dreamcontext super state` before delegating again'
            + (wt ? `; the worktree ${wt.path} (${wt.branch}) is kept` : ''), wt ? { worktree: wt.path, branch: wt.branch } : {});
          return;
        }
        // Refused by the window, or never sent (no socket): no child was told about the worktree.
        if (wt) await discardFreshWorktree(wt).catch(() => undefined);
        refuse(res, r.error === 'no_window' ? 409 : 502, r.error, r.error === 'no_window'
          ? 'no window is showing the Super Agent right now'
          : 'the window could not open the child chat');
        return;
      }
      let container: string | null = null;
      await writeSuper(root, (s) => {
        s.children[sid] = {
          sessionId: sid, brief: brief || title, adopted: false, startedAt: Date.now(),
          ...(mode !== 'basic' ? { mode } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
          ...(wt ? { worktree: wt.path, branch: wt.branch } : {}),
        };
        delete s.notes[sid];
        container = (succeeds ? succeedChild(s, succeeds, sid, { brief }) : null) ?? ensureChatContainer(s, sid, title);
      });
      const predecessor = succeeds ? await retirePredecessor(c, succeeds) : null;
      ok(res, { sessionId: sid, container, ...(wt ? { worktree: wt.path, branch: wt.branch } : {}), ...(predecessor ? { predecessor } : {}) });
    } catch (err) {
      if (err instanceof WorktreeRefused) { refuse(res, 409, err.code, err.message, err.details); return; }
      storeRefusal(res, err);
    } finally {
      const n = (delegating.get(root) ?? 1) - 1;
      if (n > 0) delegating.set(root, n); else delegating.delete(root);
    }
  },

  open: async (c, b, res) => {
    const kind = str(b.kind);
    if (!kind || !(CONTAINER_KINDS as readonly string[]).includes(kind)) { refuse(res, 400, 'invalid_args', `kind must be one of ${CONTAINER_KINDS.join(' | ')}`); return; }
    const shapeArg = str(b.shape);
    if (shapeArg && !(CONTAINER_SHAPES as readonly string[]).includes(shapeArg)) { refuse(res, 400, 'invalid_args', `shape must be one of ${CONTAINER_SHAPES.join(' | ')}`); return; }
    const r = refFor(c, kind as ContainerKind, b.ref);
    if ('error' in r) { refuse(res, 400, 'invalid_ref', r.error); return; }
    const title = str(b.title) ? oneLine(str(b.title) as string).slice(0, MAX_TITLE) : undefined;
    const id = containerIdFor(kind, r.ref);
    const existing = c.state.containers.find((k) => k.id === id);
    if (!existing && c.state.containers.length >= MAX_CONTAINERS) {
      refuse(res, 409, 'too_many_containers', `at most ${MAX_CONTAINERS} containers; close one first`);
      return;
    }
    const state = await writeSuper(c.who.contextRoot, (s) => {
      const have = s.containers.find((k) => k.id === id);
      if (have) {
        // Re-opening brings it back from Others and keeps the owner's drop position.
        if (shapeArg) have.shape = shapeArg as ContainerShape;
        have.place = 'float';
        if (title) have.title = title;
        return;
      }
      if (s.containers.length >= MAX_CONTAINERS) return;
      s.containers.push({
        id, kind: kind as ContainerKind, ref: r.ref,
        shape: (shapeArg as ContainerShape | undefined) ?? defaultShape(kind as ContainerKind),
        place: 'float', ...(title ? { title } : {}),
      });
    });
    const made = state.containers.find((k) => k.id === id);
    if (!made) { refuse(res, 409, 'too_many_containers', `at most ${MAX_CONTAINERS} containers; close one first`); return; }
    ok(res, { container: made });
  },

  shape: async (c, b, res) => {
    const id = containerArg(c, b, res);
    if (!id) return;
    const shape = str(b.shape);
    if (!shape || !(CONTAINER_SHAPES as readonly string[]).includes(shape)) { refuse(res, 400, 'invalid_args', `shape must be one of ${CONTAINER_SHAPES.join(' | ')}`); return; }
    await writeSuper(c.who.contextRoot, (s) => { const k = s.containers.find((x) => x.id === id); if (k) k.shape = shape as ContainerShape; });
    ok(res, { container: id, shape });
  },

  half: async (c, b, res) => {
    // `--off` (no card): back to the floating stage.
    if (b.container === null || b.container === undefined || b.container === '') {
      await writeSuper(c.who.contextRoot, (s) => { s.view = { mode: 'float' }; });
      ok(res, { view: { mode: 'float' } });
      return;
    }
    const id = containerArg(c, b, res);
    if (!id) return;
    const state = await writeSuper(c.who.contextRoot, (s) => {
      const k = s.containers.find((x) => x.id === id);
      if (!k) return;
      k.place = 'float';
      s.view = { mode: 'half', card: id };
    });
    ok(res, { view: state.view });
  },

  present: async (c, b, res) => {
    const raw = Array.isArray(b.containers) ? b.containers : [];
    if (raw.length === 0) {
      await writeSuper(c.who.contextRoot, (s) => { s.view = { mode: 'float' }; });
      ok(res, { view: { mode: 'float' } });
      return;
    }
    if (raw.length > MAX_PRESENT) { refuse(res, 400, 'invalid_args', `present shows at most ${MAX_PRESENT} cards`); return; }
    const ids: string[] = [];
    for (const x of raw) {
      const id = typeof x === 'string' ? x : '';
      if (!id || !c.state.containers.some((k) => k.id === id)) {
        refuse(res, 404, 'unknown_container', 'no such container (`dreamcontext super state` lists them)');
        return;
      }
      if (!ids.includes(id)) ids.push(id);
    }
    const state = await writeSuper(c.who.contextRoot, (s) => {
      for (const k of s.containers) if (ids.includes(k.id)) k.place = 'float';
      s.view = { mode: 'present', cards: ids };
    });
    ok(res, { view: state.view });
  },

  stack: async (c, b, res) => {
    const t = targetArg(c, b, res);
    if (!t) return;
    const id = t.id;
    if (t.group) {
      await writeSuper(c.who.contextRoot, (s) => { const g = s.groups.find((x) => x.id === id); if (g) g.place = 'others'; });
      ok(res, { group: id, place: 'others' });
      return;
    }
    await writeSuper(c.who.contextRoot, (s) => {
      // A card stacked on its own leaves its group.
      leaveGroups(s, [id]);
      const k = s.containers.find((x) => x.id === id);
      if (k) k.place = 'others';
      // A stacked card leaves the half page or the presentation it was in.
      if (s.view.mode === 'half' && s.view.card === id) s.view = { mode: 'float' };
      if (s.view.mode === 'present' && s.view.cards) s.view = { mode: 'present', cards: s.view.cards.filter((x) => x !== id) };
    });
    ok(res, { container: id, place: 'others' });
  },

  float: async (c, b, res) => {
    const t = targetArg(c, b, res);
    if (!t) return;
    const id = t.id;
    if (t.group) {
      await writeSuper(c.who.contextRoot, (s) => { const g = s.groups.find((x) => x.id === id); if (g) { g.place = 'float'; delete g.pos; } });
      ok(res, { group: id, place: 'float' });
      return;
    }
    await writeSuper(c.who.contextRoot, (s) => {
      leaveGroups(s, [id]);
      const k = s.containers.find((x) => x.id === id);
      if (!k) return;
      // The agent never positions a card: floating again means placed automatically.
      k.place = 'float';
      delete k.pos;
    });
    ok(res, { container: id, place: 'float' });
  },

  close: async (c, b, res) => {
    if (typeof b.container === 'string' && c.state.groups.some((g) => g.id === b.container)) {
      refuse(res, 400, 'invalid_args', 'a group is not closed: `super ungroup` it, or close its cards');
      return;
    }
    const id = containerArg(c, b, res);
    if (!id) return;
    // The store drops a closed card from the view (half → float; a presentation keeps the rest).
    await writeSuper(c.who.contextRoot, (s) => { s.containers = s.containers.filter((x) => x.id !== id); });
    ok(res, { closed: id });
  },

  group: async (c, b, res) => {
    // Cards put together as one tile (owner decision 2026-10-20). A group id among them: the
    // cards join it (and --name renames it). Otherwise two or more cards make a new group that
    // stands where the first of them stands.
    const raw = Array.isArray(b.containers) ? b.containers : [];
    const name = typeof b.name === 'string' ? b.name : undefined;
    if (raw.length > MAX_CONTAINERS + 1 || raw.some((x) => typeof x !== 'string')) { refuse(res, 400, 'invalid_args', 'name the cards (and at most one group) to put together'); return; }
    const ids = [...new Set(raw as string[])];
    const groupIds = ids.filter((id) => c.state.groups.some((g) => g.id === id));
    const cards = ids.filter((id) => !groupIds.includes(id));
    for (const id of cards) {
      if (!c.state.containers.some((k) => k.id === id)) { refuse(res, 404, 'unknown_container', `no such card: ${id} (\`dreamcontext super state\` lists them)`); return; }
    }
    if (groupIds.length > 1) { refuse(res, 400, 'invalid_args', 'name at most one group; `super ungroup` the other first'); return; }
    let id = groupIds[0];
    if (!id) {
      if (cards.length < MIN_GROUP_CARDS) { refuse(res, 400, 'invalid_args', `a group needs at least ${MIN_GROUP_CARDS} cards`); return; }
      id = newGroupId();
    } else if (!cards.length && !name) { refuse(res, 400, 'invalid_args', 'name cards to add to the group, or --name to rename it'); return; }
    const state = await writeSuper(c.who.contextRoot, (s) => applyGroupOp(s, { id, cards, name }));
    const made = state.groups.find((g) => g.id === id);
    if (!made) { refuse(res, 409, 'not_grouped', 'the cards could not be grouped (closed meanwhile?)'); return; }
    ok(res, { group: made });
  },

  ungroup: async (c, b, res) => {
    // A group id dissolves the group (its cards float again where it stood); a card id takes
    // that card out of its group.
    const raw = Array.isArray(b.targets) ? b.targets : [];
    if (!raw.length || raw.length > MAX_CONTAINERS || raw.some((x) => typeof x !== 'string')) { refuse(res, 400, 'invalid_args', 'name a group, or cards to take out of their group'); return; }
    const ids = [...new Set(raw as string[])];
    for (const id of ids) {
      if (!c.state.groups.some((g) => g.id === id) && !c.state.containers.some((k) => k.id === id)) {
        refuse(res, 404, 'unknown_container', `no such card or group: ${id}`);
        return;
      }
    }
    const state = await writeSuper(c.who.contextRoot, (s) => {
      dissolveGroups(s, ids.filter((id) => s.groups.some((g) => g.id === id)));
      leaveGroups(s, ids);
    });
    ok(res, { ungrouped: ids, groups: state.groups });
  },

  brief: async (c, b, res) => {
    const child = childArg(c, b, res);
    if (!child) return;
    const line = oneLine(typeof b.line === 'string' ? b.line : '').slice(0, MAX_BRIEF);
    if (!line) { refuse(res, 400, 'invalid_args', 'the reminder line is empty'); return; }
    await writeSuper(c.who.contextRoot, (s) => { const ch = s.children[child]; if (ch) ch.brief = line; });
    ok(res, { child, brief: line });
  },

  read: async (c, b, res) => {
    const child = childArg(c, b, res);
    if (!child) return;
    const root = c.who.contextRoot;
    const raw = typeof b.bytes === 'number' && Number.isFinite(b.bytes) && b.bytes > 0;
    const want = raw ? Math.min(b.bytes as number, MAX_READ_BYTES) : DEFAULT_READ_BYTES;
    const path = liveTranscriptPath(root, child);
    if (!path) { refuse(res, 404, 'no_transcript', 'that child has no transcript yet'); return; }
    try {
      // The default is the child's last reply, whole; `--bytes` asks for the raw tail.
      if (!raw) {
        const reply = await readLastReply(path);
        if (reply.text) {
          ok(res, { child, reply: true, status: childStatus(child), at: reply.at, size: reply.size, text: wrapUntrusted(vaultNameOf(root), reply.text) });
          return;
        }
      }
      const tail = await readTail(path, want);
      const text = renderTail(tail);
      ok(res, {
        child, bytesRead: tail.bytesRead, size: tail.size, truncated: tail.truncated,
        text: wrapUntrusted(vaultNameOf(root), text || '(nothing readable at the end of this transcript)'),
      });
    } catch {
      refuse(res, 404, 'no_transcript', 'that child\'s transcript could not be read');
    }
  },

  answer: async (c, b, res) => {
    if (!requireHandedOver(c, res)) return;
    const child = childArg(c, b, res);
    if (!child) return;
    const requestId = str(b.requestId);
    if (!requestId || requestId.length > 200) { refuse(res, 400, 'invalid_args', 'name the question id'); return; }
    const pq = getChat(child)?.pendingQuestion ?? null;
    const asking = getChat(child)?.status === 'asking';
    // FAIL CLOSED (D7): only the plain question the registry names right now. A permission is
    // the owner's alone, whoever asks; anything else is stale.
    if (pq && pq.requestId === requestId && pq.isPermission) {
      refuse(res, 403, 'permission_refused', 'a permission request is answered only by the owner, from the queue strip');
      return;
    }
    if (!asking || !pq || pq.requestId !== requestId || pq.isPermission || pq.toolName !== 'AskUserQuestion') {
      refuse(res, 409, 'stale_request', 'that child is not asking this question any more');
      return;
    }
    const choices = Array.isArray(b.choices)
      ? (b.choices as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim() && x.length <= 500).slice(0, 8)
      : [];
    const text = typeof b.text === 'string' && b.text.trim() ? b.text.slice(0, MAX_OWNER_TEXT) : undefined;
    if (!choices.length && !text) { refuse(res, 400, 'invalid_args', 'give an option label or --text'); return; }
    const r = await sendSuperCommand(c.token, 'answer', { child, requestId, choices, ...(text ? { text } : {}) });
    if (!r.ok) { refuse(res, r.error === 'no_window' ? 409 : 200, r.error, 'the window did not answer the child'); return; }
    await writeSuper(c.who.contextRoot, (s) => {
      for (const q of s.queue) if (q.sessionId === child && q.requestId === requestId && q.kind === 'question') q.state = 'done';
    });
    ok(res, { child, requestId, answered: true });
  },

  send: async (c, b, res) => {
    if (!requireHandedOver(c, res)) return;
    const child = childArg(c, b, res);
    if (!child) return;
    if (c.state.children[child].endedAt !== undefined && !isLiveChat(child)) {
      refuse(res, 409, 'ended', 'that child was ended; `dreamcontext super resume <child>` reopens the same conversation');
      return;
    }
    const text = typeof b.text === 'string' ? b.text : '';
    if (!text.trim()) { refuse(res, 400, 'invalid_args', 'text is required'); return; }
    if (text.length > MAX_TEXT) { refuse(res, 400, 'invalid_args', 'text is too long'); return; }
    // Through the window, as an owner message into the child's own tab (so it reaches the
    // child's `writeOwnerTurn`, and its hand-over note rides with it).
    const r = await sendWindowCommand(c.token, 'send', { tab: child, text });
    if (!r.ok) { refuse(res, r.error === 'no_window' ? 409 : 200, r.error, 'the message did not reach the child'); return; }
    // The window says how: 'steered' (into the running turn), 'queued' (behind an open
    // question or permission card) or 'sent' (a new turn).
    const how = (r.result as { delivered?: unknown } | undefined)?.delivered;
    // Queued in the window's memory: also kept on disk, so a relaunch cannot lose it (outbox.ts).
    if (how === 'queued') await addToOutbox(c.who.contextRoot, child, text).catch(() => undefined);
    ok(res, { child, delivered: typeof how === 'string' ? how : true });
  },

  'queue-list': async (c, _b, res) => {
    // An item escalated by the server carries the CHILD's question as its owner text: fenced.
    const vault = vaultNameOf(c.who.contextRoot);
    const fence = (q: SuperState['queue'][number]) => (q.ownerText ? { ...q, ownerText: wrapUntrusted(vault, q.ownerText) } : q);
    const head = superQueueHead(c.state);
    ok(res, { queue: c.state.queue.map(fence), head: head ? fence(head) : null });
  },

  'queue-ask': async (c, b, res) => {
    if (!requireHandedOver(c, res)) return;
    const id = str(b.item);
    const item = id ? c.state.queue.find((q) => q.id === id) : undefined;
    if (!item) { refuse(res, 404, 'unknown_item', 'no such queue item (`dreamcontext super queue list`)'); return; }
    if (item.kind === 'permission') { refuse(res, 403, 'permission_item', 'a permission is shown to the owner from the child\'s own request; you cannot caption or close it'); return; }
    if (item.kind !== 'question') { refuse(res, 400, 'not_a_question', 'only a child\'s question can be escalated'); return; }
    if (item.state === 'done') { refuse(res, 409, 'stale_request', 'that question is already answered'); return; }
    const text = oneLine(typeof b.text === 'string' ? b.text : '').slice(0, MAX_OWNER_TEXT);
    if (!text) { refuse(res, 400, 'invalid_args', 'write the question for the owner'); return; }
    const state = await writeSuper(c.who.contextRoot, (s) => {
      const q = s.queue.find((x) => x.id === id);
      if (q && q.kind === 'question' && q.state !== 'done') { q.state = 'escalated'; q.ownerText = text; }
    });
    const head = superQueueHead(state);
    ok(res, { item: id, escalated: true, waiting: head?.id !== id });
  },

  'queue-done': async (c, b, res) => {
    const id = str(b.item);
    const item = id ? c.state.queue.find((q) => q.id === id) : undefined;
    if (!item) { refuse(res, 404, 'unknown_item', 'no such queue item (`dreamcontext super queue list`)'); return; }
    if (item.kind === 'permission') { refuse(res, 403, 'permission_item', 'a permission is closed only by the owner\'s answer'); return; }
    await writeSuper(c.who.contextRoot, (s) => { const q = s.queue.find((x) => x.id === id); if (q && q.kind !== 'permission') q.state = 'done'; });
    void pumpSuper(c.who.contextRoot);
    ok(res, { item: id, done: true });
  },

  merge: async (c, b, res) => {
    const root = c.who.contextRoot;
    const ids = Array.isArray(b.children) ? (b.children as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length) { refuse(res, 400, 'invalid_args', 'name the children to merge'); return; }
    const members = [];
    for (const id of ids) {
      const ch = hasChild(c.state, id) ? c.state.children[id] : undefined;
      if (!ch) { refuse(res, 404, 'unknown_child', `${id} is not one of your children`); return; }
      if (!ch.worktree || !ch.branch) { refuse(res, 409, 'no_branch', `${id} has no worktree branch`); return; }
      members.push({ sessionId: id, worktree: ch.worktree, branch: ch.branch });
    }
    try {
      const repo = await repoOfWorktree(dirname(root), members[0].worktree);
      if (!repo) { refuse(res, 409, 'worktree_not_listed', `${members[0].worktree} is not a worktree of a linked repo`); return; }
      for (const m of members.slice(1)) {
        const other = await repoOfWorktree(dirname(root), m.worktree);
        if (other?.path !== repo.path) { refuse(res, 409, 'mixed_repos', 'every child merged together must work in the same repo'); return; }
      }
      ok(res, await mergeChildren({ projectRoot: dirname(root), repo: repo.name, children: members, topic: b.into }));
    } catch (err) {
      if (err instanceof WorktreeRefused) { refuse(res, 409, err.code, err.message, err.details); return; }
      throw err;
    }
  },

  'worktree-list': async (c, _b, res) => {
    const root = c.who.contextRoot;
    const rows = [];
    for (const [sid, ch] of Object.entries(c.state.children)) {
      if (!ch.worktree || !ch.branch) continue;
      const repo = await repoOfWorktree(dirname(root), ch.worktree);
      const st = repo ? await worktreeStatus(repo.path, ch.worktree, ch.branch) : { listed: false, dirty: null, merged: null };
      rows.push({ child: sid, worktree: ch.worktree, branch: ch.branch, repo: repo?.name ?? null, ...st });
    }
    ok(res, { worktrees: rows });
  },

  clean: async (c, b, res) => {
    const root = c.who.contextRoot;
    const dry = b.dryRun === true;
    // Only an ENDED child's worktree that git reports merged and clean, and our own old test
    // temp folders. Live children, unmerged or dirty work, Chrome and system files: never.
    const worktrees: Array<{ child: string; worktree: string; branch: string; repoPath: string }> = [];
    for (const [sid, ch] of Object.entries(c.state.children)) {
      if (ch.endedAt === undefined || !ch.worktree || !ch.branch || isLiveChat(sid)) continue;
      const repo = await repoOfWorktree(dirname(root), ch.worktree).catch(() => null);
      if (!repo) continue;
      const st = await worktreeStatus(repo.path, ch.worktree, ch.branch).catch(() => null);
      if (st?.listed && st.dirty === false && st.merged === true) worktrees.push({ child: sid, worktree: ch.worktree, branch: ch.branch, repoPath: repo.path });
    }
    const tmp = await oldTestTmp(tmpdir());
    const sizes = await diskUsage([...worktrees.map((w) => w.worktree), ...tmp]);
    const items = [
      ...worktrees.map((w) => ({ kind: 'worktree', path: w.worktree, child: w.child, branch: w.branch, bytes: sizes.get(w.worktree) ?? 0 })),
      ...tmp.map((t) => ({ kind: 'test-tmp', path: t, bytes: sizes.get(t) ?? 0 })),
    ];
    const total = items.reduce((n, i) => n + i.bytes, 0);
    if (dry) { ok(res, { dryRun: true, items, bytes: total }); return; }
    const removed: string[] = [];
    const failed: Array<{ path: string; message: string }> = [];
    for (const w of worktrees) {
      try {
        await removeChildWorktree({ repoPath: w.repoPath, worktree: w.worktree, branch: w.branch });
        await writeSuper(root, (s) => { const x = s.children[w.child]; if (x) { delete x.worktree; delete x.branch; } });
        removed.push(w.worktree);
      } catch (err) { failed.push({ path: w.worktree, message: (err as Error).message }); }
    }
    for (const t of tmp) {
      try { await fsp.rm(t, { recursive: true, force: true }); removed.push(t); } catch (err) { failed.push({ path: t, message: (err as Error).message }); }
    }
    forgetLeftovers();
    const freed = items.filter((i) => removed.includes(i.path)).reduce((n, i) => n + i.bytes, 0);
    ok(res, { removed, failed, bytesFreed: freed, branchesKept: worktrees.filter((w) => removed.includes(w.worktree)).map((w) => w.branch) });
  },

  'worktree-remove': async (c, b, res) => {
    const child = childArg(c, b, res);
    if (!child) return;
    const root = c.who.contextRoot;
    const ch = c.state.children[child];
    if (!ch.worktree || !ch.branch) { refuse(res, 409, 'no_branch', 'that child has no worktree'); return; }
    try {
      const repo = await repoOfWorktree(dirname(root), ch.worktree);
      if (!repo) { refuse(res, 409, 'worktree_not_listed', `${ch.worktree} is not a worktree of a linked repo`); return; }
      await removeChildWorktree({ repoPath: repo.path, worktree: ch.worktree, branch: ch.branch });
      await writeSuper(root, (s) => { const x = s.children[child]; if (x) { delete x.worktree; delete x.branch; } });
      ok(res, { child, removed: ch.worktree, branchKept: ch.branch });
    } catch (err) {
      if (err instanceof WorktreeRefused) { refuse(res, 409, err.code, err.message, err.details); return; }
      throw err;
    }
  },

  end: async (c, b, res) => {
    if (!requireHandedOver(c, res)) return;
    const force = b.force === true;
    if (b.idle === true) {
      // `--idle`: the list first; `--idle --yes` ends every one of them.
      const now = Date.now();
      const rows = Object.entries(c.state.children)
        .filter(([, ch]) => ch.endedAt === undefined)
        .map(([sid, ch]) => ({ sid, ch, status: childStatus(sid, now) }))
        .filter((r) => r.status === 'idle' || r.status === 'gone');
      const list = (r: typeof rows[number]) => ({ child: r.sid, status: r.status, brief: wrapUntrusted(vaultNameOf(c.who.contextRoot), r.ch.brief) });
      const mine = rows.filter((r) => !r.ch.adopted);
      const owners = rows.filter((r) => r.ch.adopted);
      if (b.yes !== true) {
        ok(res, {
          idle: mine.map(list), ownersChats: owners.map(list),
          next: mine.length ? 'run `dreamcontext super end --idle --yes` to end these (the owner\'s own chats stay)' : 'nothing idle to end',
        });
        return;
      }
      const results = [];
      for (const r of mine) results.push(await endChild(c, r.sid, false));
      ok(res, { ended: results.filter((x) => x.ended).map((x) => x.child), refused: results.filter((x) => !x.ended) });
      return;
    }
    const raw = Array.isArray(b.children) ? b.children : typeof b.child === 'string' ? [b.child] : [];
    const ids = [...new Set(raw.filter((x): x is string => typeof x === 'string'))];
    if (!ids.length || ids.length > MAX_CONTAINERS * 2) { refuse(res, 400, 'invalid_args', 'name the children to end (or --idle)'); return; }
    for (const id of ids) {
      if (!SESSION_ID_RE.test(id) || !hasChild(c.state, id)) {
        refuse(res, 404, 'unknown_child', `${id.slice(0, 80)} is not one of your children (\`dreamcontext super state\` lists them)`);
        return;
      }
    }
    const results = [];
    for (const id of ids) results.push(await endChild(c, id, force));
    if (results.length === 1 && !results[0].ended) {
      const r = results[0];
      refuse(res, 409, r.reason ?? 'refused', r.message ?? 'the child was not ended', { child: r.child, ...(r.background ? { background: r.background } : {}) });
      return;
    }
    ok(res, { ended: results.filter((x) => x.ended).map((x) => x.child), refused: results.filter((x) => !x.ended) });
  },

  resume: async (c, b, res) => {
    if (!requireHandedOver(c, res)) return;
    const child = childArg(c, b, res);
    if (!child) return;
    const root = c.who.contextRoot;
    const ch = c.state.children[child];
    if (isLiveChat(child)) {
      if (ch.endedAt !== undefined) await writeSuper(root, (s) => { const x = s.children[child]; if (x) delete x.endedAt; });
      ok(res, { child, resumed: false, running: true });
      return;
    }
    const mode = str(b.mode) ?? ch.mode ?? 'basic';
    if (!(MODES as readonly string[]).includes(mode)) { refuse(res, 400, 'invalid_args', `mode must be one of ${MODES.join(' | ')}`); return; }
    const model = str(b.model) ?? ch.model;
    if (model && !sanitizeModel(model)) { refuse(res, 400, 'invalid_args', 'model is not a model id'); return; }
    const effort = str(b.effort) ?? ch.effort;
    if (effort && !(EFFORTS as readonly string[]).includes(effort)) { refuse(res, 400, 'invalid_args', `effort must be one of ${EFFORTS.join(' | ')}`); return; }
    // A resumed child is a live child again: the same cap as a delegate.
    const room = delegationAllowed(c.state);
    if (room.live >= room.max) {
      refuse(res, 409, 'held', `${room.live} children are running (at most ${room.max}); end one first`, { held: true, live: room.live, max: room.max });
      return;
    }
    if (!liveTranscriptPath(root, child)) { refuse(res, 404, 'no_transcript', 'that child has no transcript to resume'); return; }
    const r = await sendSuperCommand(c.token, 'resume', { child, mode, model: model ?? '', effort: effort ?? '', title: ch.brief });
    if (!r.ok) { refuse(res, r.error === 'no_window' ? 409 : 502, r.error, 'the window could not reopen the child'); return; }
    let container: string | null = null;
    await writeSuper(root, (s) => {
      const x = s.children[child];
      if (!x) return;
      delete x.endedAt;
      x.mode = mode === 'basic' ? undefined : mode;
      if (model) x.model = model;
      if (effort) x.effort = effort;
      if (x.mode === undefined) delete x.mode;
      container = ensureChatContainer(s, child, x.brief);
    });
    ok(res, { child, resumed: true, mode, ...(model ? { model } : {}), ...(effort ? { effort } : {}), container });
  },
};

/** A child's registry status right now; `gone` when nothing runs it. */
function childStatus(sid: string, now = Date.now()): string {
  const e = getChat(sid);
  return e ? activityOf(e, now) : 'gone';
}

/** What `super state` says a child is: the registry's activity while a process runs it, else
 *  `ended` (super end), `parked` (its tab is dormant) or `gone`. Never null. */
export function liveChildStatus(ch: Pick<SuperChild, 'endedAt'>, activity: string | null, parked: boolean): string {
  if (activity && activity !== 'gone') return activity;
  if (ch.endedAt !== undefined) return 'ended';
  return parked ? 'parked' : 'gone';
}

const isLimitBanner = (t: string): boolean =>
  readLimitSignal({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: t }] } }) !== null;

/**
 * The newest line worth showing, never a usage-limit banner (field 2026-10-21: after an account
 * switch the old "session limit" line read as a stuck child). The banner is reported as `limit`
 * only while it is the newest text and nothing runs: a chat that moved on is not limited.
 */
export function childLastLine(texts: readonly string[], status: string): { line: string; limit: string | null } {
  const newest = texts[texts.length - 1] ?? '';
  const line = [...texts].reverse().find((t) => t && !isLimitBanner(t)) ?? '';
  const limit = newest && isLimitBanner(newest) && status !== 'working' && status !== 'starting' ? newest : null;
  return { line, limit };
}

function isLiveChat(sid: string): boolean {
  return childStatus(sid) !== 'gone';
}

const END_REFUSALS: Partial<Record<ParkOutcome, string>> = {
  busy: 'it is still working: wait for its turn to end (an idle event comes), or pass --force only if the owner asked',
  asking: 'it waits on a question or a permission: settle that first, or pass --force only if the owner asked',
  focused: 'the owner is looking at or typing in that chat right now; leave it to him',
  exempt: 'that chat is never ended this way (the Assistant, the Super Agent or a phone holds it)',
  refused: 'the window refused to close it',
  no_answer: 'the window did not answer in time; check `dreamcontext super state` and try once more',
};

interface EndResult { child: string; ended: boolean; reason?: string; message?: string; background?: number; noProcess?: boolean }

/**
 * End one recorded child: park it with `end` (the window closes the tab, so no relaunch brings it
 * back; the transcript stays), then record it ended: its card goes, its open queue items close, a
 * done `ended` item records who, when and its last brief. A child with no process is only
 * recorded (a dormant tab of it is closed by the window when the record arrives).
 */
async function endChild(c: SuperCaller, sid: string, force: boolean): Promise<EndResult> {
  const ch = c.state.children[sid];
  if (!ch || sid === c.state.session) return { child: sid, ended: false, reason: 'unknown_child', message: 'not one of your children' };
  if (ch.endedAt !== undefined && !isLiveChat(sid)) return { child: sid, ended: true, reason: 'already' };
  if (ch.adopted && !force) {
    return { child: sid, ended: false, reason: 'adopted', message: 'that is the owner\'s own chat (adopted at hand-over); end it only when he asks, with --force' };
  }
  let noProcess = false;
  if (isLiveChat(sid)) {
    const outcome = await parkChat(sid, 'super-end', { end: true, force }).catch((): ParkOutcome => 'refused');
    if (outcome === 'background') {
      const n = findParkable(sid)?.backgroundTasks() ?? 1;
      return {
        child: sid, ended: false, reason: 'background', background: n,
        message: `${n} background task${n === 1 ? '' : 's'} (a shell, a dev server or a sub-agent) still run in it and would die; wait for them, or pass --force only if the owner asked`,
      };
    }
    if (outcome !== 'parked' && outcome !== 'drained' && outcome !== 'already') {
      return { child: sid, ended: false, reason: outcome, message: END_REFUSALS[outcome] ?? 'the child was not ended' };
    }
  } else {
    noProcess = true;
  }
  await recordEnded(c.who.contextRoot, sid);
  return { child: sid, ended: true, ...(noProcess ? { noProcess } : {}) };
}

/**
 * End the child a successor took over from (`super delegate --succeeds`). Idle: ended now, like
 * `super end`. Still busy or asking: told to stop at once (steered into its turn, or at the first
 * opening after its card), and `super state` warns until it is ended.
 */
async function retirePredecessor(c: SuperCaller, sid: string): Promise<{ child: string; ended: boolean; reason?: string; told?: string | boolean }> {
  const r = await endChild(c, sid, false);
  if (r.ended) return { child: sid, ended: true };
  // The owner's own chat, or one he is looking at, is never told to stop by the agent.
  if (!isLiveChat(sid) || r.reason === 'adopted' || r.reason === 'focused') return { child: sid, ended: false, reason: r.reason };
  const sent = await sendWindowCommand(c.token, 'send', { tab: sid, text: SUCCESSOR_STOP_TEXT }).catch(() => null);
  const how = sent?.ok ? (sent.result as { delivered?: unknown } | undefined)?.delivered : undefined;
  return { child: sid, ended: false, reason: r.reason, told: typeof how === 'string' ? how : !!sent?.ok };
}

/** Record a child ended (the agent's `super end` and the owner's card close share it): its card
 *  goes, its open queue items close, a done `ended` item records who, when and its last brief. */
async function recordEnded(contextRoot: string, sid: string): Promise<void> {
  const now = Date.now();
  await writeSuper(contextRoot, (s) => {
    const x = s.children[sid];
    if (!x) return;
    x.endedAt = now;
    const cards = s.containers.filter((k) => k.kind === 'chat' && k.ref === sid).map((k) => k.id);
    if (cards.length) {
      leaveGroups(s, cards);
      s.containers = s.containers.filter((k) => !cards.includes(k.id));
    }
    // Nothing of it is open any more (a forced end may have left a question or permission).
    for (const q of s.queue) if (q.sessionId === sid && q.state !== 'done') q.state = 'done';
    delete s.notes[sid];
    s.queue.push({ id: newQueueId(), sessionId: sid, kind: 'ended', state: 'done', createdAt: now, brief: x.brief });
  });
}

/** POST /api/super/v/:verb */
export async function handleSuperVerb(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  const caller = await authorizeSuperAgent(req, res);
  if (!caller) return;
  const verb = params.verb as SuperVerb;
  if (!(SUPER_VERBS as readonly string[]).includes(verb)) {
    sendError(res, 404, 'unknown_verb', `No super verb "${params.verb}". Verbs: ${SUPER_VERBS.join(', ')}.`);
    return;
  }
  const body = (await parseJsonBody(req)) ?? {};
  try {
    await SUPER_VERB_HANDLERS[verb](caller, body as Record<string, unknown>, res);
  } catch (err) {
    if (!res.headersSent) storeRefusal(res, err);
  }
}

// ─── The owner's door ────────────────────────────────────────────────────────

/** Desktop app, this machine, a loopback Host, and not a cross-site request. Sends the 403. */
export function requireSuperOwner(req: IncomingMessage, res: ServerResponse): boolean {
  if (!requireLocalDesktop(req, res)) return false;
  if (isCrossSiteRequest(req)) {
    sendError(res, 403, 'forbidden', 'The Super Agent hand-over only answers this machine\'s own window.');
    return false;
  }
  return true;
}

/** GET /api/super/state — the vault's record, for the window's first paint (pushed after). */
export async function handleSuperStateGet(req: IncomingMessage, res: ServerResponse, _params: Params, contextRoot: string): Promise<void> {
  if (!requireSuperOwner(req, res)) return;
  try {
    sendJson(res, 200, superStateView(contextRoot, await readSuperState(contextRoot, superSanitizeOpts())));
  } catch (err) { storeRefusal(res, err); }
}

export type SuperOwnerVerb = 'enable' | 'disable' | 'layout' | 'activity' | 'recap' | 'end';
export type SuperOwnerHandler = (req: IncomingMessage, res: ServerResponse, contextRoot: string, body: Record<string, unknown>) => Promise<void>;

/** The owner's verbs (D17 hand-over/take-back, D9 layout, D7 lease, D13 recap). */
export const SUPER_OWNER_HANDLERS: Record<SuperOwnerVerb, SuperOwnerHandler> = {
  enable: async (_req, res, contextRoot, body) => {
    const { session, state } = await enableSuper(contextRoot, body);
    sendJson(res, 200, { session, state: superStateView(contextRoot, state) });
  },
  disable: async (_req, res, contextRoot) => {
    const state = await disableSuper(contextRoot);
    // The phone talked to the Super Agent only while it was handed over: its mirrors go now,
    // whether or not the window keeps the parked child alive.
    if (state.session) findLiveChat(state.session)?.closeMirrors?.();
    sendJson(res, 200, { state: superStateView(contextRoot, state) });
  },
  layout: async (_req, res, contextRoot, body) => {
    // The owner's gestures as a PATCH, applied inside the locked write (plan-r8 F3): a drop
    // (`pos`), a card stacked or brought back (`place`), a close, and — only from a gesture
    // that changes it — the view. It never replaces the list, so an agent `open`, `close`,
    // `half` or a delegated child's card landing between the window's last push and this POST
    // survives it. Unknown ids are ignored; the owner never creates a card here.
    const cards = body.cards === undefined ? [] : body.cards;
    const closed = body.closed === undefined ? [] : body.closed;
    if (!Array.isArray(cards) || !Array.isArray(closed) || cards.length > MAX_CONTAINERS || closed.length > MAX_CONTAINERS) {
      sendError(res, 400, 'invalid_body', 'cards and closed must be lists of at most 12');
      return;
    }
    const view = body.view;
    // Groups (2026-10-20): `leave` takes cards out of their group, `group` puts cards in one (a
    // new id makes it, standing where its first card stands), `ungroup` dissolves. A `cards`
    // entry may name a group: a drop, Others or back, the same as a card.
    const leave = Array.isArray(body.leave) ? (body.leave as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, MAX_CONTAINERS) : [];
    const ungroup = Array.isArray(body.ungroup) ? (body.ungroup as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, MAX_CONTAINERS) : [];
    const g = body.group && typeof body.group === 'object' && !Array.isArray(body.group) ? body.group as Record<string, unknown> : null;
    const groupOp = g && typeof g.id === 'string' && Array.isArray(g.cards)
      ? { id: g.id, cards: (g.cards as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, MAX_CONTAINERS), name: typeof g.name === 'string' ? g.name : undefined }
      : null;
    const state = await writeSuper(contextRoot, (s) => {
      if (leave.length) leaveGroups(s, leave);
      for (const raw of cards as unknown[]) {
        const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
        const k = p && typeof p.id === 'string' ? (s.containers.find((x) => x.id === p.id) ?? s.groups.find((x) => x.id === p.id)) : undefined;
        if (!p || !k) continue;
        if (p.place === 'float' || p.place === 'others') k.place = p.place;
        if (p.pos === null) delete k.pos;
        else if (p.pos && typeof p.pos === 'object') k.pos = p.pos as { x: number; y: number };
        // The card the owner moved last is drawn on top: it goes to the end of the list.
        if (p.order === 'last' && 'kind' in k) s.containers = [...s.containers.filter((x) => x !== k), k];
      }
      if (groupOp) applyGroupOp(s, groupOp);
      if (ungroup.length) dissolveGroups(s, ungroup);
      const gone = new Set((closed as unknown[]).filter((x): x is string => typeof x === 'string'));
      if (gone.size) s.containers = s.containers.filter((x) => !gone.has(x.id));
      // The store sanitizes what this produced: positions clamped, a view naming no card → float.
      if (view !== undefined) s.view = view as SuperState['view'];
    });
    sendJson(res, 200, { state: superStateView(contextRoot, state) });
  },
  activity: async (_req, res, contextRoot) => {
    await noteOwnerActivity(contextRoot);
    sendJson(res, 200, { ok: true });
  },
  end: async (_req, res, contextRoot, body) => {
    // The owner closed a child's card with "end the session": his window already closed the tab
    // (his own click, so an adopted chat or a running one is his to end); this records it the
    // way `super end` does, so the card goes and no relaunch brings the tab back.
    const child = typeof body.child === 'string' ? body.child : '';
    const current = await readSuperState(contextRoot, superSanitizeOpts());
    if (!SESSION_ID_RE.test(child) || !hasChild(current, child) || child === current.session) {
      sendError(res, 404, 'unknown_child', 'not a child of this project\'s Super Agent');
      return;
    }
    await recordEnded(contextRoot, child);
    sendJson(res, 200, { state: superStateView(contextRoot, await readSuperState(contextRoot, superSanitizeOpts())) });
  },
  recap: async (_req, res, contextRoot) => {
    const current = await readSuperState(contextRoot, superSanitizeOpts());
    if (!current.enabled || !current.session || current.away.events < 1) { sendJson(res, 200, { queued: false }); return; }
    let queued = false;
    await writeSuper(contextRoot, (s) => {
      if (!s.enabled || !s.session || s.away.events < 1) return;
      if (!s.queue.some((q) => q.kind === 'recap' && q.state === 'pending')) {
        s.queue.push({ id: newQueueId(), sessionId: s.session, kind: 'recap', state: 'pending', createdAt: Date.now() });
      }
      s.away = { since: null, events: 0 };
      queued = true;
    });
    if (queued) void pumpSuper(contextRoot);
    sendJson(res, 200, { queued });
  },
};

function ownerRoute(verb: SuperOwnerVerb) {
  return async (req: IncomingMessage, res: ServerResponse, _params: Params, contextRoot: string): Promise<void> => {
    if (!requireSuperOwner(req, res)) return;
    const body = (await parseJsonBody(req)) ?? {};
    try {
      await SUPER_OWNER_HANDLERS[verb](req, res, contextRoot, body as Record<string, unknown>);
    } catch (err) {
      if (!res.headersSent) storeRefusal(res, err);
    }
  };
}

export const handleSuperEnable = ownerRoute('enable');
export const handleSuperDisable = ownerRoute('disable');
export const handleSuperLayout = ownerRoute('layout');
export const handleSuperActivity = ownerRoute('activity');
export const handleSuperRecap = ownerRoute('recap');
export const handleSuperEnd = ownerRoute('end');
