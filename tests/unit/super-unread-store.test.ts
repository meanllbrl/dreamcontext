/**
 * The unread store keyed by vault + superId (plan-r10 1, Wave 3 lane B): a member's count never
 * lands on main's row, a key is born with a count or an open question and dies with its pane or at
 * nothing, and main's reader (`useSuperUnreadCount`) reads main's count exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _superUnreadSize, dropSuperUnread, publishSuperUnread, readSuperUnread } from '../../dashboard/src/components/sleepy/super/superUnreadStore';

describe('keyed by vault and superId', () => {
  it('main is the default: an old caller publishes and reads main', () => {
    const pane = {};
    publishSuperUnread('ku-a', 3, pane);
    expect(readSuperUnread('ku-a')).toEqual({ count: 3, asking: false });
    expect(readSuperUnread('ku-a', 'main')).toEqual({ count: 3, asking: false });
    dropSuperUnread('ku-a', pane);
    expect(readSuperUnread('ku-a')).toEqual({ count: 0, asking: false });
  });

  it("a member's count is its own, never main's, never another member's", () => {
    const main = {};
    const rota = {};
    publishSuperUnread('ku-b', 1, main, 'main');
    publishSuperUnread('ku-b', 4, rota, 'm:rota', true);
    expect(readSuperUnread('ku-b', 'main')).toEqual({ count: 1, asking: false });
    expect(readSuperUnread('ku-b', 'm:rota')).toEqual({ count: 4, asking: true });
    expect(readSuperUnread('ku-b', 'm:gantt')).toEqual({ count: 0, asking: false });
    expect(readSuperUnread('ku-other', 'm:rota')).toEqual({ count: 0, asking: false });
    dropSuperUnread('ku-b', main, 'main');
    dropSuperUnread('ku-b', rota, 'm:rota');
  });

  it('born with a count or a question, dead at neither', () => {
    const before = _superUnreadSize();
    const pane = {};
    publishSuperUnread('ku-c', 0, pane, 'm:rota', true);
    expect(_superUnreadSize()).toBe(before + 1);
    expect(readSuperUnread('ku-c', 'm:rota')).toEqual({ count: 0, asking: true });
    publishSuperUnread('ku-c', 0, pane, 'm:rota', false);
    expect(_superUnreadSize()).toBe(before);
  });

  it('only the pane that published drops it (a replaced pane never wipes its successor)', () => {
    const before = _superUnreadSize();
    const old = {};
    const fresh = {};
    publishSuperUnread('ku-d', 2, old, 'm:rota');
    publishSuperUnread('ku-d', 2, fresh, 'm:rota');
    dropSuperUnread('ku-d', old, 'm:rota');
    expect(readSuperUnread('ku-d', 'm:rota').count).toBe(2);
    // Dropping main's key with the member's pane touches nothing.
    dropSuperUnread('ku-d', fresh, 'main');
    expect(readSuperUnread('ku-d', 'm:rota').count).toBe(2);
    dropSuperUnread('ku-d', fresh, 'm:rota');
    expect(_superUnreadSize()).toBe(before);
  });

  it('the same answer object until something changes (useSyncExternalStore stays quiet)', () => {
    const pane = {};
    publishSuperUnread('ku-e', 5, pane, 'm:rota');
    const a = readSuperUnread('ku-e', 'm:rota');
    publishSuperUnread('ku-e', 5, pane, 'm:rota');
    expect(readSuperUnread('ku-e', 'm:rota')).toBe(a);
    publishSuperUnread('ku-e', 6, pane, 'm:rota');
    expect(readSuperUnread('ku-e', 'm:rota')).not.toBe(a);
    expect(readSuperUnread(null, 'm:rota')).toBe(readSuperUnread('nowhere', 'main'));
    dropSuperUnread('ku-e', pane, 'm:rota');
  });

  it('main\'s reader is unchanged: it reads main\'s count only', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'dashboard/src/components/sleepy/super/superUnreadStore.ts'), 'utf-8');
    expect(src).toMatch(/export function useSuperUnreadCount\(vault: string \| null\): number \{\s*const read = \(\) => readSuperUnread\(vault, 'main'\)\.count;/);
    expect(src).toMatch(/export function useSuperUnread\(vault: string \| null, superId: SuperId\): SuperUnreadView/);
  });
});
