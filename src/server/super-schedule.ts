/**
 * Delivers the Super automations' fires (super-rutin plan Decisions 8-10, C3).
 *
 * The automations tick runs a due Super automation through the runner, which writes one queue
 * item (src/lib/super/schedule-queue.ts) and spawns nothing. This module reads those items at
 * server boot and every minute, and hands each one to the project's Super session through one of
 * two existing doors:
 *  - Telegram (`reply: telegram`, or `auto` while the owner is away): `hub.injectText` with kind
 *    `schedule`, so the answer lands on Telegram and his reply continues the same chat;
 *  - the Mac (everything else, and whatever cannot go to Telegram now): a `schedule` item in the
 *    Super inbox, which waits for an idle Super like every event.
 *
 * An item is trusted only when its fire is the one the tick recorded (`cache.lastFireAt`), and
 * the job is read from the manifest only while it is an approved Super automation. Nothing is
 * skipped silently: a fire past catch-up and a Super that is off are each told once (told-ledger).
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { listVaults } from '../lib/vaults.js';
import {
  approveMadeHere, createAutomation, getAutomation, listAutomations, readAutomationCache, removeAutomation, updateAutomation,
  type UpdateAutomationInput,
} from '../lib/automations/store.js';
import { checkApproval, registerProject } from '../lib/automations/registry.js';
import { formatLocalFire, formatSchedule, nextFire, parseSlot } from '../lib/automations/schedule.js';
import { AUTOMATION_REPLIES, effectiveReply, type AutomationManifest, type AutomationReply, type Weekday } from '../lib/automations/types.js';
import { defaultNotify } from '../lib/automations/runner.js';
import { appLinkForContextRoot } from '../lib/app-link.js';
import { scopeOfContextRoot } from '../lib/telegram/config.js';
import { readSuperState } from '../lib/super/store.js';
import { countEvent, deliveryBlocker, newQueueId, pumpSuper, superVaultName, writeSuper } from '../lib/super/inbox.js';
import { isRotating } from '../lib/super/fresh-session.js';
import {
  claimScheduleFire, listScheduleItems, markTold, releaseScheduleFire, removeScheduleItem, toldKey, type ScheduleItem, type ToldWhat,
} from '../lib/super/schedule-queue.js';
import { fireClock, scheduleJob, scheduleTurnText } from '../lib/super/schedule-job.js';
import { openInBackground, telegramHub, type TelegramHub } from './telegram/hub.js';
import { addPadNote } from './routes/super.js';

export const SCHEDULE_SWEEP_MS = 60_000;

/** The owner-facing lines (Turkish, plain; no implementation detail). */
export const SCHEDULE_LINES = {
  missed: (at: string) => `⏰ ${at} işi kaçtı: Mac ya da uygulama kapalıydı.`,
  off: (at: string) => `⏰ ${at} işi bekliyor: bu projede Super kapalı. Super'i açınca yapılır.`,
  noBot: (at: string) => `⏰ ${at} işi Telegram'a gitmedi: Super botu bağlı değil. Mac'te yapılıyor.`,
} as const;

export interface ScheduleDeps {
  home?: string;
  now?: () => number;
  /** The live hub (tests inject one); null = no Telegram on this server. */
  hub?: () => Pick<TelegramHub, 'superBindingOfVault' | 'ownerAway' | 'injectText' | 'syntheticUpdateId' | 'notice'> | null;
  /** A macOS banner (tests inject one). */
  banner?: (title: string, body: string) => void;
  /** Opens the Super window in the background (tests inject one). */
  open?: (url: string) => void;
  log?: (line: string) => void;
  /** The Super's on/off and session (tests inject one). */
  superState?: (contextRoot: string) => Promise<{ enabled: boolean; session: string | null }>;
  /** Puts the `schedule` item into the Super inbox and pumps it (tests inject one). */
  enqueue?: (contextRoot: string, slug: string, fireIso: string) => Promise<boolean>;
}

/** Tells the owner one line about a Super automation: through the Super bot when bound, else a
 *  banner plus an agenda line. Once per (slug, fire, what). */
