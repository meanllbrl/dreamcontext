/**
 * The Telegram half of a run's rating request (plan uye-karnesi W3 C12): his star tap, his "Not
 * ekle" reply (typed or a voice note), the replay of a note the app stopped on, the hourly closing
 * sweep, and the redraw when he rates on the Mac.
 *
 * Every update reaching here passed `isAuthorized` for its binding, so a tap and a prompt reply are
 * his (E5): stored `by: 'owner'`, `via: 'telegram'`. A request is found by its `askId` on the card,
 * never in button memory, so a tap after a restart lands. Nothing here calls a model: a note starts
 * its lesson draft through the same detached spawn as the Mac (D13).
 */
import { dirname, join } from 'node:path';
import { listVaults } from '../../lib/vaults.js';
import { projectKey } from '../../lib/local-store.js';
import { getAgent } from '../../lib/agents/store.js';
import {
  NO_WRITE, RATE_ASK_TTL_MS, ScorecardRefused, globalMemberSlugs, projectKeyOfRun, readAllCards, scopeFor, sessionKeyOf, withScorecardAt,
  type MemberCard, type ScorecardScope, type TgAsk,
} from '../../lib/agents/scorecard.js';
import { rateRun } from '../../lib/agents/scorecard-ops.js';
import { spawnScorecardJob, type SpawnScorecardFn } from '../../lib/agents/scorecard-judge.js';
import { RATE_CALLBACK_RE, rateKeyboard, type JournalEntry } from '../../lib/telegram/contract.js';
import { escapeHtml } from '../../lib/telegram/format.js';
import { TelegramError } from '../../lib/telegram/transport.js';
import type { ActiveBinding, TelegramHub } from './hub.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);

export const RATE_LINES = {
  saved: (n: number) => `${n}★ kaydedildi`,
  expired: 'Bu işin puanlama süresi doldu.',
  gone: 'Bu iş artık yok.',
  damaged: "Karne dosyası bozuk; Mac'te karttan bak.",
  failed: 'Kaydedilemedi; biraz sonra yeniden dokun.',
  prompt: (member: string) => `Notunu söyle ya da yaz; ${member} bundan öğrenir.`,
  noteSaved: (note: string) => `Not kaydedildi: «${note}»`,
  notHeard: 'Notunu yazıya çeviremedim; yeniden söyle ya da yaz.',
  starsFirst: 'Önce yıldız ver, sonra notu kaydederim.',
  noteDamaged: "Not kaydedilemedi: Mac'teki karne dosyası bozuk; Mac'te karttan bak.",
} as const;

/** The sweep's cadence and how many transient failures close a request's keyboard anyway. */
export const SWEEP_EVERY_MS = 3_600_000;
export const SWEEP_MAX_TRIES = 3;

/** One request as the hub finds it. `projectRoot` null: a global member's run of a project this
 *  Mac no longer has registered (judged by its `endedAt` alone, never written). */
export interface FoundAsk {
  ask: TgAsk;
  runKey: string;
  member: string;
  scope: ScorecardScope;
  card: MemberCard;
  projectRoot: string | null;
}

interface Hooks {
  spawn: SpawnScorecardFn;
}
let hooks: Hooks = { spawn: spawnScorecardJob };
let live: TelegramHub | null = null;

/** Tests swap the detached spawn. */
export function setRateSpawnForTests(fn: SpawnScorecardFn | null): void {
  hooks = { spawn: fn ?? spawnScorecardJob };
}

/** The project root a global run key's `<projectKey>/` prefix names, through the vault registry. */
function projectOfKey(runKey: string, home: string): string | null {
  const pk = projectKeyOfRun(runKey);
  if (!pk) return null;
  try {
    for (const v of listVaults(home)) if (projectKey(v.path) === pk) return v.path;
  } catch { /* none */ }
  return null;
}

/** Every card a binding's requests can sit in: its project's file and every global member's card
 *  (their run keys of this project); a global member's own bot, its own card. */
function cardsOf(hub: TelegramHub, ab: ActiveBinding): Array<{ scope: ScorecardScope; members: Record<string, MemberCard>; damaged: string | null; projectRoot: string | null }> {
  const out: Array<{ scope: ScorecardScope; members: Record<string, MemberCard>; damaged: string | null; projectRoot: string | null }> = [];
  const home = hub.home;
  if (ab.scope === 'global' && ab.target !== 'super') {
    const scope = scopeFor('/', ab.target, 'global', home);
    const r = readAllCards(scope);
    out.push({ scope, ...r, projectRoot: null });
    return out;
  }
  const root = ab.contextRoot;
  if (!root) return out;
  const projectRoot = dirname(root);
  const scope = scopeFor(projectRoot, 'x', 'project', home);
  out.push({ scope, ...readAllCards(scope), projectRoot });
  for (const g of globalMemberSlugs(home)) {
    const gs = scopeFor(projectRoot, g, 'global', home);
    out.push({ scope: gs, ...readAllCards(gs), projectRoot });
  }
  return out;
}

