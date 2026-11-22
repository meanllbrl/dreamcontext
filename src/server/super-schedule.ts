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
  approveMadeHere, createAutomation, getAutomation, listAutomations, patchManifestFrontmatter, readAutomationCache, removeAutomation, updateAutomation,
  writeAutomationCache, type UpdateAutomationInput,
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
import { isConditionData } from '../lib/automations/condition.js';
import {
  ONCE_CATCHUP_HOURS, SCHEDULE_SLUG_PREFIX, onceSlot, readRunLimit, resolveOnceDate, runsLeft, type RunLimit,
} from '../lib/super/schedule-limit.js';
import { DEFAULT_CATCHUP_HOURS } from '../lib/automations/types.js';
import { openInBackground, telegramHub, type TelegramHub } from './telegram/hub.js';
import { addPadNote } from './routes/super.js';

export const SCHEDULE_SWEEP_MS = 60_000;

/** The owner-facing lines (Turkish, plain; no implementation detail). */
export const SCHEDULE_LINES = {
  missed: (at: string) => `⏰ ${at} işi kaçtı: Mac ya da uygulama kapalıydı.`,
  missedOnce: (at: string, job: string) => `⏰ ${at} için kurulan tek seferlik iş yapılmadı (Mac ya da uygulama kapalıydı) ve kapandı: «${job.length > 300 ? `${job.slice(0, 299)}…` : job}»`,
  off: (at: string) => `⏰ ${at} işi bekliyor: bu projede Super kapalı. Super'i açınca yapılır.`,
  noBot: (at: string) => `⏰ ${at} işi Telegram'a gitmedi: Super botu bağlı değil. Mac'te yapılıyor.`,
  failed: (at: string) => `⏰ ${at} işi Super'e iletilemedi. Bir sonraki saatinde yeniden denenecek.`,
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
  enqueue?: (contextRoot: string, slug: string, fireIso: string, data?: string) => Promise<boolean>;
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
    // A one-off that went by unrun (Super or headless) is told with its words, and lands on the
    // Super's agenda too, so its next turn knows it never happened (schedule-limit.ts).
    const once = item.missed && item.slug.startsWith(SCHEDULE_SLUG_PREFIX) ? getAutomation(contextRoot, item.slug, home) : null;
    if (once && readRunLimit(once).onceOn) {
      const line = SCHEDULE_LINES.missedOnce(at, once.prompt);
      // Told through the bot, the agenda line is added here; without one sayToOwner adds it.
      const hub = (deps.hub ?? telegramHub)();
      const ab = hub?.superBindingOfVault(superVaultName(contextRoot)) ?? null;
      if (await tellScheduleOwner(contextRoot, item, 'missed', line, deps) && ab && !ab.disabled) {
        try { await addPadNote(contextRoot, 'waiting', line); } catch { /* the owner was told */ }
      }
      removeScheduleItem(scope, item, home);
      continue;
    }
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
    try {
      await deliver(contextRoot, scope, item, effectiveReply(job.manifest), job.job, state.session, deps);
    } catch (err) {
      // Claimed but not handed over: never silent (Decision 10), never retried into a double.
      log(`[super-schedule] ${item.slug}@${item.fireIso} could not be handed over: ${(err as Error).message}`);
      removeScheduleItem(scope, item, home);
      await tellScheduleOwner(contextRoot, item, 'failed', SCHEDULE_LINES.failed(at), deps);
    }
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
    const ref = await hub!.injectText(ab!, hub!.syntheticUpdateId(), scheduleTurnText(item.slug, item.fireIso, job, item.data), session, { kind: 'schedule' });
    if (ref) { removeScheduleItem(scope, item, home); return; }
  }
  const queued = await (deps.enqueue ?? ((root, slug, fireIso, data) => enqueueSchedule(root, slug, fireIso, session, deps, data)))(contextRoot, item.slug, item.fireIso, item.data);
  // The Super went off between the check and the queue: the item stays and waits for it.
  if (!queued) { releaseScheduleFire(scope, item.slug, item.fireIso, home); return; }
  removeScheduleItem(scope, item, home);
}