export async function tellScheduleOwner(contextRoot: string, item: Pick<ScheduleItem, 'slug' | 'fireIso'>, what: ToldWhat, line: string, deps: ScheduleDeps = {}): Promise<boolean> {
  const home = deps.home ?? homedir();
  const scope = scopeOfContextRoot(contextRoot);
  if (!markTold(scope, toldKey(item.slug, item.fireIso, what), (deps.now ?? Date.now)(), home)) return false;
  await sayToOwner(contextRoot, line, deps);
  return true;
}

/** One plain line to the owner, wherever he reads it (no ledger: the verb's echo uses it too). */
export async function sayToOwner(contextRoot: string, line: string, deps: ScheduleDeps = {}): Promise<void> {
  const hub = (deps.hub ?? telegramHub)();
  const ab = hub?.superBindingOfVault(superVaultName(contextRoot)) ?? null;
  if (hub && ab && !ab.disabled) {
    await hub.notice(ab, 'info', line, true);
    return;
  }
  (deps.banner ?? ((t, b) => defaultNotify(t, b, deps.home)))('Super', line);
  try { await addPadNote(contextRoot, 'waiting', line); } catch { /* the banner went */ }
}

/** One pass over every registered project's items. */
export async function sweepSuperSchedule(deps: ScheduleDeps = {}): Promise<void> {
  const roots = listVaults(deps.home).map((v) => join(v.path, '_dream_context'));
  for (const root of roots) {
    try { await sweepProject(root, deps); } catch (err) { deps.log?.(`[super-schedule] ${root}: ${(err as Error).message}`); }
  }
}

/** One project's items, oldest fire first. Exported for tests. */
export async function sweepProject(contextRoot: string, deps: ScheduleDeps = {}): Promise<void> {
  const home = deps.home ?? homedir();
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? (() => {});
  const scope = scopeOfContextRoot(contextRoot);
  for (const item of listScheduleItems(scope, home)) {
    const at = fireClock(item.fireIso);
    const job = scheduleJob(contextRoot, item.slug, home);
    if (!job.ok) {
      log(`[super-schedule] ${item.slug}@${item.fireIso} dropped: ${job.reason}`);
      removeScheduleItem(scope, item, home);
      continue;
    }
    if (item.missed) {
      await tellScheduleOwner(contextRoot, item, 'missed', SCHEDULE_LINES.missed(at), deps);
      removeScheduleItem(scope, item, home);
      continue;
    }
    // Only the fire the tick recorded: a forged or replayed file fires nothing. An older fire a
    // newer one replaced before it went is told as missed.
    const last = readAutomationCache(contextRoot, item.slug)?.lastFireAt ?? null;
    const late = now - Date.parse(item.fireIso) > job.manifest.catchupHours * 3_600_000;
    if (last !== item.fireIso) {
      // The runner writes the item a moment before it records the fire: an item ahead of the
      // watermark waits for it (until its catch-up ends), never dropped in that gap.
      if ((last === null || last < item.fireIso) && !late) continue;
      if (last !== null && last > item.fireIso) await tellScheduleOwner(contextRoot, item, 'missed', SCHEDULE_LINES.missed(at), deps);
      else log(`[super-schedule] ${item.slug}@${item.fireIso} refused: not the recorded fire`);
      removeScheduleItem(scope, item, home);
      continue;
    }
    if (late) {
      await tellScheduleOwner(contextRoot, item, 'missed', SCHEDULE_LINES.missed(at), deps);
      removeScheduleItem(scope, item, home);
      continue;
    }
    const state = deps.superState ? await deps.superState(contextRoot) : await readSuperState(contextRoot);
    if (!state.enabled || !state.session) {
      // It waits for the Super; the next sweep after he turns it on delivers it.
      await tellScheduleOwner(contextRoot, item, 'off', SCHEDULE_LINES.off(at), deps);
      continue;
    }
    // Each fire is handed over at most once, whatever file shows up again (a replay, an
    // overlapping sweep): claimed in the ledger, synchronously, before the hand-over.
    if (!claimScheduleFire(scope, item.slug, item.fireIso, now, home)) {
      log(`[super-schedule] ${item.slug}@${item.fireIso} refused: already handed over`);
      removeScheduleItem(scope, item, home);
      continue;
    }
    await deliver(contextRoot, scope, item, effectiveReply(job.manifest), job.job, state.session, deps);
  }
}

