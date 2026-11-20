/** A child's permission on the Mac (super-v3 D8): a card in the Super chat, never the stage's top band; the Super's own allows fold into one line. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowLogsOf, bandHead, macPermissionItems, stageBandCount, stageBandHead } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { permAllowKeyOf } from '../../dashboard/src/components/sleepy/super/superJobsStore.js';
import type { SuperQueueItem } from '../../dashboard/src/lib/superTypes.js';

const D = join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy');
const card = readFileSync(join(D, 'super', 'SuperPermissionCard.tsx'), 'utf-8');
const tail = readFileSync(join(D, 'super', 'SuperQuestionCard.tsx'), 'utf-8');
const surface = readFileSync(join(D, 'AgentSurface.tsx'), 'utf-8');

const item = (over: Partial<SuperQueueItem>): SuperQueueItem => ({
  id: 'q1', sessionId: 'c1', kind: 'permission', state: 'pending', createdAt: 1, requestId: 'r1', ...over,
} as SuperQueueItem);

describe('the Mac permission is a chat card', () => {
  const queue = [item({}), item({ id: 'q2', sessionId: 'c2', createdAt: 0, kind: 'owner', ownerText: 'Sign in' })];

  it('leaves the stage band on the Mac and stays in it on a remote screen', () => {
    // The off-page dock's band keeps a permission at the head of the line.
    expect(bandHead({ queue })?.id).toBe('q1');
    expect(stageBandHead({ queue: [item({})] }, false)).toBeNull();
    expect(stageBandCount({ queue: [item({})] }, false)).toBe(0);
    expect(stageBandHead({ queue: [item({})] }, true)?.id).toBe('q1');
    expect(stageBandCount({ queue }, true)).toBe(2);
  });

  it('one he already allowed stays the band\'s waiting line, never a second Allow card', () => {
    const allowed = item({ allowed: 'once' });
    expect(macPermissionItems([allowed])).toEqual([]);
    expect(stageBandHead({ queue: [allowed] }, false)?.id).toBe('q1');
  });

  it('the cards are the open permissions only, oldest first; a Bypass child\'s goes to its Super first', () => {
    const list = macPermissionItems([
      item({ id: 'a', createdAt: 5 }), item({ id: 'b', createdAt: 2 }),
      item({ id: 'done', state: 'done' }), item({ id: 'super', toSuper: true }), item({ id: 'ask', kind: 'ask' }),
    ]);
    expect(list.map((q) => q.id)).toEqual(['b', 'a']);
  });

  it('three answers, Allow once primary, Always for this job only when the item offers that size', () => {
    expect(card).toContain("data-testid=\"super-permission-deny\"");
    expect(card).toContain("{t('super.perm.dontAllow')}");
    expect(card).toContain("const job = choices.sizes.includes('job') && !pending.suppressAlwaysAllow;");
    expect(card).toContain("wide.submit(allowAnswer('permission', 'job'))");
    expect(card).toMatch(/className="chat-btn pill primary"[^>]*data-testid="super-permission-allow"/);
    expect(card).toContain('<PermissionDetails command={command} startOpen />');
  });

  it('one answer per request: the band\'s latch, from the child\'s own pending request', () => {
    expect(card).toContain('if (!claimOwnerAnswer(key, item.id, scope, child.status === \'open\')) return;');
    expect(card).toContain('noteOwnerPending(key, ownerPendingPresent(item, child, []));');
    expect(card).toContain("p.kind === 'permission' && p.requestId === item.requestId");
  });

  it('the tail draws them, and only the Mac publishes them', () => {
    expect(tail).toContain('<MacPermission');
    expect(surface).toContain('remoteDesktop || isMobile ? [] : macPermissionItems(superQueue ?? [])');
    expect(surface).toContain('permissions: superPermissions, allows: superAllows, record: superRecord,');
  });

  it('a re-sent request or a new allow changes the publish key', () => {
    const a = permAllowKeyOf([item({})], [], 'main');
    expect(permAllowKeyOf([item({ requestId: 'r2' })], [], 'main')).not.toBe(a);
    expect(permAllowKeyOf([item({})], [{ sessionId: 'c1', entries: [{ at: 3, summary: 'ls' }] }], 'main')).not.toBe(a);
  });
});

describe('the Super\'s own allows fold into one line', () => {
  it('one entry per live job with allows, the newest last', () => {
    const logs = allowLogsOf({
      c1: { allows: [{ at: 9, summary: 'npm test' }] },
      c2: { allows: [{ at: 4, summary: 'ls', inFolder: true }] },
      c3: { allows: [] },
      c4: { allows: [{ at: 1, summary: 'x' }], endedAt: 10 },
    });
    expect(logs.map((l) => l.sessionId)).toEqual(['c2', 'c1']);
  });
  it('says "inside this job\'s own folder" only when every command stayed there', () => {
    expect(card).toContain("const folder = entries.every((e) => e.inFolder === true);");
    expect(card).toContain("return { key: `super.allows.${n === 1 ? 'one' : 'many'}${folder ? 'Folder' : ''}`, n };");
    expect(tail).toContain('<SuperAllowsLine');
  });
});
