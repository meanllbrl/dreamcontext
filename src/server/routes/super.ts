import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isCrossSiteRequest, isLoopback, isSameOriginStrict, requireLocalDesktop } from './agent-spawn-shared.js';
import {
  WINDOW_TOKEN_HEADER, channelFor, identityOf, pushFrame, sendSuperCommand, sendWindowCommand, type WindowIdentity,
} from '../../lib/window-control.js';
import { SuperStoreRefused, isReservedId, okMember, readSuperState, superRootOfChild } from '../../lib/super/store.js';
import {
  CONTAINER_KINDS, CONTAINER_SHAPES, CONTAINER_SIZES, MAX_ASK_OPTION, MAX_ASK_OPTIONS, MAX_BRIEF, MAX_CONTAINERS, MAX_FLOAT, MAX_OWNER_TEXT,
  MAX_LIVE_CHILDREN, MAX_POOL, MAX_POOL_BYTES, MAX_POOL_PROMPT, MAX_PRESENT, MAX_READ_BYTES, SUPER_FRAME_CUE,
  MAX_TITLE, MIN_GROUP_CARDS, SESSION_ID_RE, SUPER_VERBS, TASK_SLUG_RE, applyGroupOp, askLine, askSpecFromLegacy, askSummary, cleanAskOptions, cleanAskSpec, cleanGroupName,
  AGENDA_REF, AGENDA_SIZE, MAX_PAD, PAD_ID_RE, PAD_SECTIONS, cleanPadText, nextPadId, atLeastSize, defaultShape, dissolveGroups, floatCount, isPageKind, leaveGroups, minSizeFor, viewWithout,
  type ContainerKind, type ContainerShape, type ContainerSize, type PadSection, type SuperAskSpec, type SuperChild, type SuperPadItem, type SuperPoolItem, type SuperState, type SuperStateView, type SuperTeamJob, type SuperVerb,
} from '../../lib/super/types.js';
import { askOwnerToApprove, closeSettledApprovals, newTeamJobId, recordTeamJob, setTeamLiveSource, settleTeamJob, teamJobLive, type LiveSayJob } from '../../lib/super/team.js';
import { sayToAgent } from './automations.js';
import { currentAutomationJob, currentReplyJob, whenReplySettles, whenRunSettles } from '../automation-job.js';
import { getAutomation } from '../../lib/automations/store.js';
import { checkApproval } from '../../lib/automations/registry.js';
import {
  agendaMissing, containerIdFor, ensureAgendaCard, ensureChatContainer, minimiseAgendaCard, showAgendaCard, newQueueId, noteOwnerActivity, noteOwnerBatch, noteResuming, pumpSuper, setRow, superOpenBatch,
  superQueueHead, superSanitizeOpts, superVaultName, superView, writeSuper, noteSuperEscalation,
} from '../../lib/super/inbox.js';
import { ownerQuestionReach } from '../../lib/super/owner-question.js';
import { freshInFlight, isSuperEventTurn, sweepOrphanFresh } from '../../lib/super/inbox.js';
import { isRotating } from '../../lib/super/fresh-session.js';
import { padJobOver, padStale } from '../../lib/super/pad.js';
import { childDefaultEffort } from '../../lib/model-facts.js';
import { JOB_EFFORTS as EFFORTS, JOB_MODES as MODES, firstLine, oneLine, parseJob, promptHash, type Job } from '../../lib/super/jobs.js';
import { adoptChat, adoptableChats, disableSuper, enableSuper } from '../../lib/super/handover.js';
import { findLiveChat } from './agent-chat-live.js';
import {
  CLAUDE_SESSIONS_MEANS, delegationAllowed, lightModeNow, machineNotes, machineRoom, readCapacityFactsForState, type CapacityFacts,
} from '../../lib/super/capacity.js';
import { knownMcpServers, unknownMcpNames } from '../../lib/super/lean-mcp.js';
import {
  WorktreeRefused, createChildWorktree, discardFreshWorktree, mergeChildren, removeChildWorktree, repoOfWorktree,
  worktreeStatus, type CreatedWorktree,
} from '../../lib/super/worktrees.js';
import { DEFAULT_READ_BYTES, readLastReply, readTail, renderTail } from '../../lib/super/transcript-tail.js';
import { expandChildRefs } from '../../lib/super/child-ref.js';
import { validateSuperWebUrl } from '../../lib/super/web-url.js';
import { ownedLoopbackPorts } from '../owned-ports.js';
import { existsSync } from 'node:fs';
import { insightPath } from '../../lib/lab/store.js';
import { noteDismissed } from '../../lib/super/proactive.js';
import { activityOf, dropOwnerWait, getChat, onChatChange } from '../../lib/assistant/chat-registry.js';
import { noteSuperSend } from '../../lib/super/owner-wait.js';
import { wrapUntrusted } from '../../lib/assistant/autonomy.js';
import { liveTranscriptPath } from '../../lib/transcript-locate.js';
import { sanitizeModel } from '../../lib/claude-args.js';
import { findParkable, parkChat, parkedSince, type ParkOutcome } from '../chat-park.js';
import { readLimitSignal } from '../../lib/claude-limit-signal.js';
import { SUCCESSOR_STOP_TEXT, ownershipWarnings, succeedChild } from '../../lib/super/succession.js';
import { addToOutbox } from '../../lib/super/outbox.js';
import { cachedLeftovers, defaultPlaces, diskUsage, forgetLeftovers, oldTestTmp } from '../../lib/super/disk-leftovers.js';
import { readMachineFacts } from './machine.js';
import { tmpdir } from 'node:os';
import { planImageGroup, type ImageChain, type ImageGroupPlan } from '../../lib/super/image-group.js';
import { ensureTidy, touchCards, type TidyIo } from '../../lib/super/tidy.js';

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
const SLUG_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const DELEGATE_TIMEOUT_MS = 30_000;
/** `super open <kind> <ref…>` takes at most this many refs at once. */
const MAX_OPEN_REFS = 12;
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
  // The agenda is one card: its ref is implied (`super open agenda`).
  if (kind === 'agenda') return !ref || ref === AGENDA_REF ? { ref: AGENDA_REF } : { error: `the agenda is one card: open it with no ref (or "${AGENDA_REF}")` };
  if (!ref) return { error: 'ref is required' };
  switch (kind) {
    case 'chat':
      return hasChild(c.state, ref) ? { ref } : { error: 'a chat container shows one of your children: give its session id' };
    case 'browser':
      return hasChild(c.state, ref) ? { ref } : { error: 'a browser container shows one of your children\'s live browser: give its session id' };
    case 'team':
      return c.state.team.some((j) => j.id === ref) ? { ref } : { error: 'a team container shows one of your AI Team jobs: give its job id (`super state` lists them)' };
    case 'web': {
      const w = validateSuperWebUrl(ref, ownedLoopbackPorts());
      return w.ok
        ? { ref: w.href }
        : { error: `a web container shows an https page, a dev server on localhost (never this app's own ports) or a project file (${w.reason})` };
    }
    case 'image': {
      if (ref.length > 1024 || ref.startsWith('/') || ref.includes('\\') || ref.split('/').some((s) => s === '..' || s === '' || s === '.')) {
        return { error: 'an image is a project-relative path with no ".." steps' };
      }
      return IMAGE_EXT_RE.test(ref) ? { ref } : { error: 'an image is a .png, .jpg, .gif, .webp or .svg file' };
    }
    case 'whiteboard':
      // The window's own rule for a whiteboard's slug (`whiteboardPath` in SuperContainer.tsx).
      return /^[a-z0-9][a-z0-9-]{0,80}$/.test(ref) ? { ref } : { error: 'a whiteboard container names its slug (lowercase letters, digits and dashes)' };
    case 'board':
      if (!SLUG_REF_RE.test(ref) || ref.split('/').some((s) => s === '..' || s === '.' || s === '')) return { error: 'a board container names a board file, project-relative (no ".." steps)' };
      return { ref };
    case 'task':
      // Any slug `tasks create` can write (task-slug.ts), not the generic 200-character ref.
      return TASK_SLUG_RE.test(ref) ? { ref } : { error: 'a task container names its slug (lowercase letters, digits and dashes)' };
    default:
      if (!SLUG_REF_RE.test(ref) || ref.split('/').some((s) => s === '..' || s === '.' || s === '')) return { error: `a ${kind} container names its slug` };
      return { ref };
  }
}

/**
 * A card's look from a verb: `shape` takes a size preset (small|medium|large|wide) or an old
 * shape (square|tall, recorded only); `size` is the same preset under its own name. Both given
 * and naming different sizes is refused rather than guessed.
 */
