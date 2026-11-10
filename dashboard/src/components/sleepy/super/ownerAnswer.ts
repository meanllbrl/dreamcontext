import { useCallback, useState, useSyncExternalStore } from 'react';
import { RequestError } from '../../../api/client';
import { useApi } from '../../../context/VaultContext';
import {
  GRANT_SIZES, type GrantOffer, type GrantSize, type OwnerAnswer, type OwnerAnswerRequest, type OwnerAnswerResult, type OwnerAnswerVia,
  type RefusalFact, type SuperQueueItem,
} from '../../../lib/superTypes';
import { askQuestionsOf } from './superQuestions';

/**
 * The ONE client for the owner's in-place answer (uye-bildirim K5, contracts-w5): every surface
 * that answers an item of his without the asking session's own socket (the bar, the Super chat's
 * member card, a member's own chat card, the profile's rule list goes through its own route)
 * posts here, and only here, so the owner key, the 403 fallback and first-answer-wins are decided
 * once. The server builds any grant from the STORED item; nothing here sends a command or a rule.
 */
export const OWNER_ANSWER_PATH = '/super/owner-answer';

/** What a row of his draws, read from the item alone (never from text a client wrote). */
export type OwnerRowKind = 'question' | 'permission' | 'refusal' | 'stalled' | 'routine' | 'open';

/** The refused or asked call the surface shows. `whole` false: stored cut, so no grant of any
 *  size may be offered for it (consent matches display, G2). */
export interface ShownCall { tool: string; input: string; whole: boolean }

export function ownerRowKind(item: SuperQueueItem): OwnerRowKind {
  if (item.kind === 'routine') return 'routine';
  const waitKind = item.wait?.kind;
  if (item.kind === 'member') {
    if (item.of === 'permission') return 'permission';
    if (item.of === 'ask' || item.of === 'question') return 'question';
    if (item.of === 'owner') {
      if (waitKind === 'refusal') return 'refusal';
      if (waitKind === 'stalled') return 'stalled';
      // An offer rides only a permission or a refusal (store.ts cleanGrantOffer), so an owner
      // mirror that carries one is a refusal even before the mirror carries its wait.
      if (item.offer) return 'refusal';
    }
    return 'open';
  }
  if (item.kind === 'owner') return waitKind === 'refusal' ? 'refusal' : waitKind === 'stalled' ? 'stalled' : 'open';
  if (item.kind === 'permission') return 'permission';
  if (item.kind === 'question' || item.kind === 'ask') return 'question';
  return 'open';
}

const isRefusal = (v: unknown): v is RefusalFact => !!v && typeof v === 'object'
  && typeof (v as RefusalFact).tool === 'string' && typeof (v as RefusalFact).input === 'string' && typeof (v as RefusalFact).whole === 'boolean';

/** The call this item asks about, as the server stored it (a refusal's fact, or a permission's
 *  `call`, both copied onto a member's mirror: contracts-w5b), or null when it carries none. */
export function callOf(item: SuperQueueItem): ShownCall | null {
  const r = item.wait?.refusal;
  if (isRefusal(r)) return { tool: r.tool, input: r.input, whole: r.whole };
  const c = item.call;
  if (c && typeof c.tool === 'string' && typeof c.input === 'string' && typeof c.whole === 'boolean') return { tool: c.tool, input: c.input, whole: c.whole };
  return null;
}

/**
 * Control and bidi characters drawn as visible escapes (`\u{202e}`), so a command never shows
 * the owner something other than what runs (a right-to-left override, an invisible joiner, a
 * carriage return that hides the start of a line). `multiline` keeps newlines and tabs (a block
 * of code); a one-line surface escapes those too.
 */
export function visibleText(s: string, multiline = false): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (ch) => {
    if (multiline && (ch === '\n' || ch === '\t')) return ch;
    if (ch === '\n') return '\\n';
    if (ch === '\t') return '\\t';
    return `\\u{${ch.codePointAt(0)!.toString(16)}}`;
  });
}

/** The owner already allowed this item (`allowed`, the size he picked) and it waits for its call
 *  to run, its chat being closed: no surface offers Allow again, only that line and Open. */
export function allowedWaiting(item: Pick<SuperQueueItem, 'allowed' | 'state'>): boolean {
  return !!item.allowed && item.state !== 'done';
}

/** The sizes a surface may draw for this item, and what to say about them. */
export interface GrantChoices {
  sizes: GrantSize[];
  onceOnlyReason?: string;
  notChecked?: string;
  rule?: string;
}

/** The record an item lives in, as the owner-answer route names it: a member's record carries
 *  its slug (`SuperState.member`), main's carries none. */
export const MAIN_RECORD = 'main';
export function recordOf(state: { member?: string } | null | undefined): string {
  return state?.member || MAIN_RECORD;
}

/** Whether an item is main's own crew's, which has no member to save a rule on. Decided by the
 *  RECORD it lives in, never by the item's kind alone: a plain `owner` item in a member's own
 *  record is that member's; in main's record only a `member` mirror stands for a member. */