/** The Mac door: a `schedule` item in the Super inbox, delivered when the Super is idle. */
async function enqueueSchedule(contextRoot: string, slug: string, fireIso: string, session: string, deps: ScheduleDeps, data?: string): Promise<boolean> {
  let queued = false;
  await writeSuper(contextRoot, (s) => {
    if (!s.enabled || !s.session) return;
    queued = true;
    s.queue.push({ id: newQueueId(), sessionId: s.session, kind: 'schedule', state: 'pending', createdAt: (deps.now ?? Date.now)(), automation: slug, fire: fireIso, ...(isConditionData(data) && data ? { conditionData: data } : {}) });
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

export { SCHEDULE_SLUG_PREFIX };
/** Leaves room for the echo's own words inside one Telegram message (4096). */
const MAX_JOB = 3500;
const TR_DAYS: Record<Weekday, string> = { mon: 'Pzt', tue: 'Sal', wed: 'Çar', thu: 'Per', fri: 'Cum', sat: 'Cmt', sun: 'Paz' };
const TR_REPLY: Record<AutomationReply, string> = { auto: 'neredeysem', telegram: 'Telegram', mac: 'Mac' };

export type ScheduleVerbResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; status: number; error: string; message: string };

const bad = (error: string, message: string, status = 400): ScheduleVerbResult => ({ ok: false, status, error, message });

const TR_MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

/** "her gün 09:00" / "Pzt, Çar 09:00" from the first weekly slot; "22 Kas 21:00, bir kez" for a
 *  dated job; "… · 3 kez" for a few-times one. */
export function scheduleWhen(m: Pick<AutomationManifest, 'schedule'>, limit: RunLimit = {}): string {
  if (limit.onceOn) {
    const [, mo, d] = limit.onceOn.split('-').map(Number);
    return `${d} ${TR_MONTHS[mo - 1]} ${atOf(m) ?? ''}, bir kez`.replace(' ,', ',');
  }
  const base = weeklyWhen(m);
  return limit.maxRuns ? `${base} · ${limit.maxRuns} kez` : base;
}

/** HH:MM of a weekly slot or of a dated job's cron (`M H D Mo *`), or null. */
function atOf(m: Pick<AutomationManifest, 'schedule'>): string | null {
  const slot = m.schedule?.slots?.[0];
  if (!slot) return null;
  if (slot.kind !== 'cron') return 'at' in slot ? slot.at : null;
  const [mm, hh] = slot.cron.split(' ').map(Number);
  return Number.isInteger(mm) && Number.isInteger(hh) ? `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` : null;
}

function weeklyWhen(m: Pick<AutomationManifest, 'schedule'>): string {
  const slot = m.schedule?.slots?.[0];
  if (!slot || slot.kind !== 'weekly') return m.schedule ? formatSchedule(m.schedule) : 'zamanı yok';
  const days = slot.days === 'daily' ? 'her gün' : slot.days.map((d) => TR_DAYS[d]).join(', ');
  return `${days} ${slot.at}`;
}

function replyOf(m: Pick<AutomationManifest, 'target' | 'reply'>): AutomationReply {
  return effectiveReply(m);
}

/** The plain pause sentence a condition the owner has not approved yet carries (kosullu-otomasyon D10). */
export const CONDITION_WAITS_LINE = 'Koşul onayını bekliyor; sen onaylayana kadar bu iş çalışmaz.';

/** The verbatim confirmation the owner gets on every add and change (Decision 4). */
export function scheduleEcho(verb: 'Kuruldu' | 'Değişti', m: AutomationManifest, waits = false): string {
  const condition = m.condition ? ` · önce betik bakar (${m.conditionWake === false ? 'doğru değilse uyanır' : 'doğruysa uyanır'})` : '';
  return `⏰ ${verb}: ${scheduleWhen(m, readRunLimit(m))} · cevap: ${TR_REPLY[replyOf(m)]}${m.target === 'super' ? '' : ' · Super kapalıyken de çalışır'}${condition} · «${m.prompt}»${waits ? `\n${CONDITION_WAITS_LINE}` : ''}`;
}

/** `--condition` / `--no-condition` / `--wake-when` from the verb's body, or an error message. */
function conditionPatch(b: Record<string, unknown>): { condition?: string | null; conditionWake?: boolean } | string {
  const out: { condition?: string | null; conditionWake?: boolean } = {};
  if (b.condition === false || b.noCondition === true) out.condition = null;
  else if (typeof b.condition === 'string') out.condition = b.condition;
  else if (b.condition !== undefined) return '--condition is a shell script';
  if (b.wakeWhen !== undefined) {
    if (b.wakeWhen !== 'true' && b.wakeWhen !== 'false') return '--wake-when is true or false';
    out.conditionWake = b.wakeWhen === 'true';
  }
  return out;
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

/** `--times`: a whole number of fires (0 = no limit, `change` only). */
function parseTimes(v: unknown, allowZero: boolean): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && (n >= 1 || (allowZero && n === 0)) ? n : null;
}

/** `add`'s `--once` / `--on` / `--times`, or an error message. */
function parseTiming(b: Record<string, unknown>, at: string, now: Date): RunLimit | string {
  const once = b.once === true;
  if (b.on !== undefined || once) {
    if (b.times !== undefined) return 'a one-off (--once / --on) runs once: drop --times';
    const r = resolveOnceDate(b.on, once, at, now);
    return 'error' in r ? r.error : { onceOn: r.date };
  }
  if (b.times !== undefined) {
    const n = parseTimes(b.times, false);
    if (n === null) return '--times is a whole number of runs (1 or more)';
    return { maxRuns: n };
  }
  return {};
}

/**
 * `change`'s timing: turns the schedule into a one-off (`--once` / `--on`), keeps a one-off's
 * date when only `--at` moves, makes it repeating again with `--days`, and sets or clears
 * `--times`. Writes the slot into `patch`; returns the frontmatter keys to write, or an error.
 */
function timingPatch(contextRoot: string, m: AutomationManifest, b: Record<string, unknown>, patch: UpdateAutomationInput, now: Date): { front?: Record<string, unknown> } | string {
  const cur = readRunLimit(m);
  const at = patch.at ?? atOf(m);
  const once = b.once === true;
  const retired = !m.enabled && !!readAutomationCache(contextRoot, m.slug)?.retiredAt;
  if (b.on !== undefined || once) {
    if (b.days !== undefined) return 'a one-off (--once / --on) runs on its date: drop --days';
    if (b.times !== undefined) return 'a one-off runs once: drop --times';
    if (!at) return 'say the time too: --at HH:MM';
    const r = resolveOnceDate(b.on, once, at, now);
    if ('error' in r) return r.error;
    delete patch.at;
    patch.slots = [onceSlot(r.date, at)];
    patch.catchupHours = ONCE_CATCHUP_HOURS;
    patch.enabled = true;
    return { front: { once_on: r.date, max_runs: null } };
  }
  let front: Record<string, unknown> | undefined;
  if (cur.onceOn) {
    if (patch.days !== undefined) {
      // Repeating again: a weekly slot at its time, the normal catch-up.
      if (!at) return 'say the time too: --at HH:MM';
      patch.at = at;
      patch.catchupHours = DEFAULT_CATCHUP_HOURS;
      if (retired) patch.enabled = true;
      front = { once_on: null };
    } else if (patch.at !== undefined) {
      if (b.times !== undefined) return 'a one-off runs once: drop --times (or give --days to repeat it)';
      const r = resolveOnceDate(cur.onceOn, false, patch.at, now);
      if ('error' in r) return r.error;
      patch.slots = [onceSlot(r.date, patch.at)];
      delete patch.at;
      if (retired) patch.enabled = true;
      front = { once_on: r.date };
    } else if (b.times !== undefined) {
      return 'a one-off runs once: give --days to repeat it --times';
    }
  }
  if (b.times !== undefined) {
    const n = parseTimes(b.times, true);
    if (n === null) return '--times is a whole number of runs (0 = no limit)';
    if (n > 0 && retired) patch.enabled = true;
    front = { ...(front ?? {}), max_runs: n > 0 ? n : null };
  }
  return front ? { front } : {};
}

function ours(root: string, id: unknown): AutomationManifest | null {
  if (typeof id !== 'string' || !id.startsWith(SCHEDULE_SLUG_PREFIX)) return null;
  const m = getAutomation(root, id);
  return m && m.path.endsWith(`${id}.md`) ? m : null;
}

function row(root: string, m: AutomationManifest, now: Date): Record<string, unknown> {
  const cache = readAutomationCache(root, m.slug);
  const limit = readRunLimit(m);
  const left = runsLeft(limit, cache);
  const done = !!cache?.retiredAt && !m.enabled;
  const next = m.schedule && m.enabled && left !== 0 ? nextFire(m.schedule, now) : null;
  return {
    id: m.slug, when: scheduleWhen(m, limit), reply: replyOf(m), kind: m.target === 'super' ? 'super' : 'headless',
    enabled: m.enabled, job: m.prompt, next: next ? formatLocalFire(next) : null,
    ...(limit.onceOn ? { once: limit.onceOn } : {}),
    ...(left !== null ? { runsLeft: left } : {}),
    ...(done ? { done: true, retiredAt: cache!.retiredAt } : {}),
    ...(m.condition ? { condition: m.condition, wakeWhen: m.conditionWake === false ? 'false' : 'true' } : {}),
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
    const timing = parseTiming(b, at, now);
    if (typeof timing === 'string') return bad('invalid_args', timing);
    if (timing.onceOn && b.days !== undefined) return bad('invalid_args', 'a one-off (--once / --on) runs on its date: drop --days');
    const headless = b.headless === true;
    const reply = parseReply(b.reply);
    if (reply === null) return bad('invalid_args', `--reply is one of ${AUTOMATION_REPLIES.join(' | ')}`);
    if (headless && reply === 'auto') return bad('invalid_args', 'a --headless job has no Super to follow him: --reply telegram or mac');
    const cond = conditionPatch(b);
    if (typeof cond === 'string') return bad('invalid_args', cond);
    const slug = `${SCHEDULE_SLUG_PREFIX}${at.replace(':', '')}-${randomBytes(3).toString('hex')}`;
    let m: AutomationManifest;
    try {
      registerProject(projectRoot, deps.home);
      m = createAutomation(contextRoot, {
        slug, title: job.length > 60 ? `${job.slice(0, 59)}…` : job, mode: 'sched', prompt: job,
        ...(timing.onceOn ? { slots: [onceSlot(timing.onceOn, at)], catchupHours: ONCE_CATCHUP_HOURS } : { days, at }),
        enabled: true, shared: false, notify: true,
        ...(headless ? (reply === 'telegram' ? { reply: 'telegram' as const } : {}) : { target: 'super' as const, reply: reply ?? 'auto' }),
        ...(typeof cond.condition === 'string' ? { condition: cond.condition } : {}),
        ...(cond.conditionWake !== undefined ? { conditionWake: cond.conditionWake } : {}),
      });
      if (timing.onceOn || timing.maxRuns) {
        try {
          patchManifestFrontmatter(m.path, { ...(timing.onceOn ? { once_on: timing.onceOn } : {}), ...(timing.maxRuns ? { max_runs: timing.maxRuns } : {}) });
          m = getAutomation(contextRoot, slug) ?? m;
        } catch (err) {
          // Never left behind as a daily job: the owner asked for a one-off.
          try { removeAutomation(contextRoot, slug); } catch { /* the error says it */ }
          throw err;
        }
      }
    } catch (err) {
      return bad('not_created', (err as Error).message, 409);
    }
    let stamped: boolean;
    try {
      // His own Super set it on his own message: approved here with that consent (C2), no card.
      // A condition is never stamped by the Super: it waits for his card, where he reads it.
      stamped = approveMadeHere(contextRoot, m, now, deps.home, 'super-verb');
    } catch (err) {
      // Never left behind unapproved: the owner asked for a schedule, not a card.
      try { removeAutomation(contextRoot, m.slug); } catch { /* the card shows it */ }
      return bad('not_created', (err as Error).message, 409);
    }
    await sayToOwner(contextRoot, scheduleEcho('Kuruldu', m, !stamped), deps);
    return { ok: true, result: { ...row(contextRoot, m, now), echoed: true, ...(stamped ? {} : { approval: 'waits', card: m.slug, note: CONDITION_WAITS_LINE }) } };
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
    const cond = conditionPatch(b);
    if (typeof cond === 'string') return bad('invalid_args', cond);
    Object.assign(patch, cond);
    const timed = timingPatch(contextRoot, m, b, patch, now);
    if (typeof timed === 'string') return bad('invalid_args', timed);
    if (!Object.keys(patch).length && !timed.front) return bad('invalid_args', 'say what changes: --job, --days, --at, --once, --on, --times, --reply, --condition, --no-condition or --wake-when');
    let after: AutomationManifest;
    let stamped: boolean;
    try {
      after = Object.keys(patch).length ? updateAutomation(contextRoot, m.slug, patch) : m;
      if (timed.front) {
        patchManifestFrontmatter(after.path, timed.front);
        after = getAutomation(contextRoot, m.slug) ?? after;
        // A new timing starts its count again. A job it switches back on is live from now (its
        // re-stamp below), not from the first tick after: the pause mark goes with it.
        const cache = readAutomationCache(contextRoot, m.slug);
        if (cache) {
          const { retiredAt: _r, runsDone: _d, pausedAt, ...rest } = cache;
          writeAutomationCache(contextRoot, m.slug, patch.enabled === true || !pausedAt ? rest : { ...rest, pausedAt });
        }
      }
      stamped = approveMadeHere(contextRoot, after, now, deps.home, 'super-verb');
    } catch (err) {
      return bad('not_changed', (err as Error).message, 409);
    }
    await sayToOwner(contextRoot, scheduleEcho('Değişti', after, !stamped), deps);
    return { ok: true, result: { ...row(contextRoot, after, now), echoed: true, ...(stamped ? {} : { approval: 'waits', paused: true, card: after.slug, note: CONDITION_WAITS_LINE }) } };
  }
  if (op === 'cancel') {
    const m = ours(contextRoot, b.id);
    if (!m) return bad('unknown_schedule', 'no such schedule (`dreamcontext super schedule list`)', 404);
    try { removeAutomation(contextRoot, m.slug); } catch (err) { return bad('not_cancelled', (err as Error).message, 409); }
    return { ok: true, result: { cancelled: m.slug } };
  }
  return bad('invalid_args', 'op is add | list | change | cancel');
}
