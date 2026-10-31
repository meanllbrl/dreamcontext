import { useState } from 'react';
import { ownerKey } from '../../lib/desktop';

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

/** `gone`: it was decided or timed out already. `refused`: a yes takes the shell's key, and this
 *  app has none to give; rejecting still works. */
export type DecideOutcome = 'ok' | 'gone' | 'refused' | 'unreachable';

export async function decide(id: string, action: 'approve' | 'edit' | 'reject', text?: string): Promise<DecideOutcome> {
  try {
    const key = await ownerKey();
    const res = await fetch(`/api/assistant/proposals/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Dreamcontext-Owner-Key': key } : {}) }, body: JSON.stringify({ action, text }),
    });
    if (res.ok) return 'ok';
    const body = await res.json().catch(() => null) as { error?: string } | null;
    if (body?.error === 'unknown_proposal') return 'gone';
    return body?.error === 'owner_page_only' ? 'refused' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

function ProposalRow({ p, keyed, failure, onDecided }: { p: Proposal; keyed: boolean; failure?: DecideOutcome; onDecided: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.text);
  const [busy, setBusy] = useState(false);
  const [ownFailure, setOwnFailure] = useState<DecideOutcome | undefined>();
  const failed = ownFailure ?? failure;
  const act = async (action: 'approve' | 'edit' | 'reject') => {
    setBusy(true);
    setOwnFailure(undefined);
    const outcome = await decide(p.id, action, action === 'edit' ? draft : undefined);
    setBusy(false);
    if (outcome === 'ok' || outcome === 'gone') onDecided(p.id); else setOwnFailure(outcome);
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
        {failed !== 'refused' && (
          <>
            {editing
              ? <button type="button" className="dc-proposal__btn dc-proposal__btn--primary" disabled={busy || !draft.trim()} onClick={() => void act('edit')}>Send edited</button>
              : <button type="button" className="dc-proposal__btn dc-proposal__btn--primary" disabled={busy} onClick={() => void act('approve')}>Approve{keyed && <kbd>Y</kbd>}</button>}
            <button type="button" className="dc-proposal__btn" disabled={busy} onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel edit' : 'Edit'}</button>
          </>
        )}
        <button type="button" className="dc-proposal__btn" disabled={busy} onClick={() => void act('reject')}>Reject{keyed && !editing && <kbd>N</kbd>}</button>
        {failed && <span className="dc-glance__fail" role="alert">{failed === 'refused' ? 'Approving needs a newer app. Update it, or reject this.' : 'Couldn\'t decide this. It is still waiting.'}</span>}
      </div>
    </li>
  );
}

/** The actions the assistant wants to take that need the owner's yes first. */
/** `keyed`: Y / N act on the first proposal (Notch.tsx owns the keys), so its row shows them. */
export function ProposalList({ proposals, keyed = false, failure, onDecided }: { proposals: Proposal[]; keyed?: boolean; failure?: { id: string; outcome: DecideOutcome } | null; onDecided: (id: string) => void }) {
  return (
    <ul className="dc-proposals" aria-label="Waiting for your approval">
      {proposals.map((p, i) => <ProposalRow key={p.id} p={p} keyed={keyed && i === 0} failure={p.id === failure?.id ? failure.outcome : undefined} onDecided={onDecided} />)}
    </ul>
  );
}