/** The request with this id for this binding, or what stands in the way. */
export function findAsk(hub: TelegramHub, ab: ActiveBinding, askId: string): FoundAsk | 'damaged' | null {
  let damaged = false;
  for (const f of cardsOf(hub, ab)) {
    if (f.damaged) { damaged = true; continue; }
    for (const [member, card] of Object.entries(f.members)) {
      for (const [runKey, ask] of Object.entries(card.telegramAsks)) {
        if (ask.askId !== askId) continue;
        // A project binding reads a global card's keys of its own project only.
        if (f.scope.kind === 'global' && f.projectRoot && !runKey.startsWith(`${projectKey(f.projectRoot)}/`)) continue;
        const projectRoot = f.scope.kind === 'global' ? projectOfKey(runKey, hub.home) : f.projectRoot;
        const scope = f.scope.kind === 'global' ? scopeFor(projectRoot ?? '/', member, 'global', hub.home) : scopeFor(f.projectRoot!, member, 'project', hub.home);
        return { ask, runKey, member, scope, card, projectRoot };
      }
    }
  }
  return damaged ? 'damaged' : null;
}

const ownBinding = (ab: ActiveBinding, ask: TgAsk): boolean => ask.botId === String(ab.binding.botId) && ask.chatId === String(ab.binding.chatId);
const windowOpen = (ask: Pick<TgAsk, 'endedAt'>, atMs: number): boolean => {
  const end = Date.parse(ask.endedAt);
  return Number.isFinite(end) && atMs < end + RATE_ASK_TTL_MS;
};

/** The member's name as the bot says it. */
function memberName(projectRoot: string | null, member: string, home: string): string {
  if (!projectRoot) return member;
  try { return getAgent(join(projectRoot, '_dream_context'), member, home)?.title || member; } catch { return member; }
}

// ─── The prompt-reply index (memory; only the hub appends prompt ids) ─────────────

/** `${binding key}:${message id}` → its request's askId. */
const promptIndex = new Map<string, string>();

function indexPrompts(hub: TelegramHub, ab: ActiveBinding): void {
  for (const f of cardsOf(hub, ab)) {
    for (const card of Object.values(f.members)) {
      for (const ask of Object.values(card.telegramAsks)) {
        if (!ownBinding(ab, ask)) continue;
        for (const id of ask.notePromptIds) promptIndex.set(`${ab.key}:${id}`, ask.askId);
      }
    }
  }
}

/** Write one change to a request (and its rating stays where it is). */
function editAsk(found: FoundAsk, fn: (ask: TgAsk) => void): void {
  try {
    withScorecardAt(found.scope, (card) => {
      const ask = card.telegramAsks[found.runKey];
      if (!ask || ask.askId !== found.ask.askId) return NO_WRITE;
      fn(ask);
      return true;
    });
  } catch { /* the request stays as it was */ }
}

async function removeKeyboard(ab: ActiveBinding, messageId: number): Promise<void> {
  if (Number.isSafeInteger(messageId)) await ab.transport.editMessageReplyMarkup(ab.binding.chatId, messageId, null).catch(() => {});
}

/** "Not ekle": one force-reply prompt, its id kept on the request. */
async function sendPrompt(hub: TelegramHub, ab: ActiveBinding, found: FoundAsk, line: string): Promise<void> {
  const sent = await hub.send(ab, escapeHtml(line), { reply_markup: { force_reply: true, input_field_placeholder: 'Notun' } }).catch(() => null);
  const mid = Number(sent?.message_id);
  if (!Number.isSafeInteger(mid)) return;
  promptIndex.set(`${ab.key}:${mid}`, found.ask.askId);
  editAsk(found, (ask) => { if (!ask.notePromptIds.includes(mid)) ask.notePromptIds.push(mid); });
}

// ─── The tap ─────────────────────────────────────────────────────────────────────

