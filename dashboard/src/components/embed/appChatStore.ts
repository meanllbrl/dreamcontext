import { createChatSession, type ChatSession } from '../sleepy/chatSession';
import { DEFAULT_CHAT_MODE } from '../../lib/chatModes';
import { bindAppChat, unbindAppChat } from '../../lib/chatAppBinding';
import { parseChatActions } from '../sleepy/chat/chatActions';
import type { EmbedGrant } from '../../lib/frameGuard';

/**
 * The open conversations of one app's frame (plan r9, D15): `stageSession.ts`'s shape for N
 * sessions, held outside React so switching rows keeps each conversation running.
 *
 * The server's list is the truth. A load restores the open rows and reuses an empty one, so
 * reloading a page creates nothing new. A row connects when it is first shown: every connection
 * is a child, and six idle children are six snapshots.
 */

export interface AppChatRow {
  id: string;
  title: string;
  session: ChatSession | null;
  /** Nothing was said here yet: the row a new chat reuses. */
  fresh: boolean;
}

export interface AppChatState {
  ready: boolean;
  /** Who talks: `none` keeps today's screen. */
  assistant: 'own' | 'member' | 'none' | null;
  name: string;
  rows: AppChatRow[];
  active: string | null;
  error: string | null;
}

export interface AppChatStore {
  subscribe: (fn: () => void) => () => void;
  snapshot: () => AppChatState;
  load: () => Promise<void>;
  newChat: () => void;
  show: (id: string) => void;
  /** A past conversation from the history: back on the row. */
  reopen: (id: string, title: string) => void;
  close: (id: string) => void;
  /** Resume after the Session ended banner. */
  respawn: (id: string) => void;
}

interface ListedChat { id: string; title: string; closedAt: string | null }

export function createAppChatStore(grant: EmbedGrant, fetchImpl: typeof fetch = (...a) => window.fetch(...a)): AppChatStore {
  let state: AppChatState = { ready: false, assistant: null, name: '', rows: [], active: null, error: null };
  const listeners = new Set<() => void>();
  const readTitles = new Map<string, Set<string>>();
  const headers = { 'x-dc-embed': grant.tk, 'x-dreamcontext-vault': grant.vault };
  const set = (patch: Partial<AppChatState>): void => {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  };
  const patchRow = (id: string, patch: Partial<AppChatRow>): void => {
    set({ rows: state.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  };
  const post = (path: string, body: unknown): void => {
    void fetchImpl(`/api/apps/${encodeURIComponent(grant.slug)}/chats/${path}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => { /* the next load reads the truth */ });
  };
  const watch = (id: string, s: ChatSession): void => {
    const off = s.subscribe(() => {
      const row = state.rows.find((r) => r.id === id);
      if (!row || row.session !== s) { off(); return; }
      const items = s.getModel().items;
      if (row.fresh && items.length) patchRow(id, { fresh: false });
      const read = readTitles.get(id) ?? new Set<string>();
      readTitles.set(id, read);
      let title: string | null = null;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (read.has(it.id)) break;
        if (it.kind !== 'text' || !it.done) continue;
        read.add(it.id);
        if (title !== null || !it.text.includes('dream-view')) continue;
        const view = parseChatActions(it.text).views.filter((v) => v.type === 'title').pop();
        if (view?.type === 'title') title = view.text;
      }
      if (title && title !== row.title) {
        patchRow(id, { title });
        post('title', { id, title });
      }
    });
  };
  const connect = (id: string, resume: boolean): ChatSession => {
    bindAppChat(id, { slug: grant.slug, tk: grant.tk, member: grant.member });
    const s = createChatSession(grant.vault, false, () => { /* the store subscribes itself */ }, id, resume, '', '', '', '', false, DEFAULT_CHAT_MODE, '', '', null, resume ? 'passive' : '');
    watch(id, s);
    return s;
  };
  const showRow = (id: string, resume: boolean): void => {
    const row = state.rows.find((r) => r.id === id);
    if (!row) return;
    if (!row.session) patchRow(id, { session: connect(id, resume) });
    set({ active: id });
  };

  return {
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    snapshot: () => state,
    load: async () => {
      if (state.ready) return;
      try {
        const r = await fetchImpl(`/api/apps/${encodeURIComponent(grant.slug)}/chats`, { headers });
        if (!r.ok) throw new Error(String(r.status));
        const body = await r.json() as { assistant: AppChatState['assistant']; name: string; chats: ListedChat[] };
        const rows = body.chats.filter((c) => !c.closedAt).map((c) => ({ id: c.id, title: c.title, session: null, fresh: false }));
        // An app with no agent of its own, opened by an old embed URL naming a member, chats too.
        const assistant = body.assistant === 'none' && grant.member ? 'member' : body.assistant;
        set({ ready: true, assistant, name: body.name, rows });
        if (assistant === 'none') return;
        if (rows.length) showRow(rows[0].id, true);
        else {
          const id = crypto.randomUUID();
          set({ rows: [{ id, title: '', session: null, fresh: true }] });
          showRow(id, false);
        }
      } catch {
        set({ ready: true, error: 'load' });
      }
    },
    newChat: () => {
      const empty = state.rows.find((r) => r.fresh);
      if (empty) { set({ active: empty.id }); return; }
      const id = crypto.randomUUID();
      set({ rows: [...state.rows, { id, title: '', session: null, fresh: true }] });
      showRow(id, false);
    },
    show: (id) => showRow(id, true),
    reopen: (id, title) => {
      if (!state.rows.some((r) => r.id === id)) set({ rows: [...state.rows, { id, title, session: null, fresh: false }] });
      showRow(id, true);
    },
    close: (id) => {
      const row = state.rows.find((r) => r.id === id);
      if (!row) return;
      row.session?.dispose();
      unbindAppChat(id);
      post('close', { id });
      const rows = state.rows.filter((r) => r.id !== id);
      set({ rows, active: state.active === id ? rows[rows.length - 1]?.id ?? null : state.active });
      if (state.active) showRow(state.active, true);
      if (!rows.length) {
        const fresh = crypto.randomUUID();
        set({ rows: [{ id: fresh, title: '', session: null, fresh: true }] });
        showRow(fresh, false);
      }
    },
    respawn: (id) => {
      const row = state.rows.find((r) => r.id === id);
      if (!row) return;
      row.session?.dispose();
      patchRow(id, { session: connect(id, true) });
    },
  };
}
