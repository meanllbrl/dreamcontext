import { buildAppLink } from '../app-link.js';
import type { SuperQueueItem, SuperState } from './types.js';
import { getChat, pendingRequest } from '../assistant/chat-registry.js';

/**
 * A question the Super Agent puts to the owner REACHES him (Tilki, 2026-10-21: three `super
 * queue ask`s in one morning sat as a line in the job bar while the agent told him "I asked
 * you"). The job bar draws the question and rings once, but only while the Super stage is
 * mounted, and the turn that escalated is no notch row or banner of its own. So the announcement
 * lives HERE, on the server, at the queue head's edge, whatever page the window shows:
 *
 *   banner — a routable macOS banner to the Super Agent's stage while he is not looking at this
 *            project (another app, another project); the job bar then rings without a banner
 *   phone  — a hands-free `question` push to the super chat while Mac mode exposes the project
 *   notch  — the glance already lists the head (`superGlanceRows`); a notch that polled it
 *            lately shows the row within its 3 s tick
 *   screen — he is looking at this project's window right now (the bar, the notch peek)
 *
 * Every head the owner must answer but a permission (a child's own request, drawn and rung by
 * the window from that request): an escalated child question, the agent's own `ask`, an AI Team
 * approval. ONCE per item per process; a head already open when the server boots is seeded
 * silently. What reached him is kept per item, so `super queue ask` / `super ask` can tell the
 * agent the truth (`reached`, `via`, `note`) instead of "escalated: true".
 *
 * The sinks are injected at boot (src/server/index.ts, the hands-free route), so this module
 * imports neither the notch inbox nor the push notifier.
 */

export type OwnerChannel = 'screen' | 'notch' | 'banner' | 'phone' | 'telegram';

export interface OwnerQuestionReach {
  /** At the head of his bar now. False = waiting behind `ahead` items he must answer first. */
  shown: boolean;
  ahead: number;
  /** What carried it to him. */
  via: OwnerChannel[];
  /** Shown, and at least one channel carried it. */
  reached: boolean;
  /** For the agent: what that means and what to do. */
  note: string;
  /** The server held its banner back because the open notch shows this head (and wrote the
   *  history row): the window's job bar posts none of its own either. Not a channel that
   *  reached him, so it is not in `via`. */
  held?: true;
  /** Not reached: why, in one plain line for the agent (owner 2026-11-09: `reached:false` names
   *  why). Telegram's own part is in `telegram`. */
  why?: string;
  /** Its Telegram copy: `sent` (a message of it landed), `sending` (queued, not landed yet),
   *  `failed` (Telegram refused it; offered again later), `at_mac` (he is at the Mac: the Mac card
   *  only, it goes the moment he writes from Telegram), `no_bot` (no Super bot bound to this
   *  project). Absent: no Telegram part for this item. */
  telegram?: TelegramReach;
}

export type TelegramReach = 'sent' | 'sending' | 'failed' | 'at_mac' | 'no_bot';
/** What the Telegram sink says of one item: taken (it sends it on its own), or why not. */
export type TelegramTake = boolean | 'at_mac' | 'no_bot';

export interface OwnerQuestionPush {
  vault: string;
  /** The super session (registry id and Claude id). */
  sessionId: string;
  key: string;
  title: string;
  body: string;
}

export interface OwnerQuestionSinks {
  /** Which project, and which chat in it, the owner is looking at (notch-inbox presence). */
  presence: () => { vault: string | null; session: string | null };
  /** Post a routable banner; true when one was posted, `held` when the open notch shows it
   *  (no banner, the history row written: owner 2026-11-09, never twice). */
  banner: (title: string, body: string, link: string | null) => boolean | 'held';
  /** Push to the hands-free phones; how many devices it goes to (0 = Mac mode off). */
  push: (q: OwnerQuestionPush) => number;
  /** The project's Super bot (W2): true when a bound bot takes it (it sends on its own and
   *  reports the outcome with {@link noteTelegramSend}), else why not. Called for EVERY open item
   *  the owner answers, not only the head (owner 2026-11-09: a question behind another reached
   *  Telegram only on his next message). Idempotent per item. */
  telegram: (q: { vault: string; sessionId: string; item: SuperQueueItem }) => TelegramTake;
  /** An item it took is closed (answered anywhere, or gone): its Telegram copy says so. */
  telegramClosed: (q: { vault: string; id: string }) => void;
}

