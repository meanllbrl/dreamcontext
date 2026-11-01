import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The frame's open conversations (plan r9, D15): a load restores, never creates. */

const made = vi.hoisted(() => [] as Array<{ id: string; s: { status: string; busy: boolean; asking: boolean }; resume: boolean; reattach: string; disposed: boolean; emit: () => void }>);
vi.mock('../../dashboard/src/components/sleepy/chatSession', () => ({
  createChatSession: (_v: string, _b: boolean, _n: () => void, id: string, resume: boolean, ..._rest: unknown[]) => {
    const subs = new Set<() => void>();
    const items: unknown[] = [];
    const s = {
      claudeId: id, subscribe: (f: () => void) => { subs.add(f); return () => subs.delete(f); },
      getModel: () => ({ items }), dispose: () => { rec.disposed = true; }, status: 'open', busy: false, asking: false,
    };
    const rec = { id, s, resume, reattach: String(_rest[_rest.length - 1]), disposed: false, emit: () => { items.push({ id: 'x', kind: 'user' }); for (const f of subs) f(); } };
    made.push(rec);
    return s;
  },
}));

const { createAppChatStore } = await import('../../dashboard/src/components/embed/appChatStore');
const { appChatParam } = await import('../../dashboard/src/lib/chatAppBinding');
const grant = { tk: 'T', view: 'chat', slug: 'yuk', vault: 'v', member: null, insight: null, theme: null, colors: { bg: null, surface: null, text: null, accent: null } };

function server(chats: Array<{ id: string; title: string; closedAt: string | null }>, assistant = 'own') {
  const posts: Array<{ url: string; body: unknown }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) }); return new Response('{}'); }
    return new Response(JSON.stringify({ assistant, name: 'Yük', chats }));
  }) as unknown as typeof fetch;
  return { f, posts };
}

beforeEach(() => { made.length = 0; });

describe('a load', () => {
  it('restores the open rows, connects the first passively, and creates nothing', async () => {
    const s = server([{ id: 'a', title: 'One', closedAt: null }, { id: 'b', title: 'Two', closedAt: null }, { id: 'c', title: 'Old', closedAt: 'x' }]);
    const store = createAppChatStore(grant, s.f);
    await store.load();
    expect(store.snapshot().rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ id: 'a', resume: true, reattach: 'passive' });
    store.show('b');
    expect(made.map((m) => m.id)).toEqual(['a', 'b']);
    expect(store.snapshot().active).toBe('b');
  });
  it('no chat yet: one fresh row, a new session', async () => {
    const store = createAppChatStore(grant, server([]).f);
    await store.load();
    expect(store.snapshot().rows).toHaveLength(1);
    expect(made[0]).toMatchObject({ resume: false });
    expect(appChatParam(made[0].id)).toBe('&app=yuk&tk=T');
  });
  it('an app with no assistant opens nothing', async () => {
    const store = createAppChatStore(grant, server([], 'none').f);
    await store.load();
    expect(store.snapshot().assistant).toBe('none');
    expect(made).toHaveLength(0);
  });
  it('an old embed URL naming a member still chats', async () => {
    const store = createAppChatStore({ ...grant, member: 'ua' }, server([], 'none').f);
    await store.load();
    expect(store.snapshot().assistant).toBe('member');
    expect(appChatParam(made[0].id)).toContain('&member=ua');
  });
});

describe('a new chat', () => {
  it('reuses an empty row; once it holds something, opens another', async () => {
    const store = createAppChatStore(grant, server([]).f);
    await store.load();
    store.newChat();
    expect(store.snapshot().rows).toHaveLength(1);
    made[0].emit();
    store.newChat();
    expect(store.snapshot().rows).toHaveLength(2);
  });
});

describe('a refused row', () => {
  it('a new chat replaces it, and Resume starts over under a new id', async () => {
    const store = createAppChatStore(grant, server([]).f);
    await store.load();
    const first = store.snapshot().rows[0].id;
    made[0].s.status = 'closed';
    store.newChat();
    expect(store.snapshot().rows.map((r) => r.id)).not.toContain(first);
    expect(store.snapshot().rows).toHaveLength(1);
    const second = store.snapshot().rows[0].id;
    store.respawn(second);
    expect(store.snapshot().rows[0].id).not.toBe(second);
    expect(made[made.length - 1]).toMatchObject({ resume: false });
  });
});

describe('a row off screen', () => {
  it('shows it is working or waiting', async () => {
    const store = createAppChatStore(grant, server([]).f);
    await store.load();
    made[0].s.asking = true;
    made[0].emit();
    expect(store.snapshot().rows[0].state).toBe('asking');
  });
  it('an empty row from the server is reused after a reload', async () => {
    const store = createAppChatStore(grant, server([{ id: 'a', title: '', closedAt: null, empty: true } as never]).f);
    await store.load();
    store.newChat();
    expect(store.snapshot().rows).toHaveLength(1);
  });
});

describe('closing', () => {
  it('ends the session, says so to the server, and shows another', async () => {
    const s = server([{ id: 'a', title: '', closedAt: null }, { id: 'b', title: '', closedAt: null }]);
    const store = createAppChatStore(grant, s.f);
    await store.load();
    store.close('a');
    expect(made[0].disposed).toBe(true);
    expect(s.posts).toEqual([{ url: '/api/apps/yuk/chats/close', body: { id: 'a' } }]);
    expect(store.snapshot().active).toBe('b');
    expect(appChatParam('a')).toBe('');
  });
});
