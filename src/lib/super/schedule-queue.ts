/**
 * The Super automation's hand-off (super-rutin plan C3): the automations tick decides a Super
 * automation is due, the runner writes ONE queue item here and spawns nothing, and the server
 * (src/server/super-schedule.ts) delivers it as a turn of the project's Super session.
 *
 *   ~/.dreamcontext/telegram/super-schedule/<scope>/<slug>@<fireMs>.json   0600
 *   ~/.dreamcontext/telegram/super-schedule/<scope>/told.json              0600
 *
 * Under the telegram folder to reuse its symlink-, hardlink- and escape-refusing IO (config.ts);
 * `listBindings` skips it (not a scope). An item holds no job text: the server reads the job from
 * the APPROVED manifest at delivery, and trusts an item only when `fireIso` is the fire the tick
 * recorded (`cache.lastFireAt`) and that fire was never handed over (`#delivered` in the ledger),
 * so a forged file fires nothing and a replayed one fires nothing twice.
 *
 * `told.json` is the told-ledger (Decision 10): every notice about a fire (missed, Super off) and
 * every hand-over is keyed `<slug>@<fireIso>#<what>` and happens at most once.
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidScope, readTelegramJson, scopeOfContextRoot, telegramBase, writeTelegramJson } from '../telegram/config.js';

export interface ScheduleItem {
  v: 1;
  slug: string;
  fireIso: string;
  /** Written by the tick for a fire it found past catch-up: only a "kaçtı" notice, never a turn. */
  missed?: true;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const FILE_RE = /^([a-z0-9][a-z0-9-]{0,119})@(\d{1,15})\.json$/;
/** Told-ledger entries older than this are pruned on write. Longer than the longest catch-up
 *  (MAX_CATCHUP_HOURS, 7 days): a fire whose `#delivered` key is gone is past catch-up anyway. */
const TOLD_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

export function scheduleDir(scope: string, home: string = homedir()): string {
  if (!isValidScope(scope)) throw new Error('invalid schedule scope');
  return join(telegramBase(home), 'super-schedule', scope);
}

function itemFile(scope: string, slug: string, fireIso: string, home: string): string {
  const ms = Date.parse(fireIso);
  if (!SLUG_RE.test(slug) || !Number.isFinite(ms) || ms < 0) throw new Error('invalid schedule item');
  return join(scheduleDir(scope, home), `${slug}@${ms}.json`);
}

function cleanItem(v: unknown, slug: string, ms: number): ScheduleItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || o.slug !== slug || typeof o.fireIso !== 'string' || Date.parse(o.fireIso) !== ms) return null;
  return {
    v: 1, slug, fireIso: new Date(ms).toISOString(),
    ...(o.missed === true ? { missed: true as const } : {}),
  };
}

/** Writes one item (the runner's due fire, or the tick's missed one). */
export function writeScheduleItem(contextRoot: string, item: Omit<ScheduleItem, 'v'>, home: string = homedir()): void {
  const scope = scopeOfContextRoot(contextRoot);
  const fireIso = new Date(Date.parse(item.fireIso)).toISOString();
  writeTelegramJson(itemFile(scope, item.slug, fireIso, home), { v: 1, slug: item.slug, fireIso, ...(item.missed ? { missed: true } : {}) }, home);
}


export function removeScheduleItem(scope: string, item: Pick<ScheduleItem, 'slug' | 'fireIso'>, home: string = homedir()): void {
  try { rmSync(itemFile(scope, item.slug, item.fireIso, home), { force: true }); } catch { /* gone */ }
}

