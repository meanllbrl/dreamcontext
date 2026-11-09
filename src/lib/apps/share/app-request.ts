/**
 * An agent asks for one app action; the owner says Onayla; the agent does exactly that, once
 * (app-onay-karti plan r3, C3, D4-D10).
 *
 * The server builds ONE action plan per request from its own reads plus the agent's inputs: the
 * card's lines, the hash and the spend all come from that object, so what runs is what was shown.
 * Every input that changes behaviour or waives a protection is a card line and part of the hash.
 * The card is a notch proposal (four click-only verbs); while the owner is away it also goes to
 * Telegram. `decideAppRequest` is the ONLY place a request grant is minted: from the owner-key
 * decide route or an authenticated Telegram tap.
 *
 * Memory only (D8): a restart drops every request and grant, and the agent asks again.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { APP_PROPOSAL_TIMEOUT_MS, closeProposal, createProposal, setProposalApp, type AppCardLine, type AppCardView, type AppRequestVerb } from '../../assistant/proposals.js';
import { getChat, listChats, type ChatEntry } from '../../assistant/chat-registry.js';
import { APP_GRANT_TTL_MS, mintAppGrant, onAppGrantSpent, type AppAction, type GrantVisibility } from './app-grant.js';

export type { AppAction };

/** What the spend runs, per action. Agent text only ever sits in plain value fields. */
export interface PublishPlan {
  action: 'publish';
  slug: string;
  visibility: GrantVisibility;
  /** The repo it goes to now (`owner/name`), for the card. */
  target: string;
  repoName: string | null;
  invite: string[];
  approvals: string[];
  /** The note the publish writes (null: the README already holds this version's words). */
  note: string | null;
  catalog: boolean;
  /** The gated tree's digest the spend must rebuild exactly (covers own apps and copies). */
  digest: string;
  /** The README entry's date, so a spend after midnight still matches. */
  date: string;
  login: string;
}
export interface UpdatePlan {
  action: 'update';
  slug: string;
  sha: string;
  how: 'merge' | 'set-aside' | null;
  /** Derived (any manifest change), never the agent's word. */
  approveManifest: boolean;
  manifestChanges: string[];
  edited: string[];
  wouldLose: string[];
}
export interface InstallPlan {
  action: 'install';
  fullName: string;
  previewId: string;
  sha: string;
  config: Record<string, string>;
}
export interface LogoPlan {
  action: 'logo';
  slug: string;
  sha256: string;
  type: 'image/png' | 'image/jpeg';
}

export type ActionBody = PublishPlan | UpdatePlan | InstallPlan | LogoPlan;

export interface ActionPlan {
  vault: string;
  projectRoot: string;
  /** The grant slot's app key: the slug, or for an install the lowercase `owner/repo`. */
  key: string;
  appName: string;
  title: string;
  lines: AppCardLine[];
  warn?: string;
  renewal?: boolean;
  body: ActionBody;
}

export type RequestState = 'pending' | 'approved' | 'rejected' | 'expired' | 'stale' | 'replaced' | 'used';

interface AppRequest {
  id: string;
  proposalId: string;
  plan: ActionPlan;
  hash: string;
  renewHash: string;
  state: RequestState;
  createdAt: number;
  grant: { id: string; expiresAt: number } | null;
  spent: boolean;
  /** The requester's chat ids (tab pin id, agent session id): delivery only. */
  agentSessions: string[];
  logo: Buffer | null;
  /** Rebuilds the plan's bound fact at approve time: false = stale, no grant. */
  stillFresh: () => Promise<boolean>;
}

export const REQUEST_LIFETIME_MS = APP_PROPOSAL_TIMEOUT_MS;
export const REJECT_COOLDOWN_MS = 10 * 60_000;
export const MAX_OPEN_REQUESTS = 10;
export const MAX_WAITERS = 16;
export const MAX_WAIT_S = 110;

