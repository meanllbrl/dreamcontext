/**
 * The Super Agent's state shapes exist on both sides of the wire (plan-r7 W1): the server owns
 * the record and its validation (`src/lib/super/types.ts`), the window renders what is pushed
 * (`dashboard/src/lib/superTypes.ts`). A list that drifts silently is a container kind the
 * server stores and the window drops, or a queue state the window never draws. Pinned here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as server from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';

const ROOT = new URL('../../', import.meta.url).pathname;

describe('super types — server record <-> window mirror', () => {
  it('every list and limit matches, in order', () => {
    expect([...client.CONTAINER_KINDS]).toEqual([...server.CONTAINER_KINDS]);
    expect([...client.CONTAINER_SHAPES]).toEqual([...server.CONTAINER_SHAPES]);
    expect([...client.CONTAINER_PLACES]).toEqual([...server.CONTAINER_PLACES]);
    expect([...client.VIEW_MODES]).toEqual([...server.VIEW_MODES]);
    expect(client.MAX_PRESENT).toBe(server.MAX_PRESENT);
    for (const k of server.CONTAINER_KINDS) expect(client.defaultShape(k)).toBe(server.defaultShape(k));
    expect([...client.QUEUE_KINDS]).toEqual([...server.QUEUE_KINDS]);
    expect([...client.QUEUE_STATES]).toEqual([...server.QUEUE_STATES]);
    expect([...client.SUPER_NOTES]).toEqual([...server.SUPER_NOTES]);
    expect([...client.SUPER_WINDOW_VERBS]).toEqual([...server.SUPER_WINDOW_VERBS]);
    expect([...client.SUPER_EVENT_PREFIXES]).toEqual([...server.SUPER_EVENT_PREFIXES]);
    expect([...client.SUPER_EVENT_KINDS]).toEqual([...server.SUPER_EVENT_KINDS]);
    expect(client.MAX_CONTAINERS).toBe(server.MAX_CONTAINERS);
    expect(client.MAX_LIVE_CHILDREN).toBe(server.MAX_LIVE_CHILDREN);
    expect(client.SUPER_STATE_VERSION).toBe(server.SUPER_STATE_VERSION);
  });

  it('the limits are the owner\'s numbers: 12 containers, 8 live children', () => {
    expect(server.MAX_CONTAINERS).toBe(12);
    expect(server.MAX_LIVE_CHILDREN).toBe(8);
  });

  it('the window reads back exactly what the server would push', () => {
    const view: server.SuperStateView = {
      ...server.emptySuperState(),
      vault: 'acme-app',
      session: 'sess-super',
      enabled: true,
      containers: [
        { id: 'c1', kind: 'chat', ref: 'child-1', shape: 'tall', place: 'float', pos: { x: 0.25, y: 0.5 }, title: 'Login fix' },
        { id: 'c2', kind: 'task', ref: 'login', shape: 'square', place: 'others' },
      ],
      view: { mode: 'half', card: 'c1' },
      children: { 'child-1': { sessionId: 'child-1', brief: 'Fix the login form', adopted: true, startedAt: 1 } },
      queue: [{ id: 'q1', sessionId: 'child-1', kind: 'question', requestId: 'r1', state: 'pending', createdAt: 2 }],
      notes: { 'child-1': 'handover' },
      away: { since: 5, events: 2 },
    };
    expect(client.readSuperStateView(JSON.parse(JSON.stringify(view)))).toEqual(view);
  });

  it('a malformed push is no state at all, and a bad row is dropped, not half-rendered', () => {
    expect(client.readSuperStateView(null)).toBeNull();
    expect(client.readSuperStateView({ v: 2 })).toBeNull();
    const v = client.readSuperStateView({
      ...server.emptySuperState(), vault: 'acme-app', session: null,
      containers: [{ id: 'c1', kind: 'video', ref: 'x', shape: 'tall', place: 'float' }, { id: 'c2', kind: 'task', ref: 'x', shape: 'tall', place: 'float', pos: { x: 3, y: 0 } }],
      view: { mode: 'half', card: 'c1' },
      queue: [{ id: 'q', sessionId: 's', kind: 'permission', state: 'weird', createdAt: 1 }],
      notes: { s: 'hello' },
    });
    expect(v?.containers).toEqual([]);
    expect(v?.queue).toEqual([]);
    expect(v?.notes).toEqual({});
  });

  it('both files carry the MIRRORED comment that sends the next reader to the other one', () => {
    expect(readFileSync(join(ROOT, 'src/lib/super/types.ts'), 'utf-8')).toContain('dashboard/src/lib/superTypes.ts');
    expect(readFileSync(join(ROOT, 'dashboard/src/lib/superTypes.ts'), 'utf-8')).toContain('src/lib/super/types.ts');
  });
});