export function mainCrewItem(record: string, item: Pick<SuperQueueItem, 'kind'>): boolean {
  return record === MAIN_RECORD && item.kind !== 'member';
}

/**
 * Exactly the sizes `offer.sizes` lists (no offer: Allow once only, an older record). Main's own
 * crew has no member, so a member size is never drawn on main's own item even if one arrived.
 * A call the surface could not show whole gets nothing: the owner never allows what he did not see.
 * `record`: the record the item lives in (`recordOf`), which decides whose crew it is.
 */
export function grantChoices(item: SuperQueueItem, call: ShownCall | null, record: string): GrantChoices {
  if (!call || !call.whole) return { sizes: [] };
  const offer: GrantOffer | undefined = item.offer;
  const listed = offer ? offer.sizes : ['once' as const];
  const mainCrew = mainCrewItem(record, item);
  const sizes = GRANT_SIZES.filter((s) => listed.includes(s) && !(s === 'member' && mainCrew));
  return {
    sizes,
    ...(offer?.onceOnlyReason && sizes.length === 1 && sizes[0] === 'once' ? { onceOnlyReason: offer.onceOnlyReason } : {}),
    ...(offer?.notChecked ? { notChecked: offer.notChecked } : {}),
    ...(offer?.rule ? { rule: offer.rule } : {}),
  };
}

/** The answer for an Allow of the given size, by what the row is. */
export function allowAnswer(kind: OwnerRowKind, size: GrantSize): OwnerAnswer {
  return kind === 'refusal' ? { kind: 'refusal', action: 'allow', size } : { kind: 'permission', behavior: 'allow', size };
}

/** His no: Deny on a permission, Not needed on a refusal or a stalled member. */
export function declineAnswer(kind: OwnerRowKind): OwnerAnswer {
  if (kind === 'permission') return { kind: 'permission', behavior: 'deny' };
  if (kind === 'refusal') return { kind: 'refusal', action: 'not_needed' };
  return { kind: 'dismiss' };
}

/** A question answered with one tap on the bar: exactly one single-choice question with options.
 *  Anything richer (several questions, several picks, previews) is answered on its card. */
export function oneChoiceQuestion(item: Pick<SuperQueueItem, 'ask'>): { question: string; options: string[] } | null {
  if (!item.ask) return null;
  const qs = askQuestionsOf(item.ask);
  if (qs.length !== 1 || qs[0].multiSelect || !qs[0].options.length || qs[0].options.length > 4) return null;
  if (qs[0].options.some((o) => o.preview)) return null;
  return { question: qs[0].question, options: qs[0].options.map((o) => o.label) };
}

/** One picked option per question, keyed by the question's own words (AskUserQuestion's shape). */
export function questionAnswer(question: string, label: string): OwnerAnswer {
  return { kind: 'question', answers: { [question]: label } };
}

/** The record an item is answered in: a mirror routes to its member's item on the server, so
 *  every item drawn from main's record is answered as main's. */
export function answerRequest(record: string, item: Pick<SuperQueueItem, 'id'>, answer: OwnerAnswer, via: OwnerAnswerVia): OwnerAnswerRequest {
  return { record, item: item.id, answer, via };
}

export type SendResult =
  | { ok: true; outcome: Extract<OwnerAnswerResult, { ok: true }>['outcome'] }
  | { ok: false; error: string; message: string; openInstead: boolean };

/** Errors after which the only true thing to offer is Open: this window cannot decide it (no
 *  owner key: a plain browser, an older shell), the session's window is closed, or the server
 *  no longer offers that size. A second answer is told, never offered Open. */
const OPEN_INSTEAD = new Set(['owner_page_only', 'no_window', 'not_offered']);

type OwnerPoster = { ownerPost<T>(path: string, body: unknown): Promise<T> };

/** Post one answer with the owner key (`ownerPost`, the assistant's own answer path). Never throws. */
export async function sendOwnerAnswer(api: OwnerPoster, req: OwnerAnswerRequest): Promise<SendResult> {
  try {
    const r = await api.ownerPost<OwnerAnswerResult>(OWNER_ANSWER_PATH, req);
    if (r && r.ok === true) return { ok: true, outcome: r.outcome };
    const error = r && typeof r.error === 'string' ? r.error : 'invalid';
    return { ok: false, error, message: r?.message ?? '', openInstead: OPEN_INSTEAD.has(error) };
  } catch (e) {
    if (e instanceof RequestError) {
      const error = e.status === 403 ? 'owner_page_only' : e.status === 409 ? 'already_answered' : e.code || 'failed';
      return { ok: false, error, message: e.message, openInstead: OPEN_INSTEAD.has(error) };
    }
    return { ok: false, error: 'failed', message: e instanceof Error ? e.message : '', openInstead: false };
  }
}

// ─── First answer wins, across every surface of this window ─────────────────────────────────

/** Items this window already sent an answer for: the bar and the Super chat's card draw the same
 *  item, and a double click lands before React re-renders. Read synchronously, bounded. */
const sent = new Set<string>();
const sentListeners = new Set<() => void>();
let sentVersion = 0;
const SENT_CAP = 200;