function shapeOrSize(b: Record<string, unknown>): { shape?: ContainerShape; size?: ContainerSize } | { error: string } {
  const all = [...CONTAINER_SIZES, ...CONTAINER_SHAPES].join(' | ');
  const raw = str(b.shape);
  const rawSize = str(b.size);
  let shape: ContainerShape | undefined;
  let size: ContainerSize | undefined;
  if (raw) {
    if ((CONTAINER_SHAPES as readonly string[]).includes(raw)) shape = raw as ContainerShape;
    else if ((CONTAINER_SIZES as readonly string[]).includes(raw)) size = raw as ContainerSize;
    else return { error: `shape must be one of ${all}` };
  }
  if (rawSize) {
    if (!(CONTAINER_SIZES as readonly string[]).includes(rawSize)) return { error: `size must be one of ${CONTAINER_SIZES.join(' | ')}` };
    if (size && size !== rawSize) return { error: '--shape and --size name different sizes; give one' };
    size = rawSize as ContainerSize;
  }
  return { ...(shape ? { shape } : {}), ...(size ? { size } : {}) };
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

/** Room for `n` new floating cards: the stage limit counts top-level floating items (a group is
 *  one, Others none), the record limit every card. Checked only when opening. */
function roomFor(s: Pick<SuperState, 'containers' | 'groups'>, n: number): boolean {
  return floatCount(s) + n <= MAX_FLOAT && s.containers.length + n <= MAX_CONTAINERS;
}

/** The 409 for a full stage, with what is left of each limit. */
function tooMany(res: ServerResponse, s: Pick<SuperState, 'containers' | 'groups'>): void {
  const freeFloat = Math.max(0, MAX_FLOAT - floatCount(s));
  const freeTotal = Math.max(0, MAX_CONTAINERS - s.containers.length);
  refuse(res, 409, 'too_many_containers',
    freeTotal === 0
      ? `the record holds ${MAX_CONTAINERS} cards; close one first`
      : `the stage shows at most ${MAX_FLOAT} floating cards or groups; \`super stack\` finished or idle ones into Others first (never close a card to make room)`,
    { freeFloat, freeTotal });
}

/** An insight the vault really has (a card naming none would draw an empty tile). */
function insightExists(contextRoot: string, slug: string): boolean {
  try { return existsSync(insightPath(contextRoot, slug)); } catch { return false; }
}

/** `delegate` calls in flight per vault, counted against the cap until they settle. */
const delegating = new Map<string, number>();

/** K10: a delegated child pins the dev server it starts, so its site card opens by itself (S1). */
export const DEV_SERVER_LINE = 'If you start a dev server, pin its url (a `dream-view` pin) so the owner sees the site.';

function worktreePreamble(w: CreatedWorktree): string {
  return `You work in your own git worktree: ${w.path} (branch ${w.branch}, repo ${w.repo}). `
    + 'cd there first, then work and commit only there. Never push and never merge into another branch.';
}

/** `--mcp`: every name must be one of the user's MCP servers for this project (D14). The 400
 *  names the known ones so the agent can fix its call; names only, never a config. */
function mcpRefused(root: string, job: Job, res: ServerResponse): boolean {
  if (!job.mcp?.length) return false;
  const known = knownMcpServers(dirname(root));
  const missing = unknownMcpNames(job.mcp, known);
  if (!missing.length) return false;
  refuse(res, 400, 'unknown_mcp', `no MCP server named ${missing.join(', ')}; this project has: ${[...known.keys()].join(', ') || 'none'}`, { known: [...known.keys()] });
  return true;
}

/** The stage's own tidying (tidy.ts) reads and writes the record the way every verb does. */
const TIDY_IO: TidyIo = { read: (root) => readSuperState(root, superSanitizeOpts()), write: (root, fn) => writeSuper(root, fn) };

/** The super's last `open image`, per vault (image-group.ts): the next one within the window
 *  joins its group. In memory: a restart only ends a chain. */
const imageChains = new Map<string, ImageChain>();

/** Pool rows a `delegate --from` is starting right now, per vault: a second claim is refused. */
const claims = new Map<string, Set<string>>();

/** A task link names a real task: `state/<slug>.md`, a plain file (a symlink refused). */
async function taskFileOk(contextRoot: string, slug: string): Promise<boolean> {
  if (!TASK_SLUG_RE.test(slug)) return false;
  try {
    const st = await fsp.lstat(join(contextRoot, 'state', `${slug}.md`));
    return st.isFile() && !st.isSymbolicLink();
  } catch { return false; }
}

const newPoolId = () => `p-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

/**
 * Keep a job in the pool (plan r4 D9): the same prompt is pooled once (the row is reused), a
 * full pool (MAX_POOL rows or MAX_POOL_BYTES) keeps nothing. Returns the row's id, or why not.
 */
async function keepInPool(root: string, job: Job, extra: { held?: boolean; note?: string } = {}): Promise<{ id: string; reused: boolean } | { error: 'pool_full' | 'too_large' }> {
  if (Buffer.byteLength(job.prompt, 'utf-8') > MAX_POOL_PROMPT) return { error: 'too_large' };
  const hash = promptHash(job.prompt);
  let out: { id: string; reused: boolean } | { error: 'pool_full' | 'too_large' } = { error: 'pool_full' };
  const state = await writeSuper(root, (s) => {
    const have = s.pool.find((p) => p.hash === hash);
    if (have) { if (extra.held) have.held = true; out = { id: have.id, reused: true }; return; }
    if (s.pool.length >= MAX_POOL) { out = { error: 'pool_full' }; return; }
    const row: SuperPoolItem = {
      id: newPoolId(), title: job.title, prompt: job.prompt, hash, createdAt: Date.now(),
      ...(extra.note ? { note: extra.note } : {}),
      ...(job.task ? { task: job.task } : {}),
      ...(job.mode !== 'basic' ? { mode: job.mode } : {}),
      ...(job.model ? { model: job.model } : {}), ...(job.effort ? { effort: job.effort } : {}),
      ...(job.worktree ? { worktree: job.worktree } : {}), ...(job.slug ? { slug: job.slug } : {}), ...(job.base ? { base: job.base } : {}),
      ...(job.mcp ? { mcp: job.mcp } : {}),
      ...(extra.held ? { held: true } : {}),
    };
    if (Buffer.byteLength(JSON.stringify([...s.pool, row]), 'utf-8') > MAX_POOL_BYTES) { out = { error: 'pool_full' }; return; }
    s.pool.push(row);
    out = { id: row.id, reused: false };
  });
  // What the store kept is the truth: a row its caps dropped was not kept.
  if ('id' in out && !state.pool.some((p) => p.id === (out as { id: string }).id)) return { error: 'pool_full' };
  return out;
}

/** The pool as the agent reads it: what it wrote is fenced like every other stored line. */
function poolRows(vault: string, pool: readonly SuperPoolItem[]): Array<Record<string, unknown>> {
  return pool.map((p) => {
    const { prompt, hash: _hash, title, note, ...rest } = p;
    return {
      ...rest,
      title: wrapUntrusted(vault, title),
      ...(note ? { note: wrapUntrusted(vault, note) } : {}),
      promptBytes: Buffer.byteLength(prompt, 'utf-8'),
    };
  });
}

/** Start `job` as a child (the cap, the worktree, the window), or keep it in the pool when the
 *  cap holds it. `fromRow` is the pool row it came from: removed in the same write that records
 *  the child, kept on any refusal, marked `maybeStarted` when the window did not confirm. */
async function delegateJob(c: SuperCaller, res: ServerResponse, root: string, jobIn: Job, fromRow: SuperPoolItem | undefined, succeeds?: string, noteText?: string): Promise<void> {
  // No effort named: a default by mode, never the owner's global one (often xhigh). It is
  // recorded on the pool row and the child, so `super state` and `resume` show the real value.
  const job: Job = jobIn.effort ? jobIn : { ...jobIn, effort: childDefaultEffort(jobIn.mode) };
  // D11: the cap is the ONLY hold on a NEW delegation (calls in flight count too). The
  // machine's facts never hold (owner, 2026-10-21): `super state` shows them as information.
  // No await between the cap check and the in-flight count, or parallel delegates all pass.
  const inFlight = delegating.get(root) ?? 0;
  const room = delegationAllowed(c.state);
  if (room.live + inFlight >= room.max) {
    const facts = { held: true, live: room.live + inFlight, max: room.max, reason: 'cap' };
    const running = `${room.live + inFlight} children are running (at most ${room.max})`;
    if (fromRow) {
      refuse(res, 409, 'held', `${running}; the job stays in the pool as ${fromRow.id}`, { ...facts, pooled: fromRow.id });
      return;
    }
    // A hand-over is not pooled: the pool keeps no successor, and the old child keeps the work.
    if (succeeds) {
      refuse(res, 409, 'held', `${running}; the hand-over was NOT kept: delegate it again when a slot frees, or ask the owner`, { ...facts, kept: false });
      return;
    }
    // Capacity keeps the job (D9), bounded: the same prompt once, a full pool keeps nothing.
    const kept = await keepInPool(root, job, { held: true });
    if ('error' in kept) {
      refuse(res, 409, kept.error === 'too_large' ? 'held' : 'pool_full', `${running}; the job was NOT kept (${kept.error === 'too_large' ? 'its prompt is over 16 KB' : 'the pool is full'}): delegate it again when a slot frees, or ask the owner`, { ...facts, kept: false });
      return;
    }
    refuse(res, 409, 'held', `${running}; the job is kept in the pool as ${kept.id}: start it with \`dreamcontext super delegate --from ${kept.id}\` when a slot frees`, { ...facts, pooled: kept.id, reused: kept.reused, kept: true });
    return;
  }
  delegating.set(root, inFlight + 1);
  // Started in the owner's own turn (not an event turn): he waits on its result (`awaited`).
  const awaited = ownersTurn(c);
  let wt: CreatedWorktree | null = null;
  try {
    if (job.worktree) {
      wt = await createChildWorktree({ projectRoot: dirname(root), repo: job.worktree, slug: job.slug, base: job.base });
    }
    // The window refuses the frame after `deadline` (epoch ms); the server waits that long
    // plus a grace, so a child the window opens is (almost always) answered in time. A frame
    // that may still have opened a child never loses its worktree (review W2 #1).
    const deadline = Date.now() + DELEGATE_TIMEOUT_MS;
    const r = await sendSuperCommand(c.token, 'delegate', {
      prompt: `${wt ? `${worktreePreamble(wt)}\n\n` : ''}${DEV_SERVER_LINE}\n\n${job.prompt}`,
      mode: job.mode, model: job.model ?? '', effort: job.effort ?? '', brief: job.brief, title: job.title, deadline,
      // The child runs LEAN (D14): only these of the user's MCP servers ([] = none).
      mcp: job.mcp ?? [],
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
        if (fromRow) {
          await writeSuper(root, (s) => {
            const p = s.pool.find((x) => x.id === fromRow.id);
            if (!p) return;
            p.maybeStarted = true;
            if (wt) { p.startedIn = wt.path; p.startedBranch = wt.branch; }
          });
        }
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
    let noted: SuperPadItem | 'full' | null = null;
    await writeSuper(root, (s) => {
      const now = Date.now();
      s.children[sid] = {
        sessionId: sid, brief: job.brief || job.title, adopted: false, startedAt: now, row: 'working', rowAt: now,
        ...(job.mode !== 'basic' ? { mode: job.mode } : {}), ...(job.model ? { model: job.model } : {}), ...(job.effort ? { effort: job.effort } : {}),
        ...(job.mcp ? { mcp: job.mcp } : {}),
        ...(wt ? { worktree: wt.path, branch: wt.branch } : {}),
        ...(job.task ? { task: job.task } : {}),
        ...(awaited ? { awaited: true as const } : {}),
      };
      delete s.notes[sid];
      container = (succeeds ? succeedChild(s, succeeds, sid, { brief: job.brief }) : null) ?? ensureChatContainer(s, sid, job.title);
      // Havuz → Çalışıyor in ONE write: the row leaves the pool as the child enters the list.
      if (fromRow) s.pool = s.pool.filter((p) => p.id !== fromRow.id);
      // One job, one owner: the agenda lines about the old child follow its successor (the old
      // one is ended, which would otherwise close a line whose work goes on).
      if (succeeds) s.pad = s.pad?.map((p) => (p.for === succeeds ? { ...p, for: sid } : p));
      // Its agenda line, in the same write: Now, and it follows this child from here on.
      if (noteText) noted = putPadNote(s, 'now', noteText, sid);
    });
    const predecessor = succeeds ? await retirePredecessor(c, succeeds) : null;
    ok(res, {
      sessionId: sid, container, ...(wt ? { worktree: wt.path, branch: wt.branch } : {}), ...(fromRow ? { from: fromRow.id } : {}),
      ...(predecessor ? { predecessor } : {}),
      ...(noted === 'full' ? { note: null, noteRefused: `pad_full: the agenda holds ${MAX_PAD} notes` } : noted ? { note: noted } : {}),
    });
  } catch (err) {
    if (err instanceof WorktreeRefused) { refuse(res, 409, err.code, err.message, err.details); return; }
    storeRefusal(res, err);
  } finally {
    const n = (delegating.get(root) ?? 1) - 1;
    if (n > 0) delegating.set(root, n); else delegating.delete(root);
  }
}

/** A queue item as the agent reads it: its child-derived text fenced (D10), the escalated
 *  owner text and the brief an `ended` item copies from the child's card. */
function fenceQueueItem(vault: string, q: SuperState['queue'][number]): SuperState['queue'][number] {
  return {
    ...q,
    ...(q.ownerText ? { ownerText: wrapUntrusted(vault, q.ownerText) } : {}),
    ...(q.brief ? { brief: wrapUntrusted(vault, q.brief) } : {}),
  };
}

/** What the window answers for a tab that has no running process (windowVerbs.ts). */
const WINDOW_NOT_RUNNING = /^that chat is not running/;
const WAKE_TRIES = 24;
let wakePollMs = 500;
/** Test seam: how long `send` waits between asks while a woken child comes up. */
export function _setSendWakePollForTests(ms: number | null): void { wakePollMs = ms ?? 500; }

/** The super is in the owner's own turn (not a server-opened event turn): what it does is his. */
function ownersTurn(c: SuperCaller): boolean {
  return !!c.state.session && !isSuperEventTurn(c.state.session);
}

/** His word reached the child (`send`, `resume` in his turn): its next result is his again. */
async function markOwnersJob(c: SuperCaller, child: string): Promise<void> {
  if (!ownersTurn(c)) return;
  // Set inside the write, never from the caller's snapshot: a `gone` settled since may have cleared it.
  await writeSuper(c.who.contextRoot, (s) => { const x = s.children[child]; if (x) x.awaited = true; })
    // His message already went in: a record that could not be written must not refuse (and resend) it.
    .catch((err) => console.warn(`[super] could not mark ${child} as the owner's job: ${(err as Error).message}`));
}

/** `super resume` for `child`, as the verb itself answers it; null when it came back (or ran), else the refusal. */
async function wakeChild(c: SuperCaller, child: string): Promise<{ status: number; error: string; message: string } | null> {
  let status = 0;
  let json: Record<string, unknown> = {};
  const sink = {
    writeHead: (s: number) => { status = s; return sink; },
    end: (b?: string) => { try { json = JSON.parse(b ?? '{}') as Record<string, unknown>; } catch { json = {}; } },
  } as unknown as ServerResponse;
  await SUPER_VERB_HANDLERS.resume(c, { child }, sink);
  if (json.ok === true) return null;
  const error = typeof json.error === 'string' ? json.error : 'not_woken';
  const why = typeof json.message === 'string' ? json.message : 'it could not be reopened';
  return { status: status >= 400 ? status : 409, error, message: `that child is parked and could not be woken (${error}): ${why}` };
}

/**
 * Write one agenda line into `s`; `forChild` links a Now line to its job (pad.ts). The same line
 * in the same section is the same note (a retried call writes nothing; a link given now is
 * added). A full pad gives up its oldest finished line first; with none, nothing is written.
 */
function putPadNote(s: SuperState, section: PadSection, text: string, forChild?: string): SuperPadItem | 'full' {
  const pad = [...(s.pad ?? [])];
  const same = pad.find((p) => p.section === section && p.text === text);
  if (same) {
    if (!forChild || same.for === forChild) return same;
    const linked: SuperPadItem = { ...same, for: forChild };
    s.pad = pad.map((p) => (p.id === same.id ? linked : p));
    return linked;
  }
  if (pad.length >= MAX_PAD) {
    const oldest = pad.findIndex((p) => p.section === 'done');
    if (oldest < 0) return 'full';
    pad.splice(oldest, 1);
  }
  const next = nextPadId(pad, s.padSeq);
  const note: SuperPadItem = { id: next.id, section, text, at: Date.now(), ...(forChild ? { for: forChild } : {}) };
  s.pad = [...pad, note];
  s.padSeq = next.seq;
  return note;
}

async function addPadNote(root: string, section: PadSection, text: string, forChild?: string): Promise<SuperPadItem | 'full'> {
  let out: SuperPadItem | 'full' = 'full';
  await writeSuper(root, (s) => { out = putPadNote(s, section, text, forChild); });
  return out;
}

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
        ...(last.length > 600 ? { lastLineCut: `cut at 600 of ${last.length} characters; the whole reply: dreamcontext super read ${sid}` } : {}),
        ...(limit ? { limit: wrapUntrusted(vault, limit) } : {}),
        asking: e?.pendingQuestion ? { requestId: e.pendingQuestion.requestId, kind: e.pendingQuestion.isPermission ? 'permission' : 'question' } : null,
      };
      // The live row rides on the child itself; `status[]` stays for older readers.
      children[sid] = { ...ch, brief: ch.brief ? wrapUntrusted(vault, ch.brief) : '', ...row };
      status.push({ sessionId: sid, ...row, ...(ch.worktree ? { worktree: ch.worktree, branch: ch.branch } : {}) });
    }
    let machine: unknown = null;
    let facts: CapacityFacts | null = null;
    try { facts = await readCapacityFactsForState(); } catch { facts = null; }
    // The largest leftovers on disk (last measurement; the next one runs in the background).
    if (facts) {
      const left = cachedLeftovers(() => defaultPlaces([dirname(root)]));
      // Folder names under a worktree are a child's to choose: fenced like every child string (D10).
      const leftovers = left.top.map((r) => ({ ...r, path: wrapUntrusted(vault, r.path) }));
      // `notes`: the lines the machine crossed, information only (owner, 2026-10-21): they never
      // hold a delegate and owe the owner no message.
      const light = await lightModeNow(facts, readMachineFacts);
      const notes = machineNotes(machineRoom(facts, { lightMode: light.on }), light);
      machine = { ...facts, claudeSessionsMeans: CLAUDE_SESSIONS_MEANS, notes, leftovers, leftoversMeasuredAt: left.measuredAt };
    }
    // Container titles can be child text (an adopted chat's tab title or last reply): fenced
    // like every other child-derived string (D10).
    const containers = c.state.containers.map((k) => (k.title ? { ...k, title: wrapUntrusted(vault, k.title) } : k));
    const fenceQ = (q: SuperState['queue'][number]) => fenceQueueItem(vault, q);
    const settled = await settleApprovals(root, c.state);
    const head = superQueueHead(settled);
    const team = settled.team.map((j) => teamJobRow(root, vault, j));
    const warnings = ownershipWarnings(settled, (sid) => {
      const st = (children[sid] as { status?: unknown } | undefined)?.status;
      return st !== 'ended' && st !== 'gone' && st !== 'parked';
    });
    // `teamLive` is the owner window's (member text, unfenced): the agent reads each team job's
    // status and last line from `team` below, fenced (D10).
    const { teamLive: _ownerOnly, ...view } = superStateView(root, settled);
    // A Now line no job keeps true, unchanged for PAD_STALE_MS (pad.ts): keep it or close it.
    const pad = (view.pad ?? []).map((p) => (padStale(p, now) ? { ...p, stale: true, staleMin: Math.floor((now - p.at) / 60_000) } : p));
    const stalePad = pad.filter((p) => 'stale' in p).map((p) => p.id);
    ok(res, {
      ...view, children, ...(view.pad ? { pad } : {}),
      ...(stalePad.length ? { padStale: { ids: stalePad, do: '`super note keep <id>` if it still holds, else `super note done|drop <id>`' } } : {}), containers, queue: settled.queue.map(fenceQ), status,
      head: head ? fenceQ(head) : null, machine, limits: { maxChildren: MAX_LIVE_CHILDREN }, pool: poolRows(vault, settled.pool), team, ...(warnings.length ? { warnings } : {}),
      // The MCP servers `delegate --mcp` can grant (D14): names only, each one the narrow
      // [a-z0-9_-] shape (a name of any other shape is never listed, so nothing here is prose).
      mcpServers: [...knownMcpServers(dirname(root)).keys()],
    });
  },

  delegate: async (c, b, res) => {
    if (!requireHandedOver(c, res)) return;
    const root = c.who.contextRoot;
    // `--from <pool id>`: the job the pool kept, exactly as it was kept (plan r4 D9).
    const fromId = str(b.from);
    const fromRow = fromId ? c.state.pool.find((p) => p.id === fromId) : undefined;
    if (fromId && !fromRow) { refuse(res, 404, 'unknown_pool_item', 'no such pool job (`dreamcontext super pool list`)'); return; }
    if (fromRow?.maybeStarted && b.force !== true) {
      refuse(res, 409, 'maybe_started', 'an earlier start of this job went unconfirmed and it may be running: check `dreamcontext super state` first, then pass --force to start it anyway');
      return;
    }
    const parsed = parseJob(fromRow ? { ...fromRow, brief: fromRow.title } : b);
    if ('error' in parsed) { refuse(res, 400, 'invalid_args', parsed.error); return; }
    const job = parsed.job;
    if (job.task && !(await taskFileOk(root, job.task))) { refuse(res, 404, 'unknown_task', `no task "${job.task}" in this project (state/<slug>.md)`); return; }
    if (mcpRefused(root, job, res)) return;
    // One job, one owner: the child this one takes the work over from (succession.ts).
    const succeeds = str(b.succeeds);
    if (succeeds !== undefined && (!SESSION_ID_RE.test(succeeds) || !hasChild(c.state, succeeds) || succeeds === c.state.session)) {
      refuse(res, 404, 'unknown_child', '--succeeds names none of your children (`dreamcontext super state` lists them)');
      return;
    }
    // The owner's own chat is never taken over: its card would move while it keeps running.
    if (succeeds !== undefined && c.state.children[succeeds].adopted) {
      refuse(res, 409, 'adopted', 'that is the owner\'s own chat; it hands its work on only when he says so');
      return;
    }
    // `--note "<line>"`: its Now line on the agenda, linked to the child it starts (pad.ts).
    const note = b.note === undefined ? undefined : cleanPadText(b.note);
    if (note === '') { refuse(res, 400, 'invalid_args', '--note is one line of text'); return; }
    // With no brief of its own, the successor's card keeps the old one's title.
    if (succeeds && !job.brief && c.state.children[succeeds].brief) job.title = c.state.children[succeeds].brief.slice(0, MAX_TITLE);
    const claimed = claims.get(root) ?? new Set<string>();
    if (fromId) {
      if (claimed.has(fromId)) { refuse(res, 409, 'claimed', 'that pool job is being started right now'); return; }
      claimed.add(fromId);
      claims.set(root, claimed);
    }
    try {
      await delegateJob(c, res, root, job, fromRow, succeeds, note);
    } finally {
      // Released whatever happened (r2-E5): a refusal leaves the row for the next try.
      if (fromId) { claimed.delete(fromId); if (!claimed.size) claims.delete(root); }
    }
  },

  open: async (c, b, res) => {
    // One ref (`ref`) or several of one kind (`refs`, at most MAX_OPEN_REFS), optionally put in
    // ONE named group (`group`): the owner asked to see a set of things (S8, AC11b). All or
    // nothing, in one locked write. Only NEW refs need room: a ref already on the record is
    // the same card (brought back from Others), and a group is one floating item.
    const kind = str(b.kind);
    if (!kind || !(CONTAINER_KINDS as readonly string[]).includes(kind)) { refuse(res, 400, 'invalid_args', `kind must be one of ${CONTAINER_KINDS.join(' | ')}`); return; }
    const look = shapeOrSize(b);
    if ('error' in look) { refuse(res, 400, 'invalid_args', look.error); return; }
    const { shape: shapeArg, size: sizeArg } = look;
    const rawRefs: unknown[] = Array.isArray(b.refs) ? b.refs : [b.ref];
    if (!rawRefs.length || rawRefs.length > MAX_OPEN_REFS) { refuse(res, 400, 'invalid_args', `name 1 to ${MAX_OPEN_REFS} refs of one kind`); return; }
    // `--titles "a|b|c"`: one label per ref, in order (an empty one leaves that card's label).
    const rawTitles: unknown[] = Array.isArray(b.titles) ? b.titles : [];
    if (rawTitles.length > rawRefs.length || rawTitles.some((t) => typeof t !== 'string')) { refuse(res, 400, 'invalid_args', 'titles: at most one label per ref, in the refs\' order'); return; }
    const refs: string[] = [];
    const titles = new Map<string, string>();
    for (const [i, raw] of rawRefs.entries()) {
      const r = refFor(c, kind as ContainerKind, raw);
      if ('error' in r) { refuse(res, 400, 'invalid_ref', r.error); return; }
      if (kind === 'insight' && !insightExists(c.who.contextRoot, r.ref)) { refuse(res, 404, 'unknown_insight', `no insight named ${r.ref} (\`dreamcontext insight list\`)`); return; }
      if (!refs.includes(r.ref)) refs.push(r.ref);
      const t = oneLine(String(rawTitles[i] ?? '')).slice(0, MAX_TITLE).trim();
      if (t && !titles.has(r.ref)) titles.set(r.ref, t);
    }
    const title = refs.length === 1 && str(b.title) ? oneLine(str(b.title) as string).slice(0, MAX_TITLE) : undefined;
    const titleOf = (ref: string): string | undefined => title ?? titles.get(ref);
    const groupName = str(b.group) ? cleanGroupName(b.group) : '';
    if (str(b.group) && !groupName) { refuse(res, 400, 'invalid_args', 'a group needs a name'); return; }
    // `--no-group`: the cards stand alone and the picture chain ends here.
    const noGroup = b.group === false;
    const ids = refs.map((ref) => containerIdFor(kind, ref));
    const root = c.who.contextRoot;
    const now = Date.now();
    // Pictures opened together are one group (image-group.ts): 2+ in one call, or one call after
    // another within IMAGE_CHAIN_MS. Decided against the record inside the locked write.
    const auto = (s: SuperState): ImageGroupPlan =>
      kind === 'image' && !groupName && !noGroup ? planImageGroup(s, ids, refs, imageChains.get(root), now) : null;
    const plan = (s: SuperState): { fits: boolean; groupId: string | null; name: string; cards: string[] } => {
      const fresh = ids.filter((id) => !s.containers.some((k) => k.id === id)).length;
      const a = auto(s);
      const target = groupName ? s.groups.find((g) => g.name === groupName) : a && 'join' in a ? s.groups.find((g) => g.id === a.join) : undefined;
      // A named group resting in Others comes back to the stage: one more floating item.
      let addFloat = groupName ? (target && target.place === 'float' ? 0 : 1) : fresh;
      if (a) {
        // A picture group counts net: the group (unless it already floats) minus each picked card
        // that floated on its own until now (the lone previous picture, a re-opened one).
        const grouped = new Set(s.groups.flatMap((g) => g.cards));
        const loose = ('join' in a ? a.cards : a.make.cards)
          .filter((id) => !grouped.has(id) && s.containers.some((k) => k.id === id && k.place === 'float')).length;
        addFloat = ('join' in a && target?.place === 'float' ? 0 : 1) - loose;
      }
      const fits = (addFloat <= 0 || floatCount(s) + addFloat <= MAX_FLOAT) && s.containers.length + fresh <= MAX_CONTAINERS;
      if (groupName) return { fits, groupId: target?.id ?? newGroupId(), name: groupName, cards: ids };
      if (a && 'join' in a) return { fits, groupId: a.join, name: '', cards: a.cards };
      if (a) return { fits, groupId: newGroupId(), name: a.make.name, cards: a.make.cards };
      return { fits, groupId: null, name: '', cards: ids };
    };
    if (!plan(c.state).fits) { tooMany(res, c.state); return; }
    let refused = false;
    let groupId: string | null = null;
    let autoGrouped = false;
    // Cards whose size the owner chose: the agent's size is not written (decided inside the
    // locked write, so an owner resize landing meanwhile still wins).
    let kept: string[] = [];
    // Touched before the write too, so a tidy pass racing it never moves what is being opened.
    touchCards(root, ids.filter((id) => c.state.containers.some((k) => k.id === id)));
    const state = await writeSuper(c.who.contextRoot, (s) => {
      const p = plan(s);
      if (!p.fits) { refused = true; return; }
      groupId = p.groupId;
      autoGrouped = !!p.groupId && !groupName;
      kept = [];
      refs.forEach((ref, i) => {
        const have = s.containers.find((k) => k.id === ids[i]);
        if (have) {
          // Re-opening brings it back from Others and keeps the owner's drop position.
          if (shapeArg) have.shape = shapeArg;
          if (have.sizeBy === 'owner') { if (sizeArg) kept.push(have.id); }
          else {
            // A page is never sized under large by an agent (owner 2026-10-22).
            const next = atLeastSize(sizeArg ?? have.size ?? 'small', minSizeFor(have.kind));
            if (next === 'small') delete have.size; else have.size = next;
          }
          have.place = 'float';
          // A minimised agenda the agent opens is shown, not left in its pill (end review r1).
          delete have.min;
          if (titleOf(ref)) have.title = titleOf(ref);
          return;
        }
        // The agenda opens at the size that holds its four sections, unless a size is named.
        const size = atLeastSize(sizeArg ?? (kind === 'agenda' ? AGENDA_SIZE : 'small'), minSizeFor(kind as ContainerKind));
        s.containers.push({
          id: ids[i], kind: kind as ContainerKind, ref,
          shape: shapeArg ?? defaultShape(kind as ContainerKind),
          ...(size !== 'small' ? { size } : {}),
          place: 'float', ...(titleOf(ref) ? { title: titleOf(ref) } : {}),
        });
      });
      // A page the agent opens is shown side by side at once (owner 2026-10-22: "if it adds a
      // web page as a card it should show it side by side, directly"): the first one named,
      // never inside a group, never over a presentation, and over a half page only when that
      // shows another page (a chat or a picture he looks at stays).
      const shownNow = s.view.mode === 'half' ? s.containers.find((k) => k.id === s.view.card) : undefined;
      if (!groupId && isPageKind(kind as ContainerKind)
        && (s.view.mode === 'float' || (s.view.mode === 'half' && (!shownNow || isPageKind(shownNow.kind))))) {
        s.view = { mode: 'half', card: ids[0] };
      }
      // The cards design's own group mutation: a card leaves any other group (a group left
      // with one card dissolves when the record is settled).
      if (groupId) {
        applyGroupOp(s, { id: groupId, cards: p.cards, name: p.name });
        // The group is what the stage draws: it floats, wherever it rested.
        const g = s.groups.find((x) => x.id === groupId);
        if (g) g.place = 'float';
      }
      // The picture chain: the next image open within the window joins where this one went.
      if (kind === 'image') {
        if (noGroup) imageChains.delete(root);
        else imageChains.set(root, { at: now, card: ids[0], group: s.groups.find((g) => g.cards.includes(ids[0]))?.id ?? null });
      }
    });
    if (refused) { tooMany(res, state); return; }
    const made = ids.map((id) => state.containers.find((k) => k.id === id)).filter((k): k is NonNullable<typeof k> => !!k);
    if (made.length !== ids.length) { tooMany(res, state); return; }
    // Opened by the super: touched now (tidy.ts), the group it went into too.
    touchCards(root, groupId ? [...ids, groupId] : ids);
    const group = groupId ? state.groups.find((g) => g.id === groupId) : undefined;
    ok(res, { container: made[0], containers: made, ...(group ? { group } : {}), ...(group && autoGrouped ? { autoGroup: true } : {}), ...(kept.length ? { kept } : {}), view: state.view });
  },

  shape: async (c, b, res) => {
    const id = containerArg(c, b, res);
    if (!id) return;
    const look = shapeOrSize(b);
    if ('error' in look) { refuse(res, 400, 'invalid_args', look.error); return; }
    if (!look.shape && !look.size) { refuse(res, 400, 'invalid_args', `shape must be one of ${[...CONTAINER_SIZES, ...CONTAINER_SHAPES].join(' | ')}`); return; }
    // The owner's size wins: decided inside the locked write, never against the snapshot.
    let ownerSized = false;
    let drawn: ContainerSize | undefined;
    await writeSuper(c.who.contextRoot, (s) => {
      const k = s.containers.find((x) => x.id === id);
      if (!k) return;
      if (look.size && k.sizeBy === 'owner') { ownerSized = true; return; }
      if (look.shape) k.shape = look.shape;
      if (look.size) {
        const next = atLeastSize(look.size, minSizeFor(k.kind));
        if (next === 'small') delete k.size; else k.size = next;
        drawn = next;
      }
    });
    if (ownerSized) { refuse(res, 409, 'owner_sized', 'the owner chose this card\'s size; leave it as it is'); return; }
    // The size written: a page is never under large (it says so rather than pretending).
    ok(res, { container: id, ...(look.shape ? { shape: look.shape } : {}), ...(drawn ? { size: drawn } : {}) });
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
      await writeSuper(c.who.contextRoot, (s) => {
        const g = s.groups.find((x) => x.id === id);
        if (!g) return;
        g.place = 'others';
        s.view = viewWithout(s.view, new Set(g.cards));
      });
      ok(res, { group: id, place: 'others' });
      return;
    }
    await writeSuper(c.who.contextRoot, (s) => {
      // A card stacked on its own leaves its group.
      leaveGroups(s, [id]);
      const k = s.containers.find((x) => x.id === id);
      // In Others, not also in the agenda's pill: one place at a time.
      if (k) { k.place = 'others'; delete k.min; }
      // A stacked card leaves the half page or the presentation it was in.
      s.view = viewWithout(s.view, new Set([id]));
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
      delete k.min;
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
    // The agenda is never closed: it collapses to its pill in the bottom-left corner (owner
    // 2026-10-22 23:44); the owner's pill or the centre's Agenda button brings it back.
    if (c.state.containers.some((x) => x.id === id && x.kind === 'agenda')) {
      await writeSuper(c.who.contextRoot, (s) => { if (minimiseAgendaCard(s)) s.view = viewWithout(s.view, new Set([id])); });
      ok(res, { closed: id, minimised: true });
      return;
    }
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
    const state = await writeSuper(c.who.contextRoot, (s) => { applyGroupOp(s, { id, cards, name }); s.view = viewWithout(s.view, new Set(cards)); });
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
    // `--task <slug>` links the row to a task (it never replaces the task).
    const task = str(b.task);
    if (task && !(await taskFileOk(c.who.contextRoot, task))) { refuse(res, 404, 'unknown_task', `no task "${task}" in this project (state/<slug>.md)`); return; }
    await writeSuper(c.who.contextRoot, (s) => {
      const ch = s.children[child];
      if (!ch) return;
      ch.brief = line;
      if (task) ch.task = task;
    });
    ok(res, { child, brief: line, ...(task ? { task } : {}) });
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
          ok(res, {
            child, reply: true, status: childStatus(child), at: reply.at, size: reply.size,
            // The child stopped on a usage limit or an API error after this reply.
            ...(reply.stoppedBy ? { stoppedAfter: 'usage limit or API error' } : {}),
            text: wrapUntrusted(vaultNameOf(root), reply.text),
          });
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
    // A parked child has no process: one command wakes it (`resume`), then the message goes in.
    // The Super Agent never resumes by hand (field 2026-10-21: send, resume, sleep, send again).
    let woke = false;
    if (!isLiveChat(child)) {
      const w = await wakeChild(c, child);
      if (w) { refuse(res, w.status, w.error, w.message); return; }
      woke = true;
    }
    // Through the window, as an owner message into the child's own tab (so it reaches the
    // child's `writeOwnerTurn`, and its hand-over note rides with it). Noted as the Super's own:
    // it answers no wait the child has on the owner (owner-wait.ts).
    noteSuperSend(child, text);
    let r = await sendWindowCommand(c.token, 'send', { tab: child, text });
    // The window still draws the tab as parked, or the resumed process is not up yet: it answers
    // "not running" until it is. Wake it (once) and ask again for a few seconds.
    for (let i = 0; !r.ok && WINDOW_NOT_RUNNING.test(r.error) && i < WAKE_TRIES; i++) {
      if (!woke) {
        const w = await wakeChild(c, child);
        if (w) { refuse(res, w.status, w.error, w.message); return; }
        woke = true;
      } else {
        await new Promise((done) => setTimeout(done, wakePollMs));
      }
      r = await sendWindowCommand(c.token, 'send', { tab: child, text });
    }
    if (!r.ok) { refuse(res, r.error === 'no_window' ? 409 : 200, r.error, 'the message did not reach the child'); return; }
    // The window says how: 'steered' (into the running turn), 'queued' (behind an open
    // question or permission card) or 'sent' (a new turn).
    const how = (r.result as { delivered?: unknown } | undefined)?.delivered;
    // Queued in the window's memory: also kept on disk, so a relaunch cannot lose it (outbox.ts).
    if (how === 'queued') await addToOutbox(c.who.contextRoot, child, text).catch((err) => console.warn(`[super outbox] could not keep a queued send: ${(err as Error).message}`));
    await markOwnersJob(c, child);
    ok(res, { child, delivered: typeof how === 'string' ? how : true, ...(woke ? { woke: true } : {}) });
  },

  'queue-list': async (c, _b, res) => {
    // An item escalated by the server carries the CHILD's question as its owner text: fenced.
    const vault = vaultNameOf(c.who.contextRoot);
    const fence = (q: SuperState['queue'][number]) => fenceQueueItem(vault, q);
    const state = await settleApprovals(c.who.contextRoot, c.state);
    const head = superQueueHead(state);
    ok(res, { queue: state.queue.map(fence), head: head ? fence(head) : null });
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
    // Asked inside an event turn: that turn renders in full for the owner (D8).
    const batch = c.state.session ? superOpenBatch(c.state.session) : null;
    const state = await writeSuper(c.who.contextRoot, (s) => {
      const q = s.queue.find((x) => x.id === id);
      if (q && q.kind === 'question' && q.state !== 'done') {
        q.state = 'escalated';
        q.ownerText = text;
        if (batch) { q.batch = batch; noteOwnerBatch(s, batch); }
      }
    });
    // What reached the owner, told as it is (owner-question.ts). Only a question he has seen
    // makes the turn's end no second ping; one nobody saw keeps the reply's own notch row.
    const reach = ownerQuestionReach(state, id as string);
    if (reach.reached) noteSuperEscalation(c.who.sessionId);
    const head = superQueueHead(state);
    ok(res, { item: id, escalated: true, waiting: head?.id !== id, ...reach });
  },

  'queue-done': async (c, b, res) => {
    const id = str(b.item);
    const item = id ? c.state.queue.find((q) => q.id === id) : undefined;
    if (!item) { refuse(res, 404, 'unknown_item', 'no such queue item (`dreamcontext super queue list`)'); return; }
    if (item.kind === 'permission') { refuse(res, 403, 'permission_item', 'a permission is closed only by the owner\'s answer'); return; }
    // An owner wait the Super closes (he did it another way) is answered: it never comes back.
    if (item.kind === 'owner' && item.wait) dropOwnerWait(item.sessionId, item.wait.kind, item.wait.id);
    await writeSuper(c.who.contextRoot, (s) => { const q = s.queue.find((x) => x.id === id); if (q && q.kind !== 'permission') q.state = 'done'; });
    void pumpSuper(c.who.contextRoot);
    ok(res, { item: id, done: true });
  },

  'pool-add': async (c, b, res) => {
    if (!requireHandedOver(c, res)) return;
    const root = c.who.contextRoot;
    const parsed = parseJob(b);
    if ('error' in parsed) { refuse(res, 400, 'invalid_args', parsed.error); return; }
    const job = parsed.job;
    if (Buffer.byteLength(job.prompt, 'utf-8') > MAX_POOL_PROMPT) { refuse(res, 400, 'too_large', `a pooled prompt is at most ${MAX_POOL_PROMPT} bytes`); return; }
    if (job.task && !(await taskFileOk(root, job.task))) { refuse(res, 404, 'unknown_task', `no task "${job.task}" in this project (state/<slug>.md)`); return; }
    if (mcpRefused(root, job, res)) return;
    const note = oneLine(str(b.note) ?? '').slice(0, MAX_BRIEF);
    const kept = await keepInPool(root, job, { note });
    if ('error' in kept) { refuse(res, 409, 'pool_full', `the pool is full (at most ${MAX_POOL} jobs, ${MAX_POOL_BYTES / 1024} KB); the job was NOT kept`); return; }
    ok(res, { pooled: kept.id, reused: kept.reused });
  },

  'pool-remove': async (c, b, res) => {
    const id = str(b.id);
    if (!id || !c.state.pool.some((p) => p.id === id)) { refuse(res, 404, 'unknown_pool_item', 'no such pool job (`dreamcontext super pool list`)'); return; }
    if (claims.get(c.who.contextRoot)?.has(id)) { refuse(res, 409, 'claimed', 'that pool job is being started right now'); return; }
    await writeSuper(c.who.contextRoot, (s) => { s.pool = s.pool.filter((p) => p.id !== id); });
    ok(res, { removed: id });
  },

  'pool-list': async (c, _b, res) => {
    ok(res, { pool: poolRows(vaultNameOf(c.who.contextRoot), c.state.pool) });
  },

  // ── The owner's agenda: the super's own notepad (owner 2026-10-22 19:15) ──
  'note-add': async (c, b, res) => {
    const section = str(b.section);
    if (!section || !(PAD_SECTIONS as readonly string[]).includes(section)) { refuse(res, 400, 'invalid_args', `section must be one of ${PAD_SECTIONS.join(' | ')}`); return; }
    const text = cleanPadText(b.text);
    if (!text) { refuse(res, 400, 'invalid_args', 'a note is one line of text'); return; }
    // `--for <child>`: the line is about that job and follows it (pad.ts). Now lines only.
    const forChild = str(b.for);
    if (forChild !== undefined) {
      if (section !== 'now') { refuse(res, 400, 'invalid_args', '--for links a Now line to its job; only `note add now` takes it'); return; }
      if (!SESSION_ID_RE.test(forChild) || !hasChild(c.state, forChild) || forChild === c.state.session) {
        refuse(res, 404, 'unknown_child', '--for names none of your children (`dreamcontext super state` lists them)');
        return;
      }
      // The owner's own chat settles after every turn of his: a line on it would come and go.
      if (c.state.children[forChild].adopted) { refuse(res, 409, 'adopted', 'that is the owner\'s own chat; note it without --for'); return; }
      // A job already over would close the line in the same write.
      const over = padJobOver(c.state, forChild);
      if (over) { refuse(res, 409, 'job_over', `that job is ${over}; a line about work that goes on: \`super note add now "<line>"\` without --for`); return; }
    }
    const added = await addPadNote(c.who.contextRoot, section as PadSection, text, forChild);
    if (added === 'full') { refuse(res, 409, 'pad_full', `the agenda holds ${MAX_PAD} notes: \`super note done|drop <id>\` or \`super note clear\` first`); return; }
    ok(res, { note: added });
  },

  'note-keep': async (c, b, res) => {
    // A Now line that still holds: stamped now, so it is not stale for another PAD_STALE_MS.
    const id = str(b.id);
    if (!id || !(c.state.pad ?? []).some((p) => p.id === id)) { refuse(res, 404, 'unknown_note', 'no such note (`dreamcontext super state` lists the pad)'); return; }
    let note: SuperPadItem | null = null;
    await writeSuper(c.who.contextRoot, (s) => {
      s.pad = (s.pad ?? []).map((p) => {
        if (p.id !== id) return p;
        const { toldAt: _t, ...rest } = p;
        note = { ...rest, at: Date.now() };
        return note;
      });
    });
    ok(res, { note });
  },

  'note-done': async (c, b, res) => {
    const id = str(b.id);
    if (!id || !(c.state.pad ?? []).some((p) => p.id === id)) { refuse(res, 404, 'unknown_note', 'no such note (`dreamcontext super state` lists the pad)'); return; }
    let note: SuperPadItem | null = null;
    await writeSuper(c.who.contextRoot, (s) => {
      const have = (s.pad ?? []).find((p) => p.id === id);
      if (!have) return;
      // Done goes to the end of the pad (the newest finished line), stamped now. The super moved
      // it itself: no longer the server's or the owner's move.
      const { by: _b, why: _w, toldAt: _t, ...mine } = have;
      note = have.section === 'done' ? { ...mine } : { ...mine, section: 'done', at: Date.now() };
      s.pad = [...(s.pad ?? []).filter((p) => p.id !== id), note];
    });
    if (!note) { refuse(res, 404, 'unknown_note', 'no such note (`dreamcontext super state` lists the pad)'); return; }
    ok(res, { note });
  },

  'note-drop': async (c, b, res) => {
    const id = str(b.id);
    if (!id || !(c.state.pad ?? []).some((p) => p.id === id)) { refuse(res, 404, 'unknown_note', 'no such note (`dreamcontext super state` lists the pad)'); return; }
    await writeSuper(c.who.contextRoot, (s) => { s.pad = (s.pad ?? []).filter((p) => p.id !== id); });
    ok(res, { dropped: id });
  },

  'note-clear': async (c, b, res) => {
    const section = str(b.section);
    if (section && !(PAD_SECTIONS as readonly string[]).includes(section)) { refuse(res, 400, 'invalid_args', `section must be one of ${PAD_SECTIONS.join(' | ')}`); return; }
    let cleared = 0;
    await writeSuper(c.who.contextRoot, (s) => {
      const pad = s.pad ?? [];
      const keep = section ? pad.filter((p) => p.section !== section) : [];
      cleared = pad.length - keep.length;
      s.pad = keep;
    });
    ok(res, { cleared, ...(section ? { section } : {}) });
  },

  ask: async (c, b, res) => {
    // The super agent's OWN question to the owner (plan r4 D7): never about a permission, one
    // open at a time, its options drawn and sent exactly as validated here.
    if (!requireHandedOver(c, res)) return;
    const session = c.state.session as string;
    if (c.state.queue.some((q) => q.kind === 'ask' && q.state !== 'done')) {
      refuse(res, 409, 'ask_open', 'you already have a question open with the owner; wait for his answer');
      return;
    }
    // AskUserQuestion's own shape (`super ask --json`, the flags), or the old text + options.
    let spec: SuperAskSpec;
    if (b.ask !== undefined) {
      const r = cleanAskSpec(b.ask);
      if (!r.ok) { refuse(res, 400, 'invalid_ask', r.error); return; }
      spec = r.spec;
    } else {
      const raw = typeof b.text === 'string' ? askLine(b.text) : '';
      if (!raw) { refuse(res, 400, 'invalid_args', 'write the question for the owner'); return; }
      if (raw.length > MAX_OWNER_TEXT) { refuse(res, 400, 'invalid_args', `the question is at most ${MAX_OWNER_TEXT} characters`); return; }
      const legacy = cleanAskOptions(b.options);
      if (!legacy) {
        refuse(res, 400, 'invalid_options', `at most ${MAX_ASK_OPTIONS} options, each one line of 1-${MAX_ASK_OPTION} characters, no duplicates (a longer label is refused, never cut)`);
        return;
      }
      spec = askSpecFromLegacy(raw, legacy);
    }
    const { ownerText: raw, options } = askSummary(spec);
    const batch = superOpenBatch(session);
    const id = newQueueId();
    const state = await writeSuper(c.who.contextRoot, (s) => {
      if (s.queue.some((q) => q.kind === 'ask' && q.state !== 'done')) return;
      s.queue.push({
        id, sessionId: session, kind: 'ask', state: 'escalated', ownerText: raw, createdAt: Date.now(),
        ...(options.length ? { options } : {}), ...(batch ? { batch } : {}), ask: spec,
      });
      noteOwnerBatch(s, batch ?? undefined);
    });
    if (!state.queue.some((q) => q.id === id)) { refuse(res, 409, 'ask_open', 'you already have a question open with the owner; wait for his answer'); return; }
    // Its turn's end is no second ping once the question reached him (owner-question.ts).
    const reach = ownerQuestionReach(state, id);
    if (reach.reached) noteSuperEscalation(session);
    const head = superQueueHead(state);
    ok(res, { item: id, asked: true, waiting: head?.id !== id, ...reach });
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
    // A tree any child not ended still holds (a successor) is in use, whoever started it.
    const inUse = new Set(Object.values(c.state.children).filter((x) => x.endedAt === undefined && x.worktree).map((x) => x.worktree as string));
    for (const [sid, ch] of Object.entries(c.state.children)) {
      if (ch.endedAt === undefined || !ch.worktree || !ch.branch || isLiveChat(sid) || inUse.has(ch.worktree)) continue;
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
    // The owner's own chat, like `end`, `update` and `adopt`: reopened (or made a child again
    // while it runs) only on his word.
    if (ownersChat(child, ch) && b.force !== true) {
      refuse(res, 409, 'adopted', 'that is the owner\'s own chat; reopen it only when he asks, with --force');
      return;
    }
    if (isLiveChat(child)) {
      // Ended yet running: the owner reopened it, and on his word it is a child again (his).
      let container: string | null = null;
      if (ch.endedAt !== undefined) {
        await writeSuper(root, (s) => {
          const x = s.children[child];
          if (!x) return;
          delete x.endedAt;
          x.adopted = true;
          container = ensureChatContainer(s, child, x.brief);
        });
      }
      await markOwnersJob(c, child);
      ok(res, { child, resumed: false, running: true, ...(container ? { container } : {}) });
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
    // Its new process is this resume's doing, never the owner reopening it (inbox noteChatStarted).
    noteResuming(child, true);
    try {
      const r = await sendSuperCommand(c.token, 'resume', { child, mode, model: model ?? '', effort: effort ?? '', title: ch.brief });
      if (!r.ok) { refuse(res, r.error === 'no_window' ? 409 : 502, r.error, 'the window could not reopen the child'); return; }
      // What the window ACTUALLY started it with: a parked tab comes back as it was parked, so
      // the record holds that, never a request the window did not apply. An older window that
      // reports nothing: the request.
      const used = usedSettings(r.result, { mode, model, effort });
      let container: string | null = null;
      await writeSuper(root, (s) => {
        const x = s.children[child];
        if (!x) return;
        delete x.endedAt;
        if (used.mode === 'basic') delete x.mode; else x.mode = used.mode;
        if (used.model) x.model = used.model; else if (used.reported) delete x.model;
        if (used.effort) x.effort = used.effort; else if (used.reported) delete x.effort;
        container = ensureChatContainer(s, child, x.brief);
      });
      await markOwnersJob(c, child);
      const asked = { mode: str(b.mode), model: str(b.model), effort: str(b.effort) };
      const ignored = (['mode', 'model', 'effort'] as const).filter((k) => asked[k] && asked[k] !== used[k]);
      ok(res, {
        child, resumed: true, mode: used.mode, ...(used.model ? { model: used.model } : {}), ...(used.effort ? { effort: used.effort } : {}), container,
        ...(ignored.length ? { note: `it came back as it was parked (${ignored.join(', ')} unchanged); \`super update\` changes that` } : {}),
      });
    } finally {
      noteResuming(child, false);
    }
  },

  update: async (c, b, res) => {
    // A RUNNING child, through the window's own `model`, `effort` and `mode` verbs into its tab
    // (the super's token, the child's limits: a delegate's modes, model ids and efforts).
    if (!requireHandedOver(c, res)) return;
    const child = childArg(c, b, res);
    if (!child) return;
    const ch = c.state.children[child];
    const mode = str(b.mode);
    if (mode && !(MODES as readonly string[]).includes(mode)) { refuse(res, 400, 'invalid_args', `mode must be one of ${MODES.join(' | ')}`); return; }
    const model = str(b.model);
    if (model && !sanitizeModel(model)) { refuse(res, 400, 'invalid_args', 'model is not a model id'); return; }
    const effort = str(b.effort);
    if (effort && !(EFFORTS as readonly string[]).includes(effort)) { refuse(res, 400, 'invalid_args', `effort must be one of ${EFFORTS.join(' | ')}`); return; }
    if (!mode && !model && !effort) { refuse(res, 400, 'invalid_args', 'name what changes: --mode, --model or --effort'); return; }
    if (ch.endedAt !== undefined) {
      refuse(res, 409, 'ended', 'that child was ended; `dreamcontext super resume <child>` with the same flags reopens it with them');
      return;
    }
    if (!isLiveChat(child)) {
      refuse(res, 409, 'not_running', 'that child is not running; `dreamcontext super resume <child>` with the same flags reopens it with them');
      return;
    }
    if (ch.adopted && b.force !== true) {
      refuse(res, 409, 'adopted', 'that is the owner\'s own chat; change it only when he asks, with --force');
      return;
    }
    // Model and effort first: they apply in place, and a mode change then respawns the chat
    // carrying them (a mode sent first would leave the next verb naming a tab being replaced).
    const steps: Array<{ verb: 'model' | 'effort' | 'mode'; args: Record<string, unknown> }> = [];
    if (model) steps.push({ verb: 'model', args: { tab: child, model } });
    if (effort) steps.push({ verb: 'effort', args: { tab: child, level: effort } });
    if (mode) steps.push({ verb: 'mode', args: { tab: child, mode } });
    const applied: Record<string, unknown> = {};
    const record = () => writeSuper(c.who.contextRoot, (s) => {
      const x = s.children[child];
      if (!x) return;
      if ('model' in applied && model) x.model = model;
      if ('effort' in applied && effort) x.effort = effort;
      if ('mode' in applied && mode) { if (mode === 'basic') delete x.mode; else x.mode = mode; }
    });
    for (const step of steps) {
      const r = await sendWindowCommand(c.token, step.verb, step.args);
      if (!r.ok) {
        if (Object.keys(applied).length) await record();
        refuse(res, 409, r.error === 'no_window' ? 'no_window' : 'window_refused', r.error === 'no_window'
          ? 'no window is showing the Super Agent right now'
          : `the window did not change its ${step.verb}: ${oneLine(r.error).slice(0, 200)}`, { child, applied });
        return;
      }
      applied[step.verb] = r.result ?? true;
    }
    await record();
    ok(res, { child, applied });
  },

  adopt: async (c, b, res) => {
    // An open chat of THIS project becomes a child mid-hand-over. Every chat the super did not
    // start is the owner's, so it is adopted only on his word (`--force`); the super's own
    // session, another mode's chat, another vault's and a closed one never.
    if (!requireHandedOver(c, res)) return;
    const root = c.who.contextRoot;
    const sid = str(b.chat);
    const vault = vaultNameOf(root);
    if (!sid || !SESSION_ID_RE.test(sid) || isReservedId(sid) || sid === c.state.session) {
      refuse(res, 404, 'unknown_chat', 'name an open chat of this project by its session id (`dreamcontext window state` lists them)');
      return;
    }
    const have = hasChild(c.state, sid) ? c.state.children[sid] : undefined;
    if (have && have.endedAt === undefined) { ok(res, { child: sid, adopted: false, already: true }); return; }
    if (adoptableChats([sid], vault).length !== 1) {
      if (have) { refuse(res, 409, 'ended', 'that child was ended; `dreamcontext super resume <child>` reopens it'); return; }
      refuse(res, 404, 'unknown_chat', 'not an open chat of this project (an Assistant, a Super Agent or a closed chat is never adopted)');
      return;
    }
    // Not a running child of yours: a chat you never started, or an ended child he reopened.
    if (b.force !== true) {
      refuse(res, 409, 'owners_chat', 'that is the owner\'s own chat; adopt it only when he asks, with --force');
      return;
    }
    const brief = oneLine(str(b.brief) ?? '').slice(0, MAX_BRIEF);
    let container: string | null = null;
    await writeSuper(root, (s) => { container = adoptChat(s, sid, brief); });
    void pumpSuper(root);
    ok(res, { child: sid, adopted: true, container });
  },

  'team-ask': async (c, b, res) => {
    // A job for one of THIS project's AI Team members, through the AI Team's own say path
    // (`sayToAgent`): the member's thread, model, approval and queue rule it. Nothing here starts
    // a run any other way.
    if (!requireHandedOver(c, res)) return;
    const root = c.who.contextRoot;
    const vault = vaultNameOf(root);
    const member = str(b.member);
    if (!member || !okMember(member)) {
      refuse(res, 404, 'unknown_member', 'name a member of this project\'s AI Team by its slug (`dreamcontext agents list`)');
      return;
    }
    const text = typeof b.text === 'string' ? b.text : '';
    if (!text.trim()) { refuse(res, 400, 'invalid_args', 'write the job for the member'); return; }
    const r = sayToAgent(root, { slug: member, text, via: 'super' });
    if (!r.ok) {
      if (r.code === 'not_found' || r.code === 'say_disabled') {
        // Gone or turned off: an approval question about it no longer waits on the owner.
        await closeApprovalsFor(root, member);
      }
      if (r.code === 'not_found') {
        refuse(res, 404, 'unknown_member', `no AI Team member "${member}" in this project (\`dreamcontext agents list\`)`);
        return;
      }
      if (r.code === 'say_unapproved') {
        // The owner approves a member in AI Team; the super never can. His strip gets the question.
        const ownerText = `${member} is not approved on this Mac, so the Super Agent cannot give it a job. Approve it in AI Team, then tell the Super Agent.`;
        let item: string | null = null;
        await writeSuper(root, (s) => { item = askOwnerToApprove(s, member, ownerText); });
        refuse(res, 409, 'say_unapproved', `${wrapUntrusted(vault, r.message)} You cannot approve it: the owner does, in AI Team. His queue strip asks him now; give the job again once he says so.`, { item });
        return;
      }
      // Its title can ride the refusal (a shared brain's text): fenced.
      refuse(res, r.status, r.code, wrapUntrusted(vault, r.message));
      return;
    }
    const out = r.body as { runId?: unknown; entryId?: unknown; queued?: unknown; job?: { id?: unknown; kind?: unknown } };
    const runId = typeof out.runId === 'string' ? out.runId : new Date().toISOString();
    const job: SuperTeamJob = {
      id: newTeamJobId(),
      member,
      runId,
      ...(typeof out.entryId === 'string' ? { entryId: out.entryId } : {}),
      jobKind: out.job?.kind === 'reply' ? 'reply' : 'run',
      ...(typeof out.job?.id === 'string' ? { jobId: out.job.id } : {}),
      queued: out.queued === true,
      brief: oneLine(str(b.brief) ?? firstLine(text, MAX_BRIEF)).slice(0, MAX_BRIEF),
      startedAt: Date.now(),
    };
    await writeSuper(root, (s) => recordTeamJob(s, job));
    if (job.jobKind === 'reply' && job.jobId) recordReplyEnding(root, job.id, job.jobId);
    // A run's ending is in its thread and run cache already: the write only pushes the window,
    // so the job's card turns done or failed without a poll.
    if (job.jobKind === 'run' && job.jobId) void whenRunSettles(job.jobId)?.then(() => writeSuper(root, () => {})).catch(() => { /* best-effort */ });
    ok(res, { job: job.id, member, runId, queued: job.queued, status: job.queued ? 'queued' : 'running' });
  },
};

/** A team job as the agent reads it: its live status and last line (the member's text, fenced). */
function teamJobRow(root: string, vault: string, j: SuperTeamJob): Record<string, unknown> {
  const live = teamJobLive(root, j, liveSayJob(root, j));
  return {
    ...j,
    brief: j.brief ? wrapUntrusted(vault, j.brief) : '',
    status: live.status,
    lastLine: live.lastLine ? wrapUntrusted(vault, live.lastLine) : '',
  };
}

/** A reply job's delivery window in ms (`deliveredAt`/`endedAt` of a team job). */
function replyTimes(r: { deliveredAt?: string; finishedAt: string | null }): { deliveredAt?: number; endedAt?: number } {
  const from = r.deliveredAt ? Date.parse(r.deliveredAt) : NaN;
  const to = r.finishedAt ? Date.parse(r.finishedAt) : NaN;
  return { ...(Number.isFinite(from) ? { deliveredAt: from } : {}), ...(Number.isFinite(to) ? { endedAt: to } : {}) };
}

/** When a reply job settles, its ending goes into the team job: the say path forgets it an hour
 *  later (or with a restart), and the member's thread cannot tell it from the busy turn's. */
function recordReplyEnding(root: string, teamJobId: string, replyJobId: string): void {
  void whenReplySettles(replyJobId)?.then((r) => writeSuper(root, (s) => settleTeamJob(s, teamJobId, {
    outcome: r.status === 'ok' ? 'done' : 'failed', ...replyTimes(r),
  }))).catch(() => { /* the record is best-effort; a settled job without it reads failed */ });
}

/** Close the open approval questions about one member (it is gone or turned off). */
async function closeApprovalsFor(root: string, member: string): Promise<void> {
  try { await writeSuper(root, (s) => { closeSettledApprovals(s, (m) => m !== member); }); } catch { /* best-effort */ }
}

/**
 * Re-check every open approval question against the member itself: approved since (the owner did
 * it in AI Team and never said so), turned off, or deleted. Closed ones leave the strip, so they no
 * longer hold later escalations behind them. Writes only when something closed.
 */
async function settleApprovals(root: string, state: SuperState): Promise<SuperState> {
  const open = state.queue.filter((q) => q.kind === 'approval' && q.state !== 'done' && q.member);
  if (!open.length) return state;
  const waiting = new Map<string, boolean>();
  for (const q of open) {
    const member = q.member as string;
    if (waiting.has(member)) continue;
    let still = true;
    try {
      const m = getAutomation(root, member);
      still = !!m && m.enabled && !checkApproval(dirname(root), m, undefined, 'run').approved;
    } catch { still = true; }
    waiting.set(member, still);
  }
  if ([...waiting.values()].every(Boolean)) return state;
  try {
    return await writeSuper(root, (s) => { closeSettledApprovals(s, (m) => waiting.get(m) ?? true); });
  } catch { return state; }
}

// The window's view reads each team card's status through the same live jobs (team.ts imports no
// server code).
setTeamLiveSource(liveSayJob);

/** The say path's own job for a team job, while it is in memory. */
function liveSayJob(root: string, j: SuperTeamJob): LiveSayJob | null {
  if (!j.jobId) return null;
  if (j.jobKind === 'reply') {
    const r = currentReplyJob(j.jobId);
    return r ? { kind: 'reply', status: r.status, phase: r.phase, ...replyTimes(r) } : null;
  }
  const run = currentAutomationJob(root, j.member);
  return run && run.id === j.jobId ? { kind: 'run', status: run.status } : null;
}

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

/** The owner's own chat: adopted (at hand-over, by `super adopt`, or reopened by him), or an
 *  ended child running again that no `super resume` started (he reopened it before the record
 *  caught up). Ending, changing, reopening or adopting it takes his word (`--force`). */
function ownersChat(sid: string, ch: SuperChild): boolean {
  return ch.adopted || (ch.endedAt !== undefined && isLiveChat(sid));
}

/** The mode, model and effort a window's `resume` answer says it used, else the request. */
function usedSettings(result: unknown, asked: { mode: string; model?: string; effort?: string }):
  { mode: string; model?: string; effort?: string; reported: boolean } {
  const r = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (typeof r.mode !== 'string' || !(MODES as readonly string[]).includes(r.mode)) return { ...asked, reported: false };
  const model = typeof r.model === 'string' && r.model && sanitizeModel(r.model) ? r.model : undefined;
  const effort = typeof r.effort === 'string' && (EFFORTS as readonly string[]).includes(r.effort) ? r.effort : undefined;
  return { mode: r.mode, model, effort, reported: true };
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
  if (ownersChat(sid, ch) && !force) {
    return { child: sid, ended: false, reason: 'adopted', message: 'that is the owner\'s own chat; end it only when he asks, with --force' };
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
  noteSuperSend(sid, SUCCESSOR_STOP_TEXT);
  const sent = await sendWindowCommand(c.token, 'send', { tab: sid, text: SUCCESSOR_STOP_TEXT }).catch(() => null);
  const how = sent?.ok ? (sent.result as { delivered?: unknown } | undefined)?.delivered : undefined;
  return { child: sid, ended: false, reason: r.reason, told: typeof how === 'string' ? how : !!sent?.ok };
}

/**
 * A succeeded child that was busy at the handoff is ended at its next idle (end review: it was
 * only warned about). Armed once at boot, beside the outbox.
 */
let successionArmed: (() => void) | null = null;
export function armSuperSuccession(): void {
  if (successionArmed) return;
  successionArmed = onChatChange(({ entry, from }) => {
    if (entry.status !== 'idle' || from === 'idle') return;
    const root = superRootOfChild(entry.sessionId);
    if (root) void endSucceededChild(root, entry.sessionId).catch(() => undefined);
  });
}

export async function endSucceededChild(contextRoot: string, sid: string): Promise<boolean> {
  const s = await readSuperState(contextRoot, superSanitizeOpts());
  const ch = s.children[sid];
  if (!ch?.succeededBy || ch.endedAt !== undefined || ch.adopted) return false;
  const outcome = await parkChat(sid, 'super-end', { end: true }).catch((): ParkOutcome => 'refused');
  if (outcome !== 'parked' && outcome !== 'drained' && outcome !== 'already') return false;
  await recordEnded(contextRoot, sid);
  return true;
}

/** Tests only. */
export function _resetSuperSuccession(): void {
  successionArmed?.();
  successionArmed = null;
}

/** Record a child ended (the agent's `super end` and the owner's card close share it): its card
 *  goes, its open queue items close, a done `ended` item records who, when and its last brief. */
async function recordEnded(contextRoot: string, sid: string): Promise<void> {
  const now = Date.now();
  await writeSuper(contextRoot, (s) => {
    const x = s.children[sid];
    if (!x) return;
    x.endedAt = now;
    // Its job-list row rests in done (Bitti), never stuck or gone.
    setRow(x, 'done', undefined, now);
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
  const raw = (await parseJsonBody(req)) ?? {};
  // A child may be named by the first characters of its id (child-ref.ts); resolved once, here.
  const expanded = expandChildRefs(caller.state, verb, raw as Record<string, unknown>);
  if ('error' in expanded) {
    const { error, message, matches } = expanded.error;
    refuse(res, error === 'ambiguous_child' ? 409 : 404, error, message, matches ? { matches } : {});
    return;
  }
  const body = expanded.body;
  const cue = CUED_VERBS.has(verb) ? captureOk(res) : null;
  ensureTidy(caller.who.contextRoot, TIDY_IO);
  try {
    await SUPER_VERB_HANDLERS[verb](caller, body as Record<string, unknown>, res);
  } catch (err) {
    if (!res.headersSent) storeRefusal(res, err);
  }
  // AC16: the window shows what the verb did (a card flying out of the centre, a fade, a pulse)
  // and may play a short sound. Pushed after the verb's own state push, on the super chat's socket.
  const result = cue?.();
  if (result !== undefined) pushFrame(caller.token, { subtype: SUPER_FRAME_CUE, verb, ids: cueIds(body as Record<string, unknown>, result) });
}

/** The verbs the window gives a visible cue (AC16). */
const CUED_VERBS = new Set<SuperVerb>(['delegate', 'open', 'half', 'present', 'stack', 'float', 'close', 'group', 'ungroup', 'merge', 'answer']);

/** Watch a response: returns the `result` of a 200 `{ok:true}` answer, undefined otherwise. */
function captureOk(res: ServerResponse): () => unknown {
  let status = 0;
  let body = '';
  const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => ServerResponse;
  const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
  (res as unknown as { writeHead: (...a: unknown[]) => ServerResponse }).writeHead = (...a: unknown[]) => { status = Number(a[0]); return writeHead(...a); };
  (res as unknown as { end: (...a: unknown[]) => ServerResponse }).end = (...a: unknown[]) => { if (typeof a[0] === 'string') body = a[0]; return end(...a); };
  return () => {
    if (status !== 200 || !body) return undefined;
    try {
      const j = JSON.parse(body) as { ok?: unknown; result?: unknown };
      return j.ok === true ? (j.result ?? null) : undefined;
    } catch { return undefined; }
  };
}

/** The cards a verb touched, for its cue: ids named in the request or returned in the result. */
function cueIds(body: Record<string, unknown>, result: unknown): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.length <= 60) ids.add(v);
    else if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { id?: unknown }).id === 'string') ids.add((v as { id: string }).id);
  };
  const scan = (o: unknown) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    const r = o as Record<string, unknown>;
    for (const k of ['container', 'closed', 'group']) add(r[k]);
    for (const k of ['containers', 'targets']) if (Array.isArray(r[k])) for (const x of r[k] as unknown[]) add(x);
  };
  scan(body);
  scan(result);
  return [...ids].slice(0, MAX_CONTAINERS);
}

