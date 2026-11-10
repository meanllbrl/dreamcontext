/**
 * An AI Team member waiting on the owner reaches HIS bar and the Super chat (owner 2026-11-10:
 * "üyenin izni yalnız profilinde duruyor"). The server mirrors the member's item into main's queue
 * as `member` (super-member-mirror.test.ts); these are the Mac's readers of that mirror: the bar's
 * head and count (`needsOwner`, `queueHead`), the chat's member cards (`openMemberMirrors`) and
 * the line the bar draws (`memberItemText`). Each fails on the code before the mirror was read.
 */
import { describe, it, expect } from 'vitest';
import { needsOwner, ownerQueueCount, queueHead } from '../../dashboard/src/components/sleepy/super/superHandover';
import { memberItemText, openMemberMirrors } from '../../dashboard/src/components/sleepy/super/superQuestions';
import type { SuperQueueItem } from '../../dashboard/src/lib/superTypes';

const mirror = (over: Partial<SuperQueueItem> = {}): SuperQueueItem => ({
  id: 'q-m1', sessionId: 'member-sid', kind: 'member', state: 'pending', createdAt: 10,
  member: 'otobot', answers: 'mq-1', of: 'ask', ownerText: 'Slack DM to Ada: send it?',
  ...over,
} as SuperQueueItem);

describe('a member mirror in the owner bar', () => {
  it('is his from birth: pending, delivered and escalated all count; done does not', () => {
    expect(needsOwner(mirror())).toBe(true);
    expect(needsOwner(mirror({ state: 'delivered' }))).toBe(true);
    expect(needsOwner(mirror({ state: 'escalated' }))).toBe(true);
    expect(needsOwner(mirror({ state: 'done' }))).toBe(false);
  });

  it('heads the bar and is counted', () => {
    const queue = [mirror()];
    expect(queueHead({ queue })?.id).toBe('q-m1');
    expect(ownerQueueCount({ queue })).toBe(1);
  });

  it("a member's permission jumps the line like a child's", () => {
    const older = mirror({ id: 'q-old', of: 'ask', createdAt: 1, state: 'escalated' });
    const perm = mirror({ id: 'q-perm', of: 'permission', createdAt: 5, ownerText: undefined });
    expect(queueHead({ queue: [older, perm] })?.id).toBe('q-perm');
  });
});

describe('a member mirror in the Super chat', () => {
  it('lists only open mirrors that name a member, oldest first', () => {
    const queue = [
      mirror({ id: 'b', createdAt: 20 }),
      mirror({ id: 'a', createdAt: 5 }),
      mirror({ id: 'closed', state: 'done' }),
      mirror({ id: 'nameless', member: undefined }),
      { id: 'q', sessionId: 's', kind: 'question', state: 'escalated', createdAt: 1 } as SuperQueueItem,
    ];
    expect(openMemberMirrors(queue).map((q) => q.id)).toEqual(['a', 'b']);
  });

  it('says its own words, or what kind of wait it is', () => {
    const t = (k: string) => k;
    expect(memberItemText(mirror(), t)).toBe('Slack DM to Ada: send it?');
    expect(memberItemText(mirror({ ownerText: undefined, of: 'permission' }), t)).toBe('super.queue.memberPermission');
    expect(memberItemText(mirror({ ownerText: undefined, of: 'owner' }), t)).toBe('super.queue.memberWaiting');
  });
});
