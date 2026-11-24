import type { Item } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse YYYY-MM-DD as a UTC midnight timestamp. */
export function parseDay(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`bad date: ${iso}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `today` until `iso` (negative once past). */
export function daysUntil(iso: string, today: string): number {
  return Math.round((parseDay(iso) - parseDay(today)) / DAY_MS);
}

export function isExpired(item: Item, today: string): boolean {
  return item.expiresOn !== null && daysUntil(item.expiresOn, today) < 0;
}

/**
 * Expiring soon = not yet expired and expires within `windowDays` days of today,
 * the last day of the window included.
 */
export function isExpiringSoon(item: Item, today: string, windowDays: number): boolean {
  if (item.expiresOn === null) return false;
  const d = daysUntil(item.expiresOn, today);
  return d >= 0 && d <= windowDays;
}

export function addDays(iso: string, days: number): string {
  return formatDay(parseDay(iso) + days * DAY_MS);
}