/** Claim the item; false when an answer is already on its way or landed. */
export function claimOwnerItem(id: string): boolean {
  if (sent.has(id)) return false;
  sent.add(id);
  if (sent.size > SENT_CAP) sent.delete(sent.values().next().value as string);
  bump();
  return true;
}

/** An answer that did not land: the item can be answered again. */
export function releaseOwnerItem(id: string): void {
  if (sent.delete(id)) bump();
}

export function ownerItemClaimed(id: string): boolean {
  return sent.has(id);
}

function bump(): void {
  sentVersion += 1;
  for (const fn of [...sentListeners]) fn();
}

/** Tests only. */
export function _resetOwnerItems(): void {
  sent.clear();
  bump();
}

/** What an answer did, for the surface that sent it. `fallback`: draw Open instead of answers. */
export interface OwnerAnswerState {
  busy: boolean;
  fallback: boolean;
  /** An i18n key for the line under the row: answered elsewhere, failed, allowed but waiting. */
  note: string | null;
}

/** What a surface shows after one answer: a 403 (no owner key), a closed window or a size no
 *  longer offered falls back to Open; a second answer is told; anything else may be tried again. */
export function answerStateAfter(r: SendResult): OwnerAnswerState {
  if (r.ok) return { busy: false, fallback: false, note: r.outcome === 'allowed_waiting' ? 'owner.answer.allowedWaiting' : null };
  return {
    busy: false,
    fallback: r.openInstead,
    note: r.error === 'already_answered' ? 'owner.answer.answered' : r.openInstead ? 'owner.answer.openInstead' : 'owner.answer.failed',
  };
}

/** Send answers for one item from one surface, latched, with the fallback the outcome calls for. */
export function useOwnerAnswer(record: string, item: SuperQueueItem, via: OwnerAnswerVia): OwnerAnswerState & { submit: (answer: OwnerAnswer) => void } {
  const api = useApi();
  useSyncExternalStore(subscribeSent, readSentVersion, readSentVersion);
  const [state, setState] = useState<OwnerAnswerState>({ busy: false, fallback: false, note: null });
  const submit = useCallback((answer: OwnerAnswer) => {
    if (!claimOwnerItem(item.id)) return;
    setState({ busy: true, fallback: false, note: null });
    void sendOwnerAnswer(api, answerRequest(record, item, answer, via)).then((r) => {
      // Answered elsewhere stays claimed: nothing here may answer it again.
      if (!r.ok && r.error !== 'already_answered') releaseOwnerItem(item.id);
      setState(answerStateAfter(r));
    });
  }, [api, item, record, via]);
  return { ...state, busy: state.busy || (ownerItemClaimed(item.id) && !state.note && !state.fallback), submit };
}

function subscribeSent(fn: () => void): () => void {
  sentListeners.add(fn);
  return () => { sentListeners.delete(fn); };
}
const readSentVersion = () => sentVersion;

// ─── Grant items of a session (its own chat's cards) ───────────────────────────────────────

/** A session's open permission and refusal items with the record they are answered in, so the
 *  session's own chat card can offer the sizes the server computed. Published by the surface that
 *  holds the record; absent = the card offers what it always did. */
export interface SessionGrantItems { record: string; memberTitle?: string; items: readonly SuperQueueItem[] }
const sessionItems = new Map<string, SessionGrantItems>();
const sessionKeys = new Map<string, string>();
const sessionListeners = new Set<() => void>();

export function publishSessionGrantItems(sessionId: string, view: SessionGrantItems | null): void {
  const key = view ? `${view.record}\u0001${view.memberTitle ?? ''}\u0001${view.items.map((q) => `${q.id}:${q.state}:${q.requestId ?? ''}:${JSON.stringify(q.offer ?? null)}`).join(',')}` : '';
  if (!view) { if (!sessionItems.delete(sessionId)) return; sessionKeys.delete(sessionId); }
  else {
    if (sessionKeys.get(sessionId) === key) return;
    sessionItems.set(sessionId, view);
    sessionKeys.set(sessionId, key);
  }
  for (const fn of [...sessionListeners]) fn();
}

function subscribeSession(fn: () => void): () => void {
  sessionListeners.add(fn);
  return () => { sessionListeners.delete(fn); };
}

export function useSessionGrantItems(sessionId: string | null): SessionGrantItems | null {
  const read = () => (sessionId ? sessionItems.get(sessionId) ?? null : null);
  return useSyncExternalStore(subscribeSession, read, read);
}

/** The open permission item of a request, from a session's published items. */
export function permissionItemOf(view: SessionGrantItems | null, requestId: string): SuperQueueItem | null {
  return view?.items.find((q) => q.state !== 'done' && q.requestId === requestId && ownerRowKind(q) === 'permission') ?? null;
}

/** The open refusal items of a session, oldest first. */
export function refusalItemsOf(view: SessionGrantItems | null): SuperQueueItem[] {
  return (view?.items ?? []).filter((q) => q.state !== 'done' && ownerRowKind(q) === 'refusal').sort((a, b) => a.createdAt - b.createdAt);
}