/** Every item of a scope, oldest fire first. A file that is not a clean item is removed. */
export function listScheduleItems(scope: string, home: string = homedir()): ScheduleItem[] {
  // A symlinked folder on the way is never listed: its files would be someone else's to remove.
  if (!realFolders(home, scope)) return [];
  let names: string[];
  try { names = readdirSync(scheduleDir(scope, home)); } catch { return []; }
  const out: ScheduleItem[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const file = join(scheduleDir(scope, home), name);
    const read = readTelegramJson(file, home);
    const item = read.ok ? cleanItem(read.value, m[1], Number(m[2])) : null;
    if (!item) {
      // A symlink or a foreign file is never followed; it is only unlinked (rm does not follow).
      try { rmSync(file, { force: true }); } catch { /* leave it */ }
      continue;
    }
    out.push(item);
  }
  return out.sort((a, b) => a.fireIso.localeCompare(b.fireIso));
}

/** True when `super-schedule` and `super-schedule/<scope>` are real folders (or not there yet). */
function realFolders(home: string, scope: string): boolean {
  const base = join(telegramBase(home), 'super-schedule');
  for (const dir of [base, join(base, scope)]) {
    try { if (!lstatSync(dir).isDirectory()) return false; } catch { return true; }
  }
  return true;
}

/** The scopes that hold any item. */
export function listScheduleScopes(home: string = homedir()): string[] {
  try {
    return readdirSync(join(telegramBase(home), 'super-schedule')).filter((s) => isValidScope(s));
  } catch { return []; }
}

// ─── The told-ledger ─────────────────────────────────────────────────────────

export type ToldWhat = 'missed' | 'off' | 'unapproved' | 'no-bot' | 'delivered';

export function toldKey(slug: string, fireIso: string, what: ToldWhat): string {
  return `${slug}@${fireIso}#${what}`;
}

function readTold(scope: string, home: string): Record<string, number> {
  const read = readTelegramJson(join(scheduleDir(scope, home), 'told.json'), home);
  if (!read.ok || !read.value || typeof read.value !== 'object') return {};
  const told = (read.value as { told?: unknown }).told;
  if (!told || typeof told !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(told as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

export function wasTold(scope: string, key: string, home: string = homedir()): boolean {
  return readTold(scope, home)[key] !== undefined;
}

/** Records a notice; true when it was not told before (the caller sends it only then). */
export function markTold(scope: string, key: string, now = Date.now(), home: string = homedir()): boolean {
  const told = readTold(scope, home);
  if (told[key] !== undefined) return false;
  const kept: Record<string, number> = {};
  for (const [k, at] of Object.entries(told)) if (now - at < TOLD_KEEP_MS) kept[k] = at;
  kept[key] = now;
  writeTelegramJson(join(scheduleDir(scope, home), 'told.json'), { v: 1, told: kept }, home);
  return true;
}

/** Claims one fire for its single hand-over; false when it was already handed over. Synchronous
 *  read-and-write, so two sweeps (or a replayed file) can never both win. */
export function claimScheduleFire(scope: string, slug: string, fireIso: string, now = Date.now(), home: string = homedir()): boolean {
  return markTold(scope, toldKey(slug, fireIso, 'delivered'), now, home);
}

/** Gives a claim back when the hand-over could not happen (the Super went off): it waits. */
export function releaseScheduleFire(scope: string, slug: string, fireIso: string, home: string = homedir()): void {
  const told = readTold(scope, home);
  const key = toldKey(slug, fireIso, 'delivered');
  if (told[key] === undefined) return;
  delete told[key];
  writeTelegramJson(join(scheduleDir(scope, home), 'told.json'), { v: 1, told }, home);
}

/** The tick found a Super automation's fire past its catch-up window (`outside-catchup`, which
 *  `isDue` repeats every tick): one `missed` item, unless that fire was already told. */
export function noteMissedSuperFire(contextRoot: string, slug: string, fireAt: Date, home: string = homedir()): boolean {
  const scope = scopeOfContextRoot(contextRoot);
  const fireIso = fireAt.toISOString();
  if (wasTold(scope, toldKey(slug, fireIso, 'missed'), home)) return false;
  if (listScheduleItems(scope, home).some((i) => i.slug === slug && i.fireIso === fireIso)) return false;
  writeScheduleItem(contextRoot, { slug, fireIso, missed: true }, home);
  return true;
}