const VERB: Record<AppAction, AppRequestVerb> = { publish: 'app-publish', update: 'app-update', install: 'app-install', logo: 'app-logo' };
export const RENEWAL_TITLE = 'Süresi doldu: yeniden onaylıyor musun?';

const requests = new Map<string, AppRequest>();
const byProposal = new Map<string, string>();
const cooldown = new Map<string, number>();
const waiters = new Map<string, Set<() => void>>();
let waiting = 0;
type Opened = (r: { id: string; vault: string; view: AppCardView; hash: string; logo: Buffer | null }) => void;
const openedListeners = new Set<Opened>();
type Deliver = (chat: ChatEntry, text: string) => Promise<void>;
let deliver: Deliver | null = null;

const slotOf = (p: Pick<ActionPlan, 'projectRoot' | 'key' | 'body'>) => `${p.projectRoot}\0${p.key}\0${p.body.action}`;

onAppGrantSpent((requestId) => {
  const r = requests.get(requestId);
  if (r) { r.spent = true; r.state = 'used'; }
});

/** Canonical JSON: keys sorted, so one plan always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The hash a card carries and a decide must echo. */
export function planHash(plan: ActionPlan): string {
  return createHash('sha256').update(canonical(plan)).digest('hex');
}

/** The renewal match (D9): the plan without its README date and its title, so the same ask
 *  the next day still reads "Süresi doldu". */
function renewalHash(plan: ActionPlan): string {
  const body = plan.body.action === 'publish' ? { ...plan.body, date: '' } : plan.body;
  const lines = plan.lines.filter((l) => !(plan.body.action === 'publish' && l.label === 'Sürüm'));
  return createHash('sha256').update(canonical({ ...plan, title: '', renewal: false, lines, body })).digest('hex');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const STALE_CHECK = async (): Promise<boolean> => false;

function sweep(now: number): void {
  for (const [id, r] of requests) {
    // A request that can never run again (replaced, rejected, stale, used, or out of time) lets go
    // of what it held for the spend: the logo snapshot and the publish tree its check closes over.
    // Its record stays for its 24 h so a late `apps grant` still reads its state.
    const live = r.state === 'pending' || (r.state === 'approved' && !r.spent && !!r.grant && r.grant.expiresAt > now);
    if (!live) { r.logo = null; r.stillFresh = STALE_CHECK; }
    // Kept while its grant can still be spent (a logo spend needs the snapshot).
    if (now - r.createdAt <= REQUEST_LIFETIME_MS || (r.grant && !r.spent && r.grant.expiresAt > now)) continue;
    if (r.state === 'pending') { r.state = 'expired'; closeProposal(r.proposalId, { outcome: 'declined', reason: 'timeout' }); }
    requests.delete(id);
    byProposal.delete(r.proposalId);
    wake(id);
  }
  for (const [k, until] of cooldown) if (until <= now) cooldown.delete(k);
}

function wake(id: string): void {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const fn of set) fn();
}

/** The state an agent reads: an approved grant that ran out unused reads `expired`. */
function stateOf(r: AppRequest, now: number): RequestState {
  if (r.state === 'approved' && r.grant && r.grant.expiresAt <= now && !r.spent) return 'expired';
  return r.state;
}

/** The exact spend command, the only thing the agent runs after Onayla. */
export function spendCommand(plan: ActionPlan, grant: string): string {
  const b = plan.body;
  if (b.action === 'publish') return `dreamcontext apps publish ${b.slug} --go --grant ${grant}`;
  if (b.action === 'update') return `dreamcontext apps update ${b.slug} --apply --grant ${grant}`;
  if (b.action === 'install') return `dreamcontext apps install ${b.fullName} --go --grant ${grant}`;
  return `dreamcontext apps logo ${b.slug} --grant ${grant}`;
}

export class AppRequestError extends Error {
  constructor(public code: 'too_many' | 'cooldown' | 'not_ready' | 'bad_logo', message: string) { super(message); }
}

