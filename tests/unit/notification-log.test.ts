import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NOTIFICATION_LOG_CAP,
  notificationsLogPath,
  readNotifications,
  recordNotification,
} from '../../src/lib/notification-log.js';

/**
 * `~/.dreamcontext/notifications.jsonl`, the history the dashboard's Notifications window
 * lists. Every case takes an injected home (test-isolation-injectable-home): a leak here
 * would write into the developer's real banner history.
 */

let home: string;
/** Proof of isolation that a real banner posted mid-run cannot break: no line this suite
 *  writes (every body here carries the marker) may ever reach the REAL history. */
const MARK = 'dc-notif-log-test';
const realLog = join(homedir(), '.dreamcontext', 'notifications.jsonl');

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-notif-log-')); });
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  const real = existsSync(realLog) ? readFileSync(realLog, 'utf-8') : '';
  expect(real.includes(MARK), 'this suite wrote into the REAL history').toBe(false);
});

describe('notification history', () => {
  it('lives under the injected home', () => {
    expect(notificationsLogPath(home)).toBe(join(home, '.dreamcontext', 'notifications.jsonl'));
  });

  it('records {id, at, title, body, link, file} and reads it back newest first', () => {
    const a = recordNotification({ title: 'A', body: MARK, link: 'dreamcontext://inbox' }, home, new Date('2026-09-29T10:00:00Z'));
    const b = recordNotification({ title: 'B', body: MARK, file: '/tmp/b.md' }, home, new Date('2026-09-29T10:01:00Z'));
    expect(a?.id).not.toBe(b?.id);
    const read = readNotifications(50, home);
    expect(read.map((e) => e.title)).toEqual(['B', 'A']);
    expect(read[0]).toEqual({ id: b?.id, at: '2026-09-29T10:01:00.000Z', title: 'B', body: MARK, link: null, file: '/tmp/b.md' });
    expect(read[1].link).toBe('dreamcontext://inbox');
    expect(read[1].file).toBeNull();
  });

  it(`caps the file at ${NOTIFICATION_LOG_CAP} lines, dropping the oldest`, () => {
    for (let i = 0; i < NOTIFICATION_LOG_CAP + 15; i += 1) recordNotification({ title: `t${i}`, body: MARK }, home);
    const lines = readFileSync(notificationsLogPath(home), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(NOTIFICATION_LOG_CAP);
    const all = readNotifications(NOTIFICATION_LOG_CAP, home);
    expect(all[0].title).toBe(`t${NOTIFICATION_LOG_CAP + 14}`);
    expect(all[all.length - 1].title).toBe('t15');
  });

  it('honours the limit', () => {
    for (let i = 0; i < 5; i += 1) recordNotification({ title: `t${i}`, body: MARK }, home);
    expect(readNotifications(2, home).map((e) => e.title)).toEqual(['t4', 't3']);
  });

  it('is empty when nothing was ever posted, and skips a torn or foreign line', () => {
    expect(readNotifications(50, home)).toEqual([]);
    recordNotification({ title: 'ok', body: MARK }, home);
    appendFileSync(notificationsLogPath(home), '{"id":"x","at":\n{"not":"an entry"}\n');
    recordNotification({ title: 'ok2', body: MARK }, home);
    expect(readNotifications(50, home).map((e) => e.title)).toEqual(['ok2', 'ok']);
  });
});