const NONE: OwnerQuestionSinks = {
  presence: () => ({ vault: null, session: null }),
  banner: () => false,
  push: () => 0,
  telegram: () => false,
  telegramClosed: () => {},
};
let sinks: OwnerQuestionSinks = NONE;

export function setOwnerQuestionSinks(next: Partial<OwnerQuestionSinks>): void {
  sinks = { ...sinks, ...next };
}

/** A notch that read the glance this recently lists the head within its next tick. */
export const NOTCH_LIVE_MS = 10_000;
let notchPolledAt = 0;
export function noteNotchPoll(now = Date.now()): void {
  notchPolledAt = now;
}

const BODY_CHARS = 180;
/** A job's name in a direct question's banner title. */
const JOB_CHARS = 60;
const ANNOUNCED_CAP = 500;
/** Item id → what reached him. Insertion-ordered, the oldest dropped first. */
const announced = new Map<string, OwnerQuestionReach>();

function remember(id: string, reach: OwnerQuestionReach): void {
  announced.delete(id);
  announced.set(id, reach);
  while (announced.size > ANNOUNCED_CAP) announced.delete(announced.keys().next().value as string);
}

/** Does the owner answer this item (not a permission: the window rings that one)? The exception is
 *  a Bypass child's permission its Super handed him (`escalated`, `permissionToOwner`): the
 *  registry's own ring for it went to the Super, so it is announced here, once. */
export function announces(item: SuperQueueItem | null): item is SuperQueueItem {
  // Main Super's work in a member's Super (`main:*`, plan-r10 1) is never the owner's to answer.
  if (typeof item?.workOrigin === 'string' && item.workOrigin.startsWith('main:')) return false;
  if (item?.kind === 'owner') return item.state !== 'done';
  if (item?.kind === 'permission') return item.state === 'escalated' && !item.toSuper;
  // A child's question shown to him from birth (`direct`): announced when it is asked.
  if (item?.kind === 'question' && item.direct === true && !item.team) return item.state !== 'done';
  return !!item && item.state === 'escalated' && (item.kind === 'question' || item.kind === 'ask' || item.kind === 'approval');
}

function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > BODY_CHARS ? `${flat.slice(0, BODY_CHARS - 1).trimEnd()}…` : flat;
}

function bodyOf(item: SuperQueueItem): string {
  if (item.kind === 'approval') return `An AI Team member needs your approval${item.member ? `: ${item.member}` : ''}.`;
  if (item.kind === 'owner') return clip(`A job needs you: ${item.ownerText ?? 'something only you can do'}`);
  // The tool's NAME only (the push rule, dashboard-server-security §7): never its command or path,
  // and never the Super's words, which it wrote from that command. Those show on the phone card.
  if (item.kind === 'permission') {
    const tool = pendingRequest(getChat(item.sessionId), item.requestId)?.toolName ?? '';
    return clip(`A job asks to use ${/^[A-Za-z0-9_.:-]{1,80}$/.test(tool) ? tool : 'a tool'}. Allow or deny it on your phone or the Mac.`);
  }
  return clip(item.ownerText ?? '') || 'A question is waiting for your answer.';
}

function noteFor(item: SuperQueueItem, shown: boolean, ahead: number, via: OwnerChannel[], reached: boolean, why?: string): string {
  const answer = item.kind === 'question'
    ? 'His pick goes to the child directly, or he writes to you.'
    : 'His answer is his next message to you.';
  if (!shown) {
    if (via.includes('telegram')) {
      return `Reached him on Telegram, with its buttons. On the Mac it is a card in your chat and waits in his bar behind ${ahead} item(s). In this turn say in one line that a question waits; the choice stays in the card, then end your turn. ${answer}`;
    }
    return `Not shown yet: ${why ?? `in his bar it waits behind ${ahead} item(s)`}. It is a card in your chat and is announced when it comes up. He has not seen it: do not tell him you asked.`;
  }
  if (!reached) {
    return `NOT seen: ${why ?? 'nothing reached him'}${via.includes('notch') ? ' (only the notch lists it)' : ''}. It waits as a card in your chat and at the head of his bar. In this turn say in one line that a question waits; the choice stays in the card, never only in your text: your reply reaches him when he is back. ${answer}`;
  }
  return `Reached him (${via.join(', ')}): it waits as a card in your chat and at the head of his bar, with its buttons. In this turn say in one line that a question waits; the choice stays in the card, never only in your text, then end your turn; never wait for it. ${answer}`;
}