export interface OpenInput {
  plan: ActionPlan;
  agentSessions?: string[];
  logo?: Buffer | null;
  stillFresh: () => Promise<boolean>;
  now?: number;
}

/**
 * Put a request in front of the owner. A request already approved with a live, unused grant for
 * the same plan answers with that one (asking twice opens no second card). An approved request
 * whose grant ran out unused, same plan, inside a day, makes this card a renewal (D9).
 */
export function openAppRequest(input: OpenInput): { id: string; state: RequestState; renewal: boolean } {
  const now = input.now ?? Date.now();
  sweep(now);
  const slot = slotOf(input.plan);
  const until = cooldown.get(slot);
  if (until && until > now) throw new AppRequestError('cooldown', `The owner said no to this a moment ago. Ask again after ${Math.ceil((until - now) / 60_000)} minute(s), and only if something changed.`);
  const renewHash = renewalHash(input.plan);
  let renewal = false;
  for (const r of requests.values()) {
    if (slotOf(r.plan) !== slot || r.renewHash !== renewHash || r.spent) continue;
    if (r.state === 'approved' && r.grant && r.grant.expiresAt > now) return { id: r.id, state: 'approved', renewal: false };
    if (stateOf(r, now) === 'expired' && r.grant && now - r.createdAt <= REQUEST_LIFETIME_MS) renewal = true;
  }
  const open = [...requests.values()].filter((r) => r.state === 'pending');
  const replacing = open.filter((r) => slotOf(r.plan) === slot);
  if (open.length - replacing.length >= MAX_OPEN_REQUESTS) throw new AppRequestError('too_many', `${MAX_OPEN_REQUESTS} requests already wait for the owner. Wait for him to answer them.`);
  for (const r of replacing) {
    r.state = 'replaced';
    closeProposal(r.proposalId, { outcome: 'declined', reason: 'withdrawn' });
    wake(r.id);
  }
  const plan: ActionPlan = renewal ? { ...input.plan, title: RENEWAL_TITLE, renewal: true } : input.plan;
  const hash = planHash(plan);
  const id = randomBytes(18).toString('base64url');
  const pid = { value: '' };
  const view = (): AppCardView => ({
    action: plan.body.action, appName: plan.appName, vault: plan.vault, title: plan.title, lines: plan.lines,
    ...(plan.warn ? { warn: plan.warn } : {}),
    ...(input.logo ? { image: `/api/apps/requests/${pid.value}/logo` } : {}),
    ...(plan.renewal ? { renewal: true } : {}),
    hash,
  });
  // The proposal id is the card's; the image path needs it, so the view is filled after.
  const { view: pv, decision } = createProposal({
    verb: VERB[plan.body.action], target: `${plan.vault} · ${plan.appName}`, text: plan.title,
    provenance: 'an agent asks for an app action; Onayla lets it do exactly this, once',
    app: { action: plan.body.action, appName: plan.appName, vault: plan.vault, title: plan.title, lines: plan.lines, hash },
  }, REQUEST_LIFETIME_MS);
  // The proposal store keeps its own copy of the view; the image path needs the proposal id.
  pid.value = pv.id;
  setProposalApp(pv.id, view());
  const req: AppRequest = {
    id, proposalId: pv.id, plan, hash, renewHash, state: 'pending', createdAt: now, grant: null, spent: false,
    agentSessions: input.agentSessions ?? [], logo: input.logo ?? null, stillFresh: input.stillFresh,
  };
  requests.set(id, req);
  byProposal.set(pv.id, id);
  void decision.then((d) => {
    // Onayla and Reddet settle the request first; only the clock or a quit lands here pending.
    if (req.state === 'pending' && d.outcome === 'declined' && (d.reason === 'timeout' || d.reason === 'shutdown')) { req.state = 'expired'; wake(id); }
  });
  for (const fn of [...openedListeners]) { try { fn({ id, vault: plan.vault, view: view(), hash, logo: req.logo }); } catch { /* a listener's failure is its own */ } }
  return { id, state: 'pending', renewal };
}