async function deliver(contextRoot: string, scope: string, item: ScheduleItem, reply: string, job: string, session: string, deps: ScheduleDeps): Promise<void> {
  const home = deps.home ?? homedir();
  const hub = (deps.hub ?? telegramHub)();
  const ab = hub?.superBindingOfVault(superVaultName(contextRoot)) ?? null;
  const bound = !!(hub && ab && !ab.disabled);
  const wantsTelegram = reply === 'telegram' || (reply === 'auto' && bound && hub!.ownerAway());
  if (reply === 'telegram' && !bound) await tellScheduleOwner(contextRoot, item, 'no-bot', SCHEDULE_LINES.noBot(fireClock(item.fireIso)), deps);
  // A rotating Super (between /clear and its first turn) takes nothing on the owner path: the
  // inbox holds it until the fresh session has read its handoff.
  if (wantsTelegram && bound && !isRotating(session)) {
    const ref = await hub!.injectText(ab!, hub!.syntheticUpdateId(), scheduleTurnText(item.slug, item.fireIso, job), session, { kind: 'schedule' });
    if (ref) { removeScheduleItem(scope, item, home); return; }
  }
  const queued = await (deps.enqueue ?? ((root, slug, fireIso) => enqueueSchedule(root, slug, fireIso, session, deps)))(contextRoot, item.slug, item.fireIso);
  // The Super went off between the check and the queue: the item stays and waits for it.
  if (!queued) { releaseScheduleFire(scope, item.slug, item.fireIso, home); return; }
  removeScheduleItem(scope, item, home);
}

/** The Mac door: a `schedule` item in the Super inbox, delivered when the Super is idle. */
async function enqueueSchedule(contextRoot: string, slug: string, fireIso: string, session: string, deps: ScheduleDeps): Promise<boolean> {
  let queued = false;
  await writeSuper(contextRoot, (s) => {
    if (!s.enabled || !s.session) return;
    queued = true;
    s.queue.push({ id: newQueueId(), sessionId: s.session, kind: 'schedule', state: 'pending', createdAt: (deps.now ?? Date.now)(), automation: slug, fire: fireIso });
    countEvent(s);
  });
  if (!queued) return false;
  // The Super window is closed: opened in the background, so the turn does not wait for him.
  const blocker = deliveryBlocker(contextRoot);
  if (blocker === 'no_socket' || blocker === 'no_chat') {
    const link = appLinkForContextRoot(contextRoot, { kind: 'session', claudeId: session }, deps.home);
    if (link) try { (deps.open ?? openInBackground)(link); } catch { /* it waits for the window */ }
  }
  void pumpSuper(contextRoot);
  return true;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Boot sweep, then one every minute. Desktop server only. */
export function startSuperSchedule(deps: ScheduleDeps = {}): () => void {
  // One sweep at a time: a slow one (a Telegram hand-over waits up to 45 s) is never overlapped.
  let sweeping = false;
  const run = () => {
    if (sweeping) return;
    sweeping = true;
    void sweepSuperSchedule(deps)
      .catch((err) => deps.log?.(`[super-schedule] ${(err as Error).message}`))
      .finally(() => { sweeping = false; });
  };
  run();
  if (timer) clearInterval(timer);
  timer = setInterval(run, SCHEDULE_SWEEP_MS);
  timer.unref?.();
  return () => { if (timer) clearInterval(timer); timer = null; };
}

// ─── The verb: `dreamcontext super schedule add|list|change|cancel` (C4) ─────────────────────

/** Every schedule the verb makes is named with this prefix; the verb touches no other automation. */
export const SCHEDULE_SLUG_PREFIX = 'super-is-';
/** Leaves room for the echo's own words inside one Telegram message (4096). */
const MAX_JOB = 3500;
const TR_DAYS: Record<Weekday, string> = { mon: 'Pzt', tue: 'Sal', wed: 'Çar', thu: 'Per', fri: 'Cum', sat: 'Cmt', sun: 'Paz' };
const TR_REPLY: Record<AutomationReply, string> = { auto: 'neredeysem', telegram: 'Telegram', mac: 'Mac' };

export type ScheduleVerbResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; status: number; error: string; message: string };