export async function onRateTap(hub: TelegramHub, ab: ActiveBinding, cb: Obj): Promise<void> {
  const id = typeof cb.id === 'string' ? cb.id : '';
  const m = RATE_CALLBACK_RE.exec(typeof cb.data === 'string' ? cb.data : '');
  const messageId = Number(obj(cb.message)?.message_id);
  const answer = (text?: string) => ab.transport.answerCallbackQuery(id, text).catch(() => {});
  if (!m) { await answer(RATE_LINES.gone); return; }
  const found = findAsk(hub, ab, m[1]);
  if (found === 'damaged') { await answer(RATE_LINES.damaged); return; }
  if (!found || !ownBinding(ab, found.ask)) { await answer(RATE_LINES.gone); if (!found) await removeKeyboard(ab, messageId); return; }
  // The window alone: a rated run's keyboard is past its window too.
  if (!windowOpen(found.ask, hub.now())) { await answer(RATE_LINES.expired); await removeKeyboard(ab, messageId); return; }
  if (!found.projectRoot) { await answer(RATE_LINES.gone); await removeKeyboard(ab, messageId); return; }
  if (m[2] === 'n') {
    if (!found.card.ratings[found.runKey]) { await answer(RATE_LINES.starsFirst); return; }
    await answer();
    await sendPrompt(hub, ab, found, RATE_LINES.prompt(memberName(found.projectRoot, found.member, hub.home)));
    return;
  }
  const stars = Number(m[2]);
  try {
    const r = rateRun(found.projectRoot, found.member, { run: sessionKeyOf(found.runKey), stars, by: 'owner', via: 'telegram', home: hub.home, now: new Date(hub.now()) });
    if (r.draft) hooks.spawn({ kind: 'draft', projectRoot: found.projectRoot, member: found.member, run: r.runKey, ...(r.slot ? { slot: r.slot } : {}) });
  } catch (err) {
    const code = err instanceof ScorecardRefused ? err.code : '';
    if (code === 'scorecard_unreadable') { await answer(RATE_LINES.damaged); return; }
    if (code === 'unknown_member' || code === 'unknown_run' || code === 'run_not_rateable') { await answer(RATE_LINES.gone); await removeKeyboard(ab, messageId); return; }
    await answer(RATE_LINES.failed);
    return;
  }
  await answer(RATE_LINES.saved(stars));
  // The tapped message is the one redrawn: a duplicate from a send retry works too.
  if (Number.isSafeInteger(messageId)) await ab.transport.editMessageReplyMarkup(ab.binding.chatId, messageId, rateKeyboard(found.ask.askId, stars)).catch(() => {});
}

// ─── His note (E7) ───────────────────────────────────────────────────────────────

/** A reply to one of the prompts: journaled before its update is confirmed, stored on the chain.
 *  True when it was one (it never reaches a Super). */
export async function onRateReply(hub: TelegramHub, ab: ActiveBinding, updateId: number, msg: Obj): Promise<boolean> {
  const to = Number(obj(msg.reply_to_message)?.message_id);
  if (!Number.isSafeInteger(to)) return false;
  const askId = promptIndex.get(`${ab.key}:${to}`);
  if (!askId) return false;
  const at = hub.now();
  hub.editJournal(ab, (p) => [...p, { updateId, kind: 'rate-note', written: false, at, msg, askId }]);
  ab.chain = ab.chain.then(() => storeNote(hub, ab, updateId, msg, askId, at)).catch(() => { /* one failed link never stops the next */ });
  return true;
}

/** A `rate-note` the app stopped on: stored now, the window judged at its arrival. */
export function replayRateNote(hub: TelegramHub, ab: ActiveBinding, e: JournalEntry): void {
  if (!e.askId || !e.msg) {
    hub.editJournal(ab, (p) => p.filter((x) => x.updateId !== e.updateId));
    void hub.notice(ab, 'warn', RATE_LINES.notHeard, true);
    return;
  }
  const askId = e.askId;
  ab.chain = ab.chain.then(() => storeNote(hub, ab, e.updateId, e.msg as Obj, askId, e.at)).catch(() => {});
}

async function storeNote(hub: TelegramHub, ab: ActiveBinding, updateId: number, msg: Obj, askId: string, arrivedAt: number): Promise<void> {
  const drop = () => hub.editJournal(ab, (p) => p.filter((x) => x.updateId !== updateId));
  const say = (line: string) => hub.send(ab, escapeHtml(line)).catch(() => {});
  const found = findAsk(hub, ab, askId);
  if (found === 'damaged') { drop(); await say(RATE_LINES.noteDamaged); return; }
  if (!found || !ownBinding(ab, found.ask) || !found.projectRoot) { drop(); await say(RATE_LINES.gone); return; }
  if (!windowOpen(found.ask, arrivedAt)) { drop(); await say(RATE_LINES.expired); return; }
  const rating = found.card.ratings[found.runKey];
  if (!rating) { drop(); await say(RATE_LINES.starsFirst); return; }
  let note = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!note) {
    const heard = await hub.hearVoice(ab, msg, join(found.projectRoot, '_dream_context'));
    if (!heard || !heard.ok) { drop(); await sendPrompt(hub, ab, found, RATE_LINES.notHeard); return; }
    note = heard.text;
  }
  if (!note) { drop(); await sendPrompt(hub, ab, found, RATE_LINES.notHeard); return; }
  try {
    const r = rateRun(found.projectRoot, found.member, { run: sessionKeyOf(found.runKey), stars: rating.stars, note, by: 'owner', via: 'telegram', home: hub.home, now: new Date(hub.now()) });
    if (r.draft) hooks.spawn({ kind: 'draft', projectRoot: found.projectRoot, member: found.member, run: r.runKey, ...(r.slot ? { slot: r.slot } : {}) });
    drop();
    await say(RATE_LINES.noteSaved(r.rating?.note ?? note));
  } catch (err) {
    drop();
    await say(err instanceof ScorecardRefused && err.code === 'scorecard_unreadable' ? RATE_LINES.noteDamaged : RATE_LINES.gone);
  }
}

