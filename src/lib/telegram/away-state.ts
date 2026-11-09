/**
 * Whether the owner is away from the Mac, as a runner process can read it (super-rutin plan,
 * owner 2026-11-09: a plain automation's question reaches Telegram only while he is away).
 *
 * The hub owns the fact (`TelegramHub.ownerAway()`: on Telegram, or a hands-free run on) and
 * writes it here whenever it changes. A runner (the launchd tick or the server's job host) reads
 * it: away when the file says so and is under 24 h old, or when the app is not running at all
 * (no Mac card can show a question then, so Telegram is where it can be seen).
 *
 * Forging the file can only send a question to his own Telegram chat, the safe direction.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readTelegramJson, telegramBase, writeTelegramJson } from './config.js';
import { serverAlive } from './away.js';

export const AWAY_STATE_FILE = 'away.json';
const AWAY_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Written by the hub (best effort: a write failure only means questions stay on the Mac). */
export function writeAwayState(away: boolean, home: string = homedir(), now: number = Date.now()): void {
  try { writeTelegramJson(join(telegramBase(home), AWAY_STATE_FILE), { v: 1, away, at: now }, home); } catch { /* stays at the Mac */ }
}

/** Read by a runner. `alive` is injectable for tests. */
export function ownerAwayNow(home: string = homedir(), now: number = Date.now(), alive: (h: string) => boolean = (h) => serverAlive(h)): boolean {
  if (!alive(home)) return true;
  const r = readTelegramJson(join(telegramBase(home), AWAY_STATE_FILE), home);
  if (!r.ok || !r.value || typeof r.value !== 'object') return false;
  const v = r.value as { away?: unknown; at?: unknown };
  return v.away === true && typeof v.at === 'number' && now - v.at >= 0 && now - v.at < AWAY_STATE_MAX_AGE_MS;
}
