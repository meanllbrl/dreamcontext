/**
 * `lib/openAgents.ts` (plan-r10 1c, 1d; Wave 3 lane C): `requestOpenAgents({ slug, task? })` opens a
 * member's stage (with its task strip), `{ create }` / `{ whiteboard }` and a bare request open
 * "Üyeleri yönet", and `requestManageMembers(...)` opens the modal. A bad slug or task is dropped.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MANAGE_MEMBERS_EVENT, OPEN_AGENTS_EVENT, OPEN_TASK_SLUG, readManageMembersDetail, readOpenAgentsDetail,
  requestManageMembers, requestOpenAgents, routeOpenAgents,
} from '../../dashboard/src/lib/openAgents';

describe('readOpenAgentsDetail', () => {
  it('accepts a member with a task', () => {
    expect(readOpenAgentsDetail({ slug: 'rota', task: 'fiyat-sayfasi-metni' })).toEqual({ slug: 'rota', task: 'fiyat-sayfasi-metni' });
  });

  it('accepts a task slug far past 64 characters (task slugs reach ~100)', () => {
    const long = `wave-3-${'a'.repeat(120)}`;
    expect(readOpenAgentsDetail({ slug: 'rota', task: long })).toEqual({ slug: 'rota', task: long });
    expect(OPEN_TASK_SLUG.test('a'.repeat(253))).toBe(false);
  });

  it('drops a bad task but still opens the member', () => {
    for (const task of ['../etc', 'Bad Slug', '-leading', '', 7, null, 'a/b']) {
      expect(readOpenAgentsDetail({ slug: 'rota', task })).toEqual({ slug: 'rota' });
    }
  });

  it('drops a bad slug, and a task without a member', () => {
    for (const slug of ['../x', 'Rota', 'a--b', '-a', 'a'.repeat(101), 3]) {
      expect(readOpenAgentsDetail({ slug, task: 'ok' })).toEqual({});
    }
    expect(readOpenAgentsDetail({ task: 'ok' })).toEqual({});
    expect(readOpenAgentsDetail(null)).toEqual({});
    expect(readOpenAgentsDetail('rota')).toEqual({});
  });

  it('keeps the create flow and its board', () => {
    expect(readOpenAgentsDetail({ create: true, whiteboard: 'growth-board' })).toEqual({ create: true, whiteboard: 'growth-board' });
    expect(readOpenAgentsDetail({ whiteboard: 'growth-board' })).toEqual({});
  });
});

describe('routeOpenAgents', () => {
  it('a member, with or without a task, opens its stage', () => {
    expect(routeOpenAgents({ slug: 'rota' })).toEqual({ to: 'member', slug: 'rota' });
    expect(routeOpenAgents({ slug: 'rota', task: 't-1' })).toEqual({ to: 'member', slug: 'rota', task: 't-1' });
  });

  it('create, a board and a bare request open "Üyeleri yönet"', () => {
    expect(routeOpenAgents({ create: true })).toEqual({ to: 'manage', detail: { create: true } });
    expect(routeOpenAgents({ create: true, whiteboard: 'b' })).toEqual({ to: 'manage', detail: { create: true, whiteboard: 'b' } });
    expect(routeOpenAgents({})).toEqual({ to: 'manage', detail: {} });
    expect(routeOpenAgents(readOpenAgentsDetail({ whiteboard: 'b' }))).toEqual({ to: 'manage', detail: {} });
  });
});

describe('the window events', () => {
  const heard: Array<{ type: string; detail: unknown }> = [];
  const target = new EventTarget();
  const on = (type: string) => target.addEventListener(type, (e) => heard.push({ type, detail: (e as CustomEvent).detail }));
  on(OPEN_AGENTS_EVENT);
  on(MANAGE_MEMBERS_EVENT);
  vi.stubGlobal('window', target);
  // Node 18 has no global CustomEvent.
  if (typeof CustomEvent === 'undefined') {
    vi.stubGlobal('CustomEvent', class extends Event {
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { super(type); this.detail = init?.detail; }
    });
  }
  afterEach(() => { heard.length = 0; });

  it('requestOpenAgents sends the checked detail', () => {
    requestOpenAgents({ slug: 'rota', task: 'BAD' });
    requestOpenAgents({ slug: 'rota', task: 'good-one' });
    expect(heard).toEqual([
      { type: OPEN_AGENTS_EVENT, detail: { slug: 'rota' } },
      { type: OPEN_AGENTS_EVENT, detail: { slug: 'rota', task: 'good-one' } },
    ]);
  });

  it('requestManageMembers opens the modal, on a member when given, never with a task', () => {
    requestManageMembers();
    requestManageMembers({ slug: 'rota' });
    requestManageMembers({ create: true, whiteboard: 'growth-board' });
    requestManageMembers({ slug: '../x' });
    expect(heard).toEqual([
      { type: MANAGE_MEMBERS_EVENT, detail: {} },
      { type: MANAGE_MEMBERS_EVENT, detail: { slug: 'rota' } },
      { type: MANAGE_MEMBERS_EVENT, detail: { create: true, whiteboard: 'growth-board' } },
      { type: MANAGE_MEMBERS_EVENT, detail: {} },
    ]);
    expect(readManageMembersDetail({ slug: 'rota', task: 'x' })).toEqual({ slug: 'rota' });
  });
});
