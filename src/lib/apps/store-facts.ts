import { extname, join } from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { parseSchedule } from '../automations/schedule.js';
import type { ScheduleSlot } from '../automations/types.js';
import { cleanText, type AppManifest } from './manifest.js';
import { parseStoreReadme, storeReadiness, type StoreReadiness, type StoreReadme } from './store-readme.js';

/**
 * What a store page says about an app (app-paylasim-magaza r2): the "What it can do" lines come
 * from the manifest, the words from the README, the pictures as data URLs (the page never fetches
 * a path an app chose). Shared by the install preview (files read from the quarantine repo) and
 * an app's own page (files read from its folder).
 */

export interface CanLine { kind: 'action' | 'schedule' | 'settings' | 'agent'; text: string }

export interface StorePage {
  readme: StoreReadme;
  readiness: StoreReadiness;
  /** The README screenshots that exist and are images, as data URLs (at most 3). */
  shots: Array<{ alt: string; src: string }>;
  can: CanLine[];
}

const DAY: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

function slotText(s: ScheduleSlot): string {
  if (s.kind === 'cron') return `On a timer (${cleanText(s.cron, 40)})`;
  if (s.kind === 'monthdays') return `On day ${s.monthdays.join(', ')} of the month at ${s.at}`;
  if (s.kind === 'nth') return `On the ${s.nth.map((n) => `${ORD[n.n] ?? `${n.n}th`} ${DAY[n.weekday] ?? n.weekday}`).join(', ')} at ${s.at}`;
  const every = s.everyWeeks && s.everyWeeks > 1 ? ` every ${s.everyWeeks} weeks` : '';
  if (s.days === 'daily') return `Every day at ${s.at}`;
  const days = s.days as string[];
  if (days.length === 5 && ['mon', 'tue', 'wed', 'thu', 'fri'].every((d) => days.includes(d))) return `Weekdays at ${s.at}${every}`;
  return `${days.map((d) => DAY[d] ?? d).join(', ')} at ${s.at}${every}`;
}

/** A schedule in plain words; the raw id when it does not parse. */
export function scheduleText(raw: Record<string, unknown>, id: string): string {
  const s = parseSchedule(raw);
  return s && s.slots.length ? s.slots.map(slotText).join('; ') : cleanText(id, 60);
}

export function canLines(m: Pick<AppManifest, 'actions' | 'schedules' | 'config' | 'agent'>): CanLine[] {
  const out: CanLine[] = [];
  for (const a of m.actions.slice(0, 12)) out.push({ kind: 'action', text: cleanText(a.title || a.id, 80) });
  for (const s of m.schedules.slice(0, 6)) out.push({ kind: 'schedule', text: scheduleText(s.schedule, s.id) });
  if (m.config.length) out.push({ kind: 'settings', text: m.config.slice(0, 8).map((f) => cleanText(f.label || f.key, 40)).join(', ') });
  if (m.agent?.member) out.push({ kind: 'agent', text: `AI Team member "${cleanText(m.agent.member, 40)}"` });
  else if (m.agent?.own) out.push({ kind: 'agent', text: 'Its own assistant' });
  return out;
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
export const ICON_MAX_BYTES = 1024 * 1024;
const SHOT_MAX_BYTES = 2 * 1024 * 1024;

function magicOk(ext: string, b: Buffer): boolean {
  if (ext === '.png') return b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (ext === '.jpg' || ext === '.jpeg') return b[0] === 0xff && b[1] === 0xd8;
  if (ext === '.webp') return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

/** A raster as a data URL, or null (SVG never: on the dashboard origin it could run script). */
export function imageDataUrl(path: string, data: Buffer | null | undefined, max: number): string | null {
  const ext = extname(path).toLowerCase();
  if (!data || !MIME[ext] || data.length === 0 || data.length > max || !magicOk(ext, data)) return null;
  return `data:${MIME[ext]};base64,${data.toString('base64')}`;
}

/** The store page from a README text and a file reader (repo blob or app folder). */
export function storePage(readmeText: string, m: Pick<AppManifest, 'actions' | 'schedules' | 'config' | 'agent'>, read: (path: string) => Buffer | null): StorePage {
  const readme = parseStoreReadme(readmeText);
  const shots: StorePage['shots'] = [];
  for (const s of readme.screenshots) {
    const src = imageDataUrl(s.path, read(s.path), SHOT_MAX_BYTES);
    if (src) shots.push({ alt: s.alt, src });
  }
  return { readme, readiness: storeReadiness(readme), shots, can: canLines(m) };
}

/**
 * A file of an app folder, never through a link and never outside the folder; null otherwise.
 * `rel` is a path the README or the manifest named.
 */
export function readAppFile(root: string, rel: string, max: number): Buffer | null {
  try {
    if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '' || s.startsWith('.'))) return null;
    const p = join(root, rel);
    const st = lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink() || st.size > max) return null;
    const real = realpathSync(p);
    const base = realpathSync(root);
    if (!real.startsWith(base + '/')) return null;
    return readFileSync(real);
  } catch {
    return null;
  }
}