// ─── The closing sweep ───────────────────────────────────────────────────────────

const permanent = (err: unknown): boolean => {
  if (!(err instanceof TelegramError)) return false;
  return err.code === 400 || err.code === 403;
};

/** Every past-window keyboard of this binding's requests removed; a rating stays. */
export async function sweepRateAsks(hub: TelegramHub, ab: ActiveBinding): Promise<void> {
  const now = hub.now();
  for (const f of cardsOf(hub, ab)) {
    if (f.damaged) continue;
    for (const [member, card] of Object.entries(f.members)) {
      for (const [runKey, ask] of Object.entries(card.telegramAsks)) {
        if (ask.closedAt || ask.messageId === undefined || !ownBinding(ab, ask) || windowOpen(ask, now)) continue;
        if (f.scope.kind === 'global' && f.projectRoot && !runKey.startsWith(`${projectKey(f.projectRoot)}/`)) continue;
        const scope = f.scope.kind === 'global' ? f.scope : scopeFor(f.projectRoot!, member, 'project', hub.home);
        const found: FoundAsk = { ask, runKey, member, scope, card, projectRoot: f.projectRoot };
        let closed = false;
        try {
          await ab.transport.editMessageReplyMarkup(ab.binding.chatId, ask.messageId, null);
          closed = true;
        } catch (err) {
          closed = permanent(err) || (ask.sweepTries ?? 0) + 1 >= SWEEP_MAX_TRIES;
          if (!closed) editAsk(found, (a) => { a.sweepTries = (a.sweepTries ?? 0) + 1; });
        }
        if (closed) editAsk(found, (a) => { a.closedAt = new Date(now).toISOString(); });
      }
    }
  }
}

async function sweepAll(hub: TelegramHub): Promise<void> {
  for (const ab of [...hub.active.values()]) {
    if (ab.disabled || ab.halted) continue;
    try { await sweepRateAsks(hub, ab); } catch { /* the next hour */ }
  }
}

// ─── The Mac's rating, drawn on the phone ─────────────────────────────────────────

/** He rated or cleared on the Mac: the run's Telegram stars follow while its request is open and
 *  the hub is live. Never throws, never waits. */
export function markRated(projectRoot: string, member: string, runKey: string, stars: number | null): void {
  const hub = live;
  if (!hub) return;
  void (async () => {
    try {
      const { resolveScorecard, readScorecardAt } = await import('../../lib/agents/scorecard.js');
      const { scope } = resolveScorecard(projectRoot, member, hub.home);
      const ask = readScorecardAt(scope).card.telegramAsks[runKey];
      if (!ask || ask.messageId === undefined || ask.closedAt || !windowOpen(ask, hub.now())) return;
      const ab = [...hub.active.values()].find((b) => !b.disabled && ownBinding(b, ask));
      if (!ab) return;
      await ab.transport.editMessageReplyMarkup(ab.binding.chatId, ask.messageId, rateKeyboard(ask.askId, stars)).catch(() => {});
    } catch { /* the route never fails for this */ }
  })();
}

// ─── Wiring ──────────────────────────────────────────────────────────────────────

/** Plug the rating branch into the hub: before every `a:` button and before any session lookup. */
export function wireRating(hub: TelegramHub): () => void {
  live = hub;
  hub.rateHook = {
    isRateTap: (data) => RATE_CALLBACK_RE.test(data),
    onTap: (ab, cb) => onRateTap(hub, ab, cb),
    onReply: (ab, updateId, msg) => onRateReply(hub, ab, updateId, msg),
    replay: (ab, e) => replayRateNote(hub, ab, e),
    // Each binding brought up (hub start, a new bind): its prompt ids indexed, its old keyboards swept.
    activated: (ab) => {
      try { indexPrompts(hub, ab); } catch { /* none */ }
      void sweepRateAsks(hub, ab).catch(() => {});
    },
  };
  for (const ab of hub.active.values()) hub.rateHook.activated(ab);
  const timer = setInterval(() => { void sweepAll(hub); }, SWEEP_EVERY_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    if (live === hub) live = null;
    hub.rateHook = null;
  };
}

/** Tests: forget the prompt index. */
export function resetRateIndexForTests(): void {
  promptIndex.clear();
}
