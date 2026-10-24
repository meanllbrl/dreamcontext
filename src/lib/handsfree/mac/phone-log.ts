/**
 * The phone's connection log, landed on the Mac (`POST /api/handsfree/phone-log`).
 *
 * The phone keeps a small ring of its own socket and card events (dashboard
 * `lib/phoneConnLog.ts`) and sends it on a tap from the Sohbetler list, so the next time the
 * owner says "the phone misbehaved" the agent reads evidence instead of guessing. This module
 * is the Mac's half: the shape check (numbers, flags, 8-char ids and closed enums only — no
 * free text can be written through it) and the bounded, owner-only files.
 *
 * Files: `~/.dreamcontext/handsfree-mac/phone-logs/<ISO>-<device8>.json`, directory 0700, file
 * 0600, the newest {@link PHONE_LOG_KEEP} kept.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Mirrors the dashboard's `PHONE_LOG_KINDS` (tests/unit/handsfree-phone-log.test.ts holds them equal). */
export const PHONE_LOG_KINDS = [
  'boot', 'attempt', 'open', 'close', 'reattached', 'ask', 'card-mount', 'respawn', 'chip', 'submit-held',
] as const;
/** Mirrors the dashboard's `PHONE_LOG_REASONS`. */
export const PHONE_LOG_REASONS = ['account', 'mode', 'resume', 'offline', 'unsent', 'shown', 'hidden'] as const;

export const PHONE_LOG_MAX_BYTES = 64 * 1024;
export const PHONE_LOG_MAX_EVENTS = 500;
export const PHONE_LOG_UA_MAX = 200;
export const PHONE_LOG_KEEP = 20;
/** One upload per device per this long. */
export const PHONE_LOG_INTERVAL_MS = 10_000;

export interface PhoneLogEvent {
  t: number; k: string; cid8: string; code?: number; busy?: boolean; req8?: string; reason?: string;
}
export interface PhoneLog { v: 1; app: string; ua: string; events: PhoneLogEvent[] }

const ID8 = /^[A-Za-z0-9_-]{0,8}$/;
const APP = /^[0-9A-Za-z.+-]{0,40}$/;
const EVENT_KEYS = new Set(['t', 'k', 'cid8', 'code', 'busy', 'req8', 'reason']);
const LOG_KEYS = new Set(['v', 'app', 'ua', 'events']);
const KINDS = new Set<string>(PHONE_LOG_KINDS);
const REASONS = new Set<string>(PHONE_LOG_REASONS);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** The log, or the reason it is refused. Unknown keys are refused, never dropped: the shape IS
 *  the promise that nothing but these fields reaches the disk. */
export function parsePhoneLog(body: unknown): { ok: true; log: PhoneLog } | { ok: false; reason: string } {
  if (!isObj(body)) return { ok: false, reason: 'not an object' };
  for (const k of Object.keys(body)) if (!LOG_KEYS.has(k)) return { ok: false, reason: `unknown key ${k}` };
  if (body.v !== 1) return { ok: false, reason: 'v must be 1' };
  if (typeof body.app !== 'string' || !APP.test(body.app)) return { ok: false, reason: 'bad app' };
  if (typeof body.ua !== 'string' || body.ua.length > PHONE_LOG_UA_MAX || /[\u0000-\u001f]/.test(body.ua)) return { ok: false, reason: 'bad ua' };
  if (!Array.isArray(body.events) || body.events.length > PHONE_LOG_MAX_EVENTS) return { ok: false, reason: 'bad events' };
  const events: PhoneLogEvent[] = [];
  for (const e of body.events) {
    if (!isObj(e)) return { ok: false, reason: 'bad event' };
    for (const k of Object.keys(e)) if (!EVENT_KEYS.has(k)) return { ok: false, reason: `unknown event key ${k}` };
    if (!isInt(e.t, 0, 8_640_000_000_000_000)) return { ok: false, reason: 'bad t' };
    if (typeof e.k !== 'string' || !KINDS.has(e.k)) return { ok: false, reason: 'bad k' };
    if (typeof e.cid8 !== 'string' || !ID8.test(e.cid8)) return { ok: false, reason: 'bad cid8' };
    if (e.code !== undefined && !isInt(e.code, 0, 9999)) return { ok: false, reason: 'bad code' };
    if (e.busy !== undefined && typeof e.busy !== 'boolean') return { ok: false, reason: 'bad busy' };
    if (e.req8 !== undefined && (typeof e.req8 !== 'string' || !ID8.test(e.req8))) return { ok: false, reason: 'bad req8' };
    if (e.reason !== undefined && (typeof e.reason !== 'string' || !REASONS.has(e.reason))) return { ok: false, reason: 'bad reason' };
    // Rebuilt field by field: what is written is exactly what was checked.
    const ev: PhoneLogEvent = { t: e.t, k: e.k, cid8: e.cid8 };
    if (e.code !== undefined) ev.code = e.code as number;
    if (e.busy !== undefined) ev.busy = e.busy as boolean;
    if (e.req8 !== undefined) ev.req8 = e.req8 as string;
    if (e.reason !== undefined) ev.reason = e.reason as string;
    events.push(ev);
  }
  return { ok: true, log: { v: 1, app: body.app, ua: body.ua, events } };
}

export function phoneLogsDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'handsfree-mac', 'phone-logs');
}

/** Write one log (0600 in a 0700 directory) and keep the newest {@link PHONE_LOG_KEEP}.
 *  Returns the file's path. */
export function writePhoneLog(log: PhoneLog, deviceHash: string, home: string = homedir(), now = new Date()): string {
  const dir = phoneLogsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${stamp}-${deviceHash.slice(0, 8)}.json`);
  writeFileSync(file, `${JSON.stringify(log, null, 1)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  // ISO stamps sort by time: the oldest go first.
  const all = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - PHONE_LOG_KEEP))) rmSync(join(dir, old), { force: true });
  return file;
}
