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
  /** An agent's app request (src/lib/assistant/proposals.ts `AppCardView`): the card body. */
  app?: AppCard;
}

/** What an app request card shows. Labels are the server's words; agent text only in values. */
export interface AppCard {
  action: 'publish' | 'update' | 'install' | 'logo';
  appName: string;
  vault: string;
  title: string;
  lines: Array<{ label: string; value: string; tone?: 'warn' | 'bad' }>;
  warn?: string;
  image?: string;
  renewal?: boolean;
  hash: string;
}

const VERB_LABEL: Record<string, string> = {
  send: 'Send a message',
  answer: 'Answer a question',
  broadcast: 'Tell every project',
  'app-open': 'Open an app',
  'app-do': 'Run an app action',
  'app-shot': 'See an app window',
  // A dreamcontext App asks to use a project .mcp.json server with its own keys. Not an
  // assistant verb: approved by a click only (no Y), never edited (the pin is what was shown).
  'app-mcp-accept': 'Let an app use an MCP server',
};

/** An agent's app request (app-onay-karti): publish, update, install or logo. */
export const APP_REQUEST_VERBS: ReadonlySet<string> = new Set(['app-publish', 'app-update', 'app-install', 'app-logo']);

/** Proposals the owner answers only with a click: no Y shortcut, no Edit. An app request takes
 *  neither Y nor N: its decide carries the card's hash, a key press would not. */
export const CLICK_ONLY_VERBS: ReadonlySet<string> = new Set(['app-mcp-accept', ...APP_REQUEST_VERBS]);

/** `gone`: it was decided or timed out already. `refused`: a yes takes the shell's key, and this
 *  app has none to give; rejecting still works. */
export type DecideOutcome = 'ok' | 'gone' | 'refused' | 'unreachable' | 'changed' | 'stale';

/** `hash`: an app request card's own hash, sent on Onayla AND Reddet (the server checks it). */
export async function decide(id: string, action: 'approve' | 'edit' | 'reject', text?: string, hash?: string): Promise<DecideOutcome> {
  try {
    const key = await ownerKey();
    const res = await fetch(`/api/assistant/proposals/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Dreamcontext-Owner-Key': key } : {}) }, body: JSON.stringify({ action, text, ...(hash ? { hash } : {}) }),
    });
    if (res.ok) return 'ok';
    const body = await res.json().catch(() => null) as { error?: string } | null;
    if (body?.error === 'unknown_proposal' || body?.error === 'not_pending' || body?.error === 'unknown') return 'gone';
    if (body?.error === 'card_changed') return 'changed';
    if (body?.error === 'stale_request') return 'stale';
    return body?.error === 'owner_page_only' ? 'refused' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

const APP_FAILURE: Partial<Record<DecideOutcome, string>> = {
  changed: 'Kart değişti. Yeniden bak.',
  stale: 'App bu kart açıldıktan sonra değişti; hiçbir şey onaylanmadı. Agent yeniden sorar.',
  refused: 'Onaylamak için uygulamanın yeni sürümü gerekiyor. Güncelle ya da reddet.',
  unreachable: 'Karar verilemedi. Kart hâlâ bekliyor.',
};

/** An agent's app request: the plan as lines, a red line for what cannot be undone, Onayla/Reddet. */
function AppRequestRow({ p, failure, onDecided }: { p: Proposal & { app: AppCard }; failure?: DecideOutcome; onDecided: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [ownFailure, setOwnFailure] = useState<DecideOutcome | undefined>();
  const failed = ownFailure ?? failure;
  const a = p.app;
  const act = async (action: 'approve' | 'reject') => {
    setBusy(true);
    setOwnFailure(undefined);
    const outcome = await decide(p.id, action, undefined, a.hash);
    setBusy(false);
    // A stale card is closed by the server: it leaves the list like a decided one.
    if (outcome === 'ok' || outcome === 'gone' || outcome === 'stale') onDecided(p.id); else setOwnFailure(outcome);
  };
  const image = a.image ? `${a.image}?vault=${encodeURIComponent(a.vault)}` : null;
  return (
    <li className="dc-proposal dc-proposal--app" data-action={a.action}>
      <p className="dc-proposal__eyebrow">{a.renewal ? 'Süresi doldu' : 'Onayını bekliyor'}</p>
      <div className="dc-proposal__head">
        <span className="dc-proposal__verb">{a.title}</span>
        <span className="dc-proposal__target">{a.appName}</span>
      </div>
      {image && <img className="dc-proposal__image" src={image} alt={`${a.appName} için yeni logo`} />}
      <dl className="dc-proposal__lines">
        {a.lines.map((l, i) => (
          <div key={i} className="dc-proposal__line" data-tone={l.tone}>
            <dt>{l.label}</dt>
            <dd>{l.value}</dd>
          </div>
        ))}
      </dl>
      {a.warn && <p className="dc-proposal__warn" role="note">{a.warn}</p>}
      <p className="dc-proposal__why">Onaylarsan agent bunu bir kez yapar. Başka bir işi bu onayla yapamaz.</p>
      <div className="dc-proposal__actions">
        {failed !== 'refused' && <button type="button" className="dc-proposal__btn dc-proposal__btn--primary" disabled={busy} onClick={() => void act('approve')}>Onayla</button>}
        <button type="button" className="dc-proposal__btn" disabled={busy} onClick={() => void act('reject')}>Reddet</button>
        {failed && APP_FAILURE[failed] && <span className="dc-glance__fail" role="alert">{APP_FAILURE[failed]}</span>}
      </div>
    </li>
  );
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
              : <button type="button" className="dc-proposal__btn dc-proposal__btn--primary" disabled={busy} onClick={() => void act('approve')}>Approve{keyed && !CLICK_ONLY_VERBS.has(p.verb) && <kbd>Y</kbd>}</button>}
            {!CLICK_ONLY_VERBS.has(p.verb) && <button type="button" className="dc-proposal__btn" disabled={busy} onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel edit' : 'Edit'}</button>}
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
      {proposals.map((p, i) => p.app && APP_REQUEST_VERBS.has(p.verb)
        ? <AppRequestRow key={p.id} p={p as Proposal & { app: AppCard }} failure={p.id === failure?.id ? failure.outcome : undefined} onDecided={onDecided} />
        : <ProposalRow key={p.id} p={p} keyed={keyed && i === 0} failure={p.id === failure?.id ? failure.outcome : undefined} onDecided={onDecided} />)}
    </ul>
  );
}