// ─── The owner's door ────────────────────────────────────────────────────────

/** Desktop app, this machine, a loopback Host, and this very origin (port included, T0):
 *  not a cross-site request and not a page on another loopback port. Sends the 403. */
export function requireSuperOwner(req: IncomingMessage, res: ServerResponse): boolean {
  if (!requireLocalDesktop(req, res)) return false;
  if (isCrossSiteRequest(req) || !isSameOriginStrict(req)) {
    sendError(res, 403, 'forbidden', 'The Super Agent hand-over only answers this machine\'s own window.');
    return false;
  }
  return true;
}

/** GET /api/super/state — the vault's record, for the window's first paint (pushed after). */
export async function handleSuperStateGet(req: IncomingMessage, res: ServerResponse, _params: Params, contextRoot: string): Promise<void> {
  if (!requireSuperOwner(req, res)) return;
  ensureTidy(contextRoot, TIDY_IO);
  try {
    let state = await readSuperState(contextRoot, superSanitizeOpts());
    // The agenda is always on a shown stage (owner 2026-10-22 23:44): a record without one gets
    // it at its default place on this load.
    // A write that fails never fails the load: the window gets what was read.
    if (agendaMissing(state)) {
      try { state = await writeSuper(contextRoot, (s) => { if (agendaMissing(s)) showAgendaCard(s); }); } catch (err) {
        console.warn(`[super] ${contextRoot}: the agenda was not put on the stage: ${(err as Error).message}`);
      }
    }
    sendJson(res, 200, superStateView(contextRoot, await settleApprovals(contextRoot, state)));
  } catch (err) { storeRefusal(res, err); }
}