const bad = (error: string, message: string, status = 400): ScheduleVerbResult => ({ ok: false, status, error, message });

/** "her gün 09:00" / "Pzt, Çar 09:00", from the first weekly slot. */
export function scheduleWhen(m: Pick<AutomationManifest, 'schedule'>): string {
  const slot = m.schedule?.slots?.[0];
  if (!slot || slot.kind !== 'weekly') return m.schedule ? formatSchedule(m.schedule) : 'zamanı yok';
  const days = slot.days === 'daily' ? 'her gün' : slot.days.map((d) => TR_DAYS[d]).join(', ');
  return `${days} ${slot.at}`;
}

function replyOf(m: Pick<AutomationManifest, 'target' | 'reply'>): AutomationReply {
  return effectiveReply(m);
}

/** The verbatim confirmation the owner gets on every add and change (Decision 4). */
export function scheduleEcho(verb: 'Kuruldu' | 'Değişti', m: AutomationManifest): string {
  return `⏰ ${verb}: ${scheduleWhen(m)} · cevap: ${TR_REPLY[replyOf(m)]}${m.target === 'super' ? '' : ' · Super kapalıyken de çalışır'} · «${m.prompt}»`;
}

function parseDays(v: unknown): 'daily' | Weekday[] | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const r = parseSlot({ days: v.trim(), at: '00:00' });
  return 'error' in r || r.slot.kind !== 'weekly' ? null : r.slot.days;
}

function parseReply(v: unknown): AutomationReply | null | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'string' && (AUTOMATION_REPLIES as readonly string[]).includes(v) ? v as AutomationReply : null;
}

function ours(root: string, id: unknown): AutomationManifest | null {
  if (typeof id !== 'string' || !id.startsWith(SCHEDULE_SLUG_PREFIX)) return null;
  const m = getAutomation(root, id);
  return m && m.path.endsWith(`${id}.md`) ? m : null;
}

function row(root: string, m: AutomationManifest, now: Date): Record<string, unknown> {
  const cache = readAutomationCache(root, m.slug);
  const next = m.schedule && m.enabled ? nextFire(m.schedule, now) : null;
  return {
    id: m.slug, when: scheduleWhen(m), reply: replyOf(m), kind: m.target === 'super' ? 'super' : 'headless',
    enabled: m.enabled, job: m.prompt, next: next ? formatLocalFire(next) : null,
    last: cache?.history?.[0] ? { at: cache.history[0].firedAt, status: cache.history[0].status } : null,
  };
}