/** How many owner items come before a question at the head: every open permission, then the
 *  older questions (`superQueueHead`'s order). */
function aheadOf(state: Pick<SuperState, 'queue'>, item: SuperQueueItem): number {
  return state.queue.filter((q) => q.id !== item.id
    && ((q.kind === 'permission' && q.state !== 'done' && !q.toSuper) || (announces(q) && q.createdAt < item.createdAt))).length;
}

/**
 * A write left `head` at the head of a handed-over vault's queue: announce it, once (banner,
 * phone). Telegram is separate: EVERY open item he answers goes to the Super bot while he is away,
 * head or not (owner 2026-11-09: a question behind another reached Telegram only on his next
 * message), and an item Telegram took that is now closed is told to the bot, so its copy says it
 * was answered. Called from every record write (`afterSuperWrite`); `vaultOf` is read only past
 * the cheap guards.
 */
export function announceOwnerHead(vaultOf: () => string, state: Pick<SuperState, 'enabled' | 'session' | 'queue'> & { children?: SuperState['children'] }, head: SuperQueueItem | null, memberTitle?: string): void {
  // A member's child doing main Super's work never asks the owner (plan-r10 1).
  if (head && memberTitle !== undefined) {
    const ch = state.children && Object.prototype.hasOwnProperty.call(state.children, head.sessionId) ? state.children[head.sessionId] : undefined;
    if (typeof ch?.workOrigin === 'string' && ch.workOrigin.startsWith('main:')) return;
  }
  let vault: string | null = null;
  const v = (): string => (vault ??= vaultOf());
  // A member's Super has no Telegram part here (its member bot has its own rule).
  if (memberTitle === undefined && tgItems.size) closeTelegramItems(v, state.queue);
  if (!state.enabled || !state.session) return;
  const session = state.session;
  if (announces(head) && !announced.has(head.id)) announceHead(v(), session, state, head, memberTitle);
  if (memberTitle === undefined) offerOpenItems(v, session, state.queue);
}

function announceHead(vault: string, session: string, state: { children?: SuperState['children'] }, head: SuperQueueItem, memberTitle?: string): void {
  const via: OwnerChannel[] = [];
  let held = false;
  let looking: { vault: string | null; session: string | null } = { vault: null, session: null };
  try { looking = sinks.presence(); } catch { /* nobody known to be looking */ }
  // In this project's window: no banner over it (the attention rule). On screen only when that
  // window shows the Super Agent itself (its stage); another page of the project is not.
  const here = looking.vault === vault;
  if (here && looking.session === session) via.push('screen');
  if (Date.now() - notchPolledAt <= NOTCH_LIVE_MS) via.push('notch');
  // A child's own question names its job and opens ITS chat, one click (owner 2026-10-27).
  const direct = head.kind === 'question' && head.direct === true;
  const job = direct ? clip(state.children?.[head.sessionId]?.brief ?? '').slice(0, JOB_CHARS) : '';
  // A member's Super speaks under the member's own name (plan-r10 2.3): "Rota · acme-storefront".
  const title = memberTitle !== undefined ? `${clip(memberTitle).slice(0, JOB_CHARS) || 'A member'} · ${vault}`
    : head.kind === 'permission' ? `Permission needed · ${vault}`
    : head.kind === 'owner' ? `A job needs you · ${vault}`
      : direct ? `${job || 'A job'} asks · ${vault}` : `Super Agent asks · ${vault}`;
  const body = bodyOf(head);
  if (!here) {
    let link: string | null = null;
    try { link = buildAppLink({ kind: 'session', vault, claudeId: direct ? head.sessionId : session }); } catch { link = null; }
    try {
      const posted = sinks.banner(title, body, link);
      if (posted === 'held') held = true;
      else if (posted) via.push('banner');
    } catch { /* the other channels still stand */ }
  }
  try { if (sinks.push({ vault, sessionId: session, key: `super-ask:${head.id}`, title, body }) > 0) via.push('phone'); } catch { /* idem */ }
  // Telegram is composed in at read time (`ownerQuestionReach`), from its real outcome.
  remember(head.id, { shown: true, ahead: 0, via, reached: via.some((x) => x !== 'notch'), note: '', ...(held ? { held: true as const } : {}) });
}

