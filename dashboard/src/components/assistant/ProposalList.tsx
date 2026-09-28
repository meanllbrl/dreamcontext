import { useState } from 'react';

/** One pending proposal (GET /api/assistant/proposals — src/lib/assistant/proposals.ts). */
export interface Proposal {
  id: string;
  verb: string;
  target: string;
  text: string;
  /** Why it waits for the owner: the `ask` level, project output read since they last spoke,
   *  or an answer to another agent's tool-permission prompt. */
  provenance: string;
  createdAt: string;
}

const VERB_LABEL: Record<string, string> = {
  send: 'Send a message',
  answer: 'Answer a question',
  broadcast: 'Tell every project',
};

async function decide(id: string, action: 'approve' | 'edit' | 'reject', text?: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/assistant/proposals/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function ProposalRow({ p, onDecided }: { p: Proposal; onDecided: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.text);
  const [busy, setBusy] = useState(false);
  const act = async (action: 'approve' | 'edit' | 'reject') => {
    setBusy(true);
    const ok = await decide(p.id, action, action === 'edit' ? draft : undefined);
    setBusy(false);
    if (ok) onDecided(p.id);
  };
  return (
    <li className="dc-proposal">
      <div className="dc-proposal__head">
        <span className="dc-proposal__verb">{VERB_LABEL[p.verb] ?? p.verb}</span>
        <span className="dc-proposal__target">{p.target}</span>
      </div>
      {editing
        ? <textarea className="dc-proposal__edit" value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
        : <p className="dc-proposal__text">{p.text}</p>}
      <p className="dc-proposal__why">Waiting because {p.provenance}.</p>
      <div className="dc-proposal__actions">
        {editing
          ? <button type="button" className="dc-proposal__btn dc-proposal__btn--primary" disabled={busy || !draft.trim()} onClick={() => void act('edit')}>Send edited</button>
          : <button type="button" className="dc-proposal__btn dc-proposal__btn--primary" disabled={busy} onClick={() => void act('approve')}>Approve</button>}
        <button type="button" className="dc-proposal__btn" disabled={busy} onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel edit' : 'Edit'}</button>
        <button type="button" className="dc-proposal__btn" disabled={busy} onClick={() => void act('reject')}>Reject</button>
      </div>
    </li>
  );
}

/** The actions the assistant wants to take that need the owner's yes first. */
export function ProposalList({ proposals, onDecided }: { proposals: Proposal[]; onDecided: (id: string) => void }) {
  return (
    <ul className="dc-proposals" aria-label="Waiting for your approval">
      {proposals.map((p) => <ProposalRow key={p.id} p={p} onDecided={onDecided} />)}
    </ul>
  );
}