export type DecideResult =
  | { ok: true; state: RequestState }
  | { ok: false; error: 'unknown' | 'not_pending' | 'card_changed' | 'stale' | 'running'; state?: RequestState };

/**
 * The owner decides (notch with the owner key, or a paired Telegram tap): the ONLY minting place.
 * The hash must be the card's; the plan's bound fact is rebuilt first (stale: no grant).
 */
export async function decideAppRequest(ref: { id?: string; proposalId?: string }, action: 'approve' | 'reject', opts: { by: 'owner-page' | 'telegram'; hash: string; now?: number }): Promise<DecideResult> {
  const id = ref.id ?? (ref.proposalId ? byProposal.get(ref.proposalId) : undefined);
  const r = id ? requests.get(id) : undefined;
  if (!r) return { ok: false, error: 'unknown' };
  if (r.state !== 'pending') return { ok: false, error: 'not_pending', state: stateOf(r, opts.now ?? Date.now()) };
  if (typeof opts.hash !== 'string' || !sameText(opts.hash, r.hash)) return { ok: false, error: 'card_changed' };
  if (action === 'reject') {
    r.state = 'rejected';
    cooldown.set(slotOf(r.plan), (opts.now ?? Date.now()) + REJECT_COOLDOWN_MS);
    closeProposal(r.proposalId, { outcome: 'declined', reason: 'rejected' });
    wake(r.id);
    return { ok: true, state: 'rejected' };
  }
  // Claimed before the await: a second tap during the check finds it not pending.
  r.state = 'approved';
  let fresh = false;
  try { fresh = await r.stillFresh(); } catch { fresh = false; }
  if (!fresh) {
    r.state = 'stale';
    closeProposal(r.proposalId, { outcome: 'declined', reason: 'withdrawn' });
    wake(r.id);
    return { ok: false, error: 'stale', state: 'stale' };
  }
  const now = opts.now ?? Date.now();
  const visibility = r.plan.body.action === 'publish' ? r.plan.body.visibility : 'private';
  const g = mintAppGrant({ projectRoot: r.plan.projectRoot, key: r.plan.key, action: r.plan.body.action, plan: r.plan, visibility, requestId: r.id, now });
  if (!g) {
    r.state = 'pending';
    return { ok: false, error: 'running' };
  }
  r.grant = { id: g.id, expiresAt: g.expiresAt };
  closeProposal(r.proposalId, { outcome: 'approved', text: r.plan.title });
  wake(r.id);
  void deliverApproval(r).catch(() => {});
  return { ok: true, state: 'approved' };
}

/** What `GET /api/apps/requests/:id` answers. The grant only to whoever holds the request id. */
export function appRequestStatus(id: string, now = Date.now()): { state: RequestState | 'unknown'; grant?: { id: string; expiresAt: string; command: string } } {
  sweep(now);
  const r = requests.get(id);
  if (!r) return { state: 'unknown' };
  const state = stateOf(r, now);
  if (state === 'approved' && r.grant) return { state, grant: { id: r.grant.id, expiresAt: new Date(r.grant.expiresAt).toISOString(), command: spendCommand(r.plan, r.grant.id) } };
  return { state };
}

/** Wait up to `seconds` for the owner (capped); answers at once once decided or over the cap. */
export function waitAppRequest(id: string, seconds: number): Promise<void> {
  const r = requests.get(id);
  const s = Math.max(0, Math.min(MAX_WAIT_S, Number.isFinite(seconds) ? seconds : 0));
  if (!r || r.state !== 'pending' || s === 0 || waiting >= MAX_WAITERS) return Promise.resolve();
  waiting++;
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      waiting--;
      clearTimeout(timer);
      waiters.get(id)?.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, s * 1000);
    timer.unref?.();
    const set = waiters.get(id) ?? new Set<() => void>();
    set.add(finish);
    waiters.set(id, set);
  });
}