export type SuperOwnerVerb = 'enable' | 'disable' | 'layout' | 'activity' | 'recap' | 'end' | 'fresh' | 'seen' | 'pad';
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
      sendError(res, 400, 'invalid_body', `cards and closed must be lists of at most ${MAX_CONTAINERS}`);
      return;
    }
    // The owner opened these (a group's panel, a card full screen): touched now (tidy.ts).
    const touch = Array.isArray(body.touch) ? (body.touch as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, MAX_CONTAINERS) : [];
    if (touch.length) touchCards(contextRoot, touch);
    // A touch alone changes nothing on the record: no write.
    if (Object.keys(body).every((k) => k === 'touch')) {
      sendJson(res, 200, { state: superStateView(contextRoot, await readSuperState(contextRoot, superSanitizeOpts())) });
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
      // Cards that leave what the view shows: to Others (a group's cards with it), closed,
      // grouped or resized (owner 2026-10-22: a presented card moved to Others stayed presented).
      const unshown = new Set<string>();
      if (leave.length) leaveGroups(s, leave);
      for (const raw of cards as unknown[]) {
        const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
        const k = p && typeof p.id === 'string' ? (s.containers.find((x) => x.id === p.id) ?? s.groups.find((x) => x.id === p.id)) : undefined;
        if (!p || !k) continue;
        if (p.place === 'others') for (const id of 'kind' in k ? [k.id] : k.cards) unshown.add(id);
        if ('kind' in k && p.size !== undefined) unshown.add(k.id);
        if (p.place === 'float' || p.place === 'others') k.place = p.place;
        if (p.pos === null) delete k.pos;
        else if (p.pos && typeof p.pos === 'object') k.pos = p.pos as { x: number; y: number };
        // The owner's size (a card only; a group is always one tile): his choice, which no agent
        // verb overrides; `null` hands it back (small, and the agent may size it again).
        if ('kind' in k && p.size === null) { delete k.size; delete k.sizeBy; }
        else if ('kind' in k && typeof p.size === 'string' && (CONTAINER_SIZES as readonly string[]).includes(p.size)) {
          if (p.size === 'small') delete k.size; else k.size = p.size as ContainerSize;
          k.sizeBy = 'owner';
        }
        // The card the owner moved last is drawn on top: it goes to the end of the list.
        if (p.order === 'last' && 'kind' in k) s.containers = [...s.containers.filter((x) => x !== k), k];
      }
      if (groupOp) { applyGroupOp(s, groupOp); for (const id of groupOp.cards) unshown.add(id); }
      // The one card the owner may (re)open here: the super's agenda (owner 2026-10-22), from
      // the centre's head after he closed it, put it in Others or grouped it: out of its group,
      // floating (his ask; MAX_FLOAT binds only what an agent opens).
      if (body.agenda === 'open') ensureAgendaCard(s, { bring: true, owner: true });
      if (ungroup.length) dissolveGroups(s, ungroup);
      const gone = new Set((closed as unknown[]).filter((x): x is string => typeof x === 'string'));
      // The agenda never leaves the stage (owner 2026-10-22 23:44): its close, or the owner's
      // minimise, collapses it to the pill in the bottom-left corner.
      const agendaId = s.containers.find((x) => x.kind === 'agenda')?.id;
      if (body.agenda === 'min' || (agendaId && gone.has(agendaId))) {
        const id = minimiseAgendaCard(s);
        if (id) { gone.delete(id); unshown.add(id); }
      }
      for (const id of gone) unshown.add(id);
      s.view = viewWithout(s.view, unshown);
      if (gone.size) {
        // The owner's "no" to an automatic card: not reopened automatically for a while (G5).
        noteDismissed(s, s.containers.filter((x) => gone.has(x.id)), Date.now());
        s.containers = s.containers.filter((x) => !gone.has(x.id));
      }
      // The store sanitizes what this produced: positions clamped, a view naming no card → float.
      // The owner's view is his: it never carries the server's "put here on its own" mark.
      if (view !== undefined) {
        s.view = view as SuperState['view'];
        if (s.view && typeof s.view === 'object') delete (s.view as { auto?: unknown }).auto;
      }
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
  seen: async (_req, res, contextRoot, body) => {
    // The owner looked at finished jobs in the agenda (task super-agent-ajandasi-…): each entry
    // names a child and the finish key his window SHOWED (`at`), so a result that finished again
    // after that frame stays new. Only ever raises `seenAt`; unknown children are ignored.
    const raw = body.children;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CONTAINERS) {
      sendError(res, 400, 'invalid_body', `children must be a list of 1 to ${MAX_CONTAINERS} { id, at }`);
      return;
    }
    const marks: Array<{ id: string; at: number }> = [];
    for (const x of raw as unknown[]) {
      const o = x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null;
      const at = o && typeof o.at === 'number' && Number.isFinite(o.at) && o.at >= 0 ? o.at : NaN;
      if (!o || typeof o.id !== 'string' || !SESSION_ID_RE.test(o.id) || !Number.isFinite(at)) {
        sendError(res, 400, 'invalid_body', 'each entry is { id: <child session id>, at: <the finish time shown> }');
        return;
      }
      marks.push({ id: o.id, at: Math.min(at, Date.now()) });
    }
    const state = await writeSuper(contextRoot, (s) => {
      for (const m of marks) {
        const ch = hasChild(s, m.id) ? s.children[m.id] : undefined;
        if (ch && !(ch.seenAt !== undefined && ch.seenAt >= m.at)) ch.seenAt = m.at;
      }
    });
    sendJson(res, 200, { state: superStateView(contextRoot, state) });
  },
  pad: async (_req, res, contextRoot, body) => {
    // The owner moved an agenda line by hand (the card's Done / Put back): `by: 'owner'`, so the
    // server never moves it again (pad.ts; pattern: the agent must not undo what the owner did).
    const id = typeof body.id === 'string' ? body.id : '';
    const section = body.section === 'now' || body.section === 'done' ? body.section : null;
    if (!PAD_ID_RE.test(id) || !section) { sendError(res, 400, 'invalid_body', 'give { id: <note id>, section: now | done }'); return; }
    let found = false;
    const state = await writeSuper(contextRoot, (s) => {
      s.pad = (s.pad ?? []).map((p) => {
        if (p.id !== id) return p;
        found = true;
        const { why: _w, toldAt: _t, ...rest } = p;
        return { ...rest, section, by: 'owner' as const, at: p.section === section ? p.at : Date.now() };
      });
      // Moved to the end, like every other move into a section.
      const moved = s.pad.find((p) => p.id === id);
      if (moved) s.pad = [...s.pad.filter((p) => p.id !== id), moved];
    });
    if (!found) { sendError(res, 404, 'unknown_note', 'no such agenda line'); return; }
    sendJson(res, 200, { state: superStateView(contextRoot, state) });
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
  fresh: async (_req, res, contextRoot) => {
    // The owner's "New session": ONE solo `[super fresh]` turn in which the super writes its
    // handoff file; its pane then rotates into a fresh session on the same stage (inbox.ts,
    // agent-chat.ts, super/fresh-session.ts). Children, pool, cards and queue stay.
    let current = await readSuperState(contextRoot, superSanitizeOpts());
    const session = current.session;
    if (!current.enabled || !session || !findLiveChat(session)) {
      sendError(res, 409, 'off', 'the Super Agent is not running here');
      return;
    }
    if (isRotating(session)) {
      sendError(res, 409, 'rotating', 'a fresh session is already opening');
      return;
    }
    // A leftover from before a restart frees the button; one still on its way refuses a second.
    current = await sweepOrphanFresh(contextRoot, current);
    if (freshInFlight(contextRoot, current)) {
      sendError(res, 409, 'rotating', 'a fresh session is already on its way');
      return;
    }
    let queued = false;
    await writeSuper(contextRoot, (s) => {
      if (!s.enabled || s.session !== session || s.queue.some((q) => q.kind === 'fresh' && q.state === 'pending')) return;
      s.queue.push({ id: newQueueId(), sessionId: session, kind: 'fresh', state: 'pending', createdAt: Date.now() });
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
    ensureTidy(contextRoot, TIDY_IO);
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
export const handleSuperFresh = ownerRoute('fresh');
export const handleSuperSeen = ownerRoute('seen');
export const handleSuperPad = ownerRoute('pad');