/** The verb's body, for the main Super only (the route checks that before calling). */
export async function scheduleVerb(contextRoot: string, b: Record<string, unknown>, deps: ScheduleDeps & { nowDate?: () => Date } = {}): Promise<ScheduleVerbResult> {
  const op = b.op;
  const now = (deps.nowDate ?? (() => new Date()))();
  const projectRoot = dirname(contextRoot);
  if (op === 'list') {
    const rows = listAutomations(contextRoot).filter((m) => m.slug.startsWith(SCHEDULE_SLUG_PREFIX)).map((m) => row(contextRoot, m, now));
    return { ok: true, result: { schedules: rows } };
  }
  if (op === 'add') {
    const job = typeof b.job === 'string' ? b.job.trim() : '';
    if (!job || job.length > MAX_JOB) return bad('invalid_args', `--job is the owner's job in his words (1-${MAX_JOB} characters)`);
    const days = parseDays(b.days ?? 'daily');
    if (!days) return bad('invalid_args', '--days is "daily", a comma list of mon,tue,… or a range like mon-fri');
    const at = typeof b.at === 'string' ? b.at.trim() : '';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return bad('invalid_args', '--at is HH:MM (24 h, local time)');
    const headless = b.headless === true;
    const reply = parseReply(b.reply);
    if (reply === null) return bad('invalid_args', `--reply is one of ${AUTOMATION_REPLIES.join(' | ')}`);
    if (headless && reply === 'auto') return bad('invalid_args', 'a --headless job has no Super to follow him: --reply telegram or mac');
    const slug = `${SCHEDULE_SLUG_PREFIX}${at.replace(':', '')}-${randomBytes(3).toString('hex')}`;
    let m: AutomationManifest;
    try {
      registerProject(projectRoot, deps.home);
      m = createAutomation(contextRoot, {
        slug, title: job.length > 60 ? `${job.slice(0, 59)}…` : job, mode: 'sched', days, at, prompt: job,
        enabled: true, shared: false, notify: true,
        ...(headless ? (reply === 'telegram' ? { reply: 'telegram' as const } : {}) : { target: 'super' as const, reply: reply ?? 'auto' }),
      });
    } catch (err) {
      return bad('not_created', (err as Error).message, 409);
    }
    try {
      // His own Super set it on his own message: approved here with that consent (C2), no card.
      approveMadeHere(contextRoot, m, now, deps.home, 'super-verb');
    } catch (err) {
      // Never left behind unapproved: the owner asked for a schedule, not a card.
      try { removeAutomation(contextRoot, m.slug); } catch { /* the card shows it */ }
      return bad('not_created', (err as Error).message, 409);
    }
    await sayToOwner(contextRoot, scheduleEcho('Kuruldu', m), deps);
    return { ok: true, result: { ...row(contextRoot, m, now), echoed: true } };
  }
  if (op === 'change') {
    const m = ours(contextRoot, b.id);
    if (!m) return bad('unknown_schedule', 'no such schedule (`dreamcontext super schedule list`)', 404);
    // Only from an approved state: an edit made elsewhere is approved on his page, never here (Decision 5).
    if (!checkApproval(projectRoot, m, deps.home, 'run').approved) {
      return bad('changed_elsewhere', 'this schedule was changed outside the Super (or waits for approval): the owner approves that change on the AI Team page first', 409);
    }
    const patch: UpdateAutomationInput = {};
    if (b.job !== undefined) {
      const job = typeof b.job === 'string' ? b.job.trim() : '';
      if (!job || job.length > MAX_JOB) return bad('invalid_args', `--job is 1-${MAX_JOB} characters`);
      patch.prompt = job;
    }
    if (b.days !== undefined) { const d = parseDays(b.days); if (!d) return bad('invalid_args', '--days is "daily", mon,tue,… or mon-fri'); patch.days = d; }
    if (b.at !== undefined) {
      const at = typeof b.at === 'string' ? b.at.trim() : '';
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return bad('invalid_args', '--at is HH:MM');
      patch.at = at;
    }
    if (b.reply !== undefined) {
      const r = parseReply(b.reply);
      if (!r) return bad('invalid_args', `--reply is one of ${AUTOMATION_REPLIES.join(' | ')}`);
      if (m.target !== 'super' && r === 'auto') return bad('invalid_args', 'a headless job takes --reply telegram or mac');
      patch.reply = r;
    }
    if (!Object.keys(patch).length) return bad('invalid_args', 'say what changes: --job, --days, --at or --reply');
    let after: AutomationManifest;
    try {
      after = updateAutomation(contextRoot, m.slug, patch);
      approveMadeHere(contextRoot, after, now, deps.home, 'super-verb');
    } catch (err) {
      return bad('not_changed', (err as Error).message, 409);
    }
    await sayToOwner(contextRoot, scheduleEcho('Değişti', after), deps);
    return { ok: true, result: { ...row(contextRoot, after, now), echoed: true } };
  }
  if (op === 'cancel') {
    const m = ours(contextRoot, b.id);
    if (!m) return bad('unknown_schedule', 'no such schedule (`dreamcontext super schedule list`)', 404);
    try { removeAutomation(contextRoot, m.slug); } catch (err) { return bad('not_cancelled', (err as Error).message, 409); }
    return { ok: true, result: { cancelled: m.slug } };
  }
  return bad('invalid_args', 'op is add | list | change | cancel');
}