// ─── Telegram: every open item, its real outcome, its close ──────────────────

/** Telegram's part per item: the sink took it (and how the send went), or why it did not. */
interface TgItem { vault: string; state: TelegramReach; why?: string; tries: number; nextAt?: number; settle?: Promise<void>; done?: () => void }
const tgItems = new Map<string, TgItem>();
/** A send Telegram refused is offered again by record writes at most this many times, each no
 *  sooner than its backoff; a proof that he is reachable (he turned away: his Telegram message,
 *  a hands-free start) re-offers it with a fresh budget (review r1: an outage burnt every try in
 *  seconds and nothing ever sent it again). */
export const TG_TRIES = 3;
/** The wait after a refusal: Telegram's `retry_after` when it gives one, else 15 s doubling. */
export const TG_BACKOFF_MS = 15_000;

function offerOpenItems(v: () => string, session: string, queue: readonly SuperQueueItem[], reachable = false): void {
  const now = Date.now();
  for (const q of queue) {
    // A child's permission has its own Telegram card (İzin ver / Reddet), never this one.
    if (!announces(q) || q.kind === 'permission') continue;
    const t = tgItems.get(q.id);
    if (t && (t.state === 'sent' || t.state === 'sending')) continue;
    if (t?.state === 'failed' && !reachable && (t.tries >= TG_TRIES || now < (t.nextAt ?? 0))) continue;
    let took: TelegramTake = false;
    try { took = sinks.telegram({ vault: v(), sessionId: session, item: q }); } catch { took = false; }
    if (took === true) {
      let done: () => void = () => {};
      const settle = new Promise<void>((r) => { done = r; });
      tgItems.delete(q.id);
      tgItems.set(q.id, { vault: v(), state: 'sending', tries: (reachable ? 0 : t?.tries ?? 0) + 1, settle, done });
    } else if (took === 'at_mac' || took === 'no_bot') {
      if (t?.state !== 'failed') tgItems.set(q.id, { vault: v(), state: took, tries: t?.tries ?? 0 });
    } else if (t && t.state !== 'failed') {
      tgItems.delete(q.id);
    }
  }
  while (tgItems.size > ANNOUNCED_CAP) tgItems.delete(tgItems.keys().next().value as string);
}

/**
 * The Telegram sender's report for an item it took: `ok` = a message of it landed; `why` =
 * Telegram refused it (said to the agent; offered again on a later write, at most
 * {@link TG_TRIES} sends in all); `skipped` = it closed before it went (nothing to tell).
 */
export function noteTelegramSend(id: string, outcome: { ok: true } | { ok: false; why: string; retryAfterS?: number } | { skipped: true }): void {
  const t = tgItems.get(id);
  if (!t) return;
  if ('skipped' in outcome) tgItems.delete(id);
  else if (outcome.ok) { t.state = 'sent'; delete t.why; delete t.nextAt; }
  else {
    t.state = 'failed';
    t.why = outcome.why;
    const wait = outcome.retryAfterS && outcome.retryAfterS > 0 ? outcome.retryAfterS * 1000 : TG_BACKOFF_MS * 2 ** Math.max(0, t.tries - 1);
    t.nextAt = Date.now() + wait;
  }
  t.done?.();
}

/** Waits (at most `ms`) for this item's Telegram send to land or fail, so the reply to
 *  `super ask` / `super queue ask` says what really happened, not what was queued. */
