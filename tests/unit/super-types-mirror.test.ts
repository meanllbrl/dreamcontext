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
    expect([...client.PAD_SECTIONS]).toEqual([...server.PAD_SECTIONS]);
    expect([client.MAX_PAD, client.MAX_PAD_TEXT]).toEqual([server.MAX_PAD, server.MAX_PAD_TEXT]);
    expect([client.AGENDA_REF, client.AGENDA_SIZE]).toEqual([server.AGENDA_REF, server.AGENDA_SIZE]);
    expect([...client.CONTAINER_SHAPES]).toEqual([...server.CONTAINER_SHAPES]);
    expect([...client.CONTAINER_SIZES]).toEqual([...server.CONTAINER_SIZES]);
    expect(client.SIZE_UNITS).toEqual(server.SIZE_UNITS);
    expect([...client.CONTAINER_PLACES]).toEqual([...server.CONTAINER_PLACES]);
    expect([...client.VIEW_MODES]).toEqual([...server.VIEW_MODES]);
    expect(client.MAX_PRESENT).toBe(server.MAX_PRESENT);
    for (const k of server.CONTAINER_KINDS) expect(client.defaultShape(k)).toBe(server.defaultShape(k));
    expect([...client.QUEUE_KINDS]).toEqual([...server.QUEUE_KINDS]);
    expect([...client.QUEUE_STATES]).toEqual([...server.QUEUE_STATES]);
    expect([...client.TEAM_JOB_STATUSES]).toEqual([...server.TEAM_JOB_STATUSES]);
    expect(client.MAX_TEAM_JOBS).toBe(server.MAX_TEAM_JOBS);
    expect([...client.SUPER_NOTES]).toEqual([...server.SUPER_NOTES]);
    expect([...client.SUPER_WINDOW_VERBS]).toEqual([...server.SUPER_WINDOW_VERBS]);
    expect([...client.SUPER_EVENT_PREFIXES]).toEqual([...server.SUPER_EVENT_PREFIXES]);
    expect([...client.SUPER_EVENT_KINDS]).toEqual([...server.SUPER_EVENT_KINDS]);
    expect(client.MAX_CONTAINERS).toBe(server.MAX_CONTAINERS);
    expect(client.MAX_FLOAT).toBe(server.MAX_FLOAT);
    expect(client.MAX_DISMISSED).toBe(server.MAX_DISMISSED);
    expect(client.MAX_LIVE_CHILDREN).toBe(server.MAX_LIVE_CHILDREN);
    expect(client.SUPER_STATE_VERSION).toBe(server.SUPER_STATE_VERSION);
    expect(String(client.GROUP_ID_RE)).toBe(String(server.GROUP_ID_RE));
    expect(client.MAX_GROUP_NAME).toBe(server.MAX_GROUP_NAME);
    expect(client.MIN_GROUP_CARDS).toBe(server.MIN_GROUP_CARDS);
  });

  it('the group rules are one code on both sides (the window applies the owner\'s drop before the server echoes it)', () => {
    const block = (file: string) => {
      const src = readFileSync(join(ROOT, file), 'utf-8');
      return src.slice(src.indexOf('const isObj = '), src.indexOf('state.groups = state.groups.filter((g) => !ids.includes(g.id));'));
    };
    expect(block('dashboard/src/lib/superTypes.ts')).toBe(block('src/lib/super/types.ts'));
    const cards = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, kind: 'chat' as const, ref: id, shape: 'square' as const, place: 'float' as const, ...(i === 3 ? { pos: { x: 0.2, y: 0.3 } } : {}) }));
    const fixtures: unknown[] = [
      [{ id: 'grp-1', name: 'Forms', cards: ['a', 'b'], place: 'float' }],
      [{ id: 'grp-1', name: '', cards: ['a', 'zzz'], place: 'others', pos: { x: 2, y: -1 } }],
      [{ id: 'grp-1', cards: ['a', 'b'] }, { id: 'grp-2', cards: ['b', 'c', 'd'] }, { id: 'grp-1', cards: ['c', 'd'] }, { id: 'bad', cards: ['c', 'd'] }],
      'nonsense',
    ];
    for (const f of fixtures) expect(client.normalizeGroups(cards, f)).toEqual(server.normalizeGroups(cards, f));
    const run = (lib: typeof server | typeof client) => {
      const st = lib.normalizeGroups(cards, []);
      lib.applyGroupOp(st, { id: 'grp-x', cards: ['d', 'a'] });
      lib.applyGroupOp(st, { id: 'grp-x', cards: ['b'], name: '  Ödev\nformları ' });
      lib.applyGroupOp(st, { id: 'grp-y', cards: ['b', 'c'] });
      lib.leaveGroups(st, ['a']);
      const mid = JSON.parse(JSON.stringify(st));
      lib.dissolveGroups(st, ['grp-y']);
      return { mid, end: lib.normalizeGroups(st.containers, st.groups) };
    };
    expect(run(client)).toEqual(run(server));
  });

  it('the limits are the owner\'s numbers: 12 floating items on the stage, 48 cards in the record, 15 live children', () => {
    expect(server.MAX_FLOAT).toBe(12);
    expect(server.MAX_CONTAINERS).toBe(48);
    expect(server.MAX_LIVE_CHILDREN).toBe(15);
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
        { id: 'c3', kind: 'browser', ref: 'child-1', shape: 'square', place: 'float', by: 'auto' },
      ],
      view: { mode: 'half', card: 'c1' },
      children: { 'child-1': { sessionId: 'child-1', brief: 'Fix the login form', adopted: true, startedAt: 1 } },
      queue: [{ id: 'q1', sessionId: 'child-1', kind: 'question', requestId: 'r1', state: 'pending', createdAt: 2 }],
      groups: [{ id: 'grp-1', name: 'Pair', cards: ['c1', 'c2'], place: 'float', pos: { x: 0.5, y: 0 } }],
      notes: { 'child-1': 'handover' },
      away: { since: 5, events: 2 },
      dismissed: [{ kind: 'web', ref: 'http://localhost:5173/', until: 99 }],
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