/** The snapshotted logo of a card, by its PROPOSAL id (the card's image path). */
export function appRequestLogo(proposalId: string): { data: Buffer; type: string; vault: string } | null {
  const id = byProposal.get(proposalId);
  const r = id ? requests.get(id) : undefined;
  if (!r || !r.logo || r.plan.body.action !== 'logo') return null;
  return { data: r.logo, type: r.plan.body.type, vault: r.plan.vault };
}

/** A logo spend's bytes: the request's snapshot, only when it still hashes to the plan's. */
export function requestLogoBytes(requestId: string, sha256: string): Buffer | null {
  const r = requests.get(requestId);
  if (!r?.logo) return null;
  return createHash('sha256').update(r.logo).digest('hex') === sha256 ? r.logo : null;
}

/** For the Telegram buttons: is the request still open, and its CURRENT hash (never the echoed one). */
export function appRequestOpen(id: string): { hash: string } | null {
  const r = requests.get(id);
  return r && r.state === 'pending' ? { hash: r.hash } : null;
}

/** Every request still waiting, oldest first (Telegram's turn-away flush). */
export function openAppRequests(): Array<{ id: string; vault: string; view: AppCardView; hash: string; logo: Buffer | null }> {
  return [...requests.values()].filter((r) => r.state === 'pending').sort((a, b) => a.createdAt - b.createdAt).map((r) => ({
    id: r.id, vault: r.plan.vault, hash: r.hash, logo: r.logo,
    view: { action: r.plan.body.action, appName: r.plan.appName, vault: r.plan.vault, title: r.plan.title, lines: r.plan.lines, ...(r.plan.warn ? { warn: r.plan.warn } : {}), hash: r.hash },
  }));
}

export function onAppRequestOpened(fn: Opened): () => void {
  openedListeners.add(fn);
  return () => { openedListeners.delete(fn); };
}

// ─── The "[app onayı]" line in the requester's chat (D10): delivery, never authority ──────

/** The live chat of this vault an agent session id names: its pin id, else its conversation id
 *  (a Codex thread, a Claude session). Null: nothing is pushed. */
export function findRequesterChat(sessionId: string | null, vault: string): ChatEntry | null {
  if (!sessionId) return null;
  const direct = getChat(sessionId);
  if (direct && direct.vault === vault) return direct;
  return listChats({ vault }).find((c) => c.conversationId === sessionId) ?? null;
}

export function setAppRequestDelivery(fn: Deliver | null): void { deliver = fn; }

const ACTION_WORD: Record<AppAction, string> = { publish: 'yayın', update: 'güncelleme', install: 'kurulum', logo: 'logo' };

/** Fixed words, the app's key and the command; never agent text (D6). */
export function approvalLine(plan: ActionPlan, grant: string): string {
  return `[app onayı] ${plan.key} için ${ACTION_WORD[plan.body.action]} onaylandı. Bir kez çalıştır: ${spendCommand(plan, grant)}`;
}

async function deliverApproval(r: AppRequest): Promise<void> {
  if (!deliver || !r.grant) return;
  const chat = r.agentSessions.map((s) => findRequesterChat(s, r.plan.vault)).find(Boolean) ?? null;
  if (!chat) return;
  await deliver(chat, approvalLine(r.plan, r.grant.id));
}

/** Tests only: restart drops every request (G8). */
export function resetAppRequests(): void {
  for (const r of requests.values()) if (r.state === 'pending') closeProposal(r.proposalId, { outcome: 'declined', reason: 'shutdown' });
  requests.clear();
  byProposal.clear();
  cooldown.clear();
  for (const id of [...waiters.keys()]) wake(id);
  waiting = 0;
}

export { APP_GRANT_TTL_MS };
