import { useEffect, useState } from 'react';
import { ago } from './notchModel';

/**
 * The Assistant's conversations: the notch holds ONE live conversation at a time (its socket is
 * the relay's channel), but every earlier one is a click away. This is that click — the hidden
 * vault's past chats (`GET /api/agent/chat-sessions`, scoped by header to `__assistant__`),
 * newest first, with "New" on top. Picking one resumes it in place; nothing is lost by "New".
 */

interface PastConversation { id: string; title: string; preview: string; updatedAt: number }

const LIMIT = 20;

async function listConversations(vault: string): Promise<PastConversation[]> {
  try {
    const res = await fetch(`/api/agent/chat-sessions?limit=${LIMIT}`, { headers: { 'X-Dreamcontext-Vault': vault } });
    const body = await res.json() as { sessions?: unknown };
    if (!Array.isArray(body.sessions)) return [];
    return body.sessions.flatMap((s): PastConversation[] => {
      const o = s as Record<string, unknown>;
      return typeof o.id === 'string'
        ? [{ id: o.id, title: typeof o.title === 'string' ? o.title : '', preview: typeof o.preview === 'string' ? o.preview : '', updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0 }]
        : [];
    });
  } catch {
    return [];
  }
}

export function ConversationMenu({ vault, currentId, onPick, onNew, onClose }: {
  vault: string;
  currentId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<PastConversation[] | null>(null);
  useEffect(() => {
    let alive = true;
    void listConversations(vault).then((r) => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, [vault]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="dc-convos" role="menu" aria-label="Conversations">
      <button type="button" role="menuitem" className="dc-convos__row dc-convos__new" onClick={onNew}>
        <span className="dc-convos__title">New conversation</span>
        <span className="dc-convos__meta">the current one stays here</span>
      </button>
      {rows === null && <p className="dc-convos__empty">Loading…</p>}
      {rows?.length === 0 && <p className="dc-convos__empty">No earlier conversations yet.</p>}
      {rows?.map((r) => (
        <button
          key={r.id}
          type="button"
          role="menuitem"
          className="dc-convos__row"
          aria-current={r.id === currentId || undefined}
          onClick={() => (r.id === currentId ? onClose() : onPick(r.id))}
        >
          <span className="dc-convos__title">{r.title || r.preview || 'Untitled'}</span>
          <span className="dc-convos__meta">{r.id === currentId ? 'now' : ago(r.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}