export async function settleOwnerReach(id: string, ms = 8000): Promise<void> {
  const settle = tgItems.get(id)?.settle;
  if (!settle) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([settle, new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
  if (timer) clearTimeout(timer);
}

/** Items Telegram carries that this vault's record no longer holds open: told to the bot, once. */
function closeTelegramItems(v: () => string, queue: readonly SuperQueueItem[]): void {
  for (const [id, t] of [...tgItems]) {
    if (t.vault !== v()) continue;
    const item = queue.find((q) => q.id === id);
    if (item && announces(item)) continue;
    tgItems.delete(id);
    if (t.state === 'sent' || t.state === 'sending') {
      try { sinks.telegramClosed({ vault: t.vault, id }); } catch { /* best-effort */ }
    }
  }
}

/** He turned away (a Telegram message, a hands-free start): every open item of this main Super
 *  that Telegram does not carry yet is offered now (the same path a record write takes). */
export function offerOwnerItemsToTelegram(vault: string, state: Pick<SuperState, 'enabled' | 'session' | 'queue'>): void {
  const v = (): string => vault;
  if (tgItems.size) closeTelegramItems(v, state.queue);
  if (state.enabled && state.session) offerOpenItems(v, state.session, state.queue, true);
}

const TG_WHY: Record<Exclude<TelegramReach, 'sent'>, string> = {
  sending: 'the message is still on its way (it may land in a moment; nothing confirmed it yet)',
  failed: 'Telegram refused the message; it is tried again after a short wait, and at once when he next writes from Telegram',
  at_mac: 'he is at the Mac, so Telegram gets nothing; it goes there the moment he writes from Telegram',
  no_bot: 'no Super Telegram bot is bound to this project',
};

/** The queue items whose banner the server posted, or held back for the open notch: the window's
 *  job bar posts none of its own for those, and posts its own for every other (a Mac without the
 *  notifier bundle). */
export function serverBannered(queue: readonly SuperQueueItem[]): string[] {
  return queue.filter((q) => { const a = announced.get(q.id); return !!a && (a.via.includes('banner') || a.held === true); }).map((q) => q.id);
}

/** At boot: the head already open is not news. */
export function seedOwnerHead(head: SuperQueueItem | null): void {
  if (announces(head) && !announced.has(head.id)) {
    remember(head.id, { shown: true, ahead: 0, via: [], reached: false, note: '', why: 'it was already open when the app started' });
  }
}

/** What reached the owner of `itemId` (after the write that put it on the queue): the head's
 *  channels, plus its Telegram copy as it stands NOW (a send that failed is not a reach). */
export function ownerQuestionReach(state: Pick<SuperState, 'queue'>, itemId: string): OwnerQuestionReach {
  const item = state.queue.find((q) => q.id === itemId);
  const known = announced.get(itemId);
  if (!item) return { shown: false, ahead: 0, via: [], reached: false, note: 'That item is no longer on the queue.', why: 'it is no longer on the queue' };
  const ahead = known ? 0 : aheadOf(state, item);
  const shown = !!known || ahead === 0;
  const via: OwnerChannel[] = [...(known?.via ?? [])];
  const t = tgItems.get(itemId);
  // Only a send that LANDED is a reach (review r1): one still on its way is said as such.
  if (t?.state === 'sent') via.push('telegram');
  const reached = via.some((x) => x !== 'notch');
  const tg = t && t.state !== 'sent' ? `Telegram: ${TG_WHY[t.state]}${t.why ? ` (${t.why})` : ''}` : null;
  let why: string | undefined;
  if (!reached) {
    why = [
      !shown ? `in his bar it waits behind ${ahead} item(s) he must answer first` : known?.why ?? 'he is not on your stage and no banner or phone push reached him',
      tg,
    ].filter(Boolean).join('; ');
  }
  return {
    shown, ahead, via, reached,
    note: noteFor(item, shown, ahead, via, reached, why),
    ...(known?.held ? { held: true as const } : {}),
    ...(why ? { why } : {}),
    ...(t ? { telegram: t.state } : {}),
  };
}

/** Test-only. */
export function _resetOwnerQuestions(): void {
  announced.clear();
  tgItems.clear();
  notchPolledAt = 0;
  sinks = NONE;
}
