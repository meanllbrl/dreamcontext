import { useState } from 'react';
import { ago, glanceStatus, handoffPhase, type GlanceChat, type Handoff } from './notchModel';

/**
 * The open notch's "what is happening" rows (GET /api/assistant/glance): one per chat that is
 * asking or working, asking first. A permission prompt is answered RIGHT HERE (Allow / Deny,
 * Y / N from the keyboard — Notch.tsx owns the keys); anything else opens that project's chat.
 */

/** POST /api/assistant/answer — the owner's own Allow / Deny on a project's permission prompt. */
export async function answerPermission(c: Pick<GlanceChat, 'sessionId' | 'ask'>, choice: 'allow' | 'deny'): Promise<boolean> {
  if (!c.ask) return false;
  try {
    const res = await fetch('/api/assistant/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: c.sessionId, question: c.ask.id, choice }),
    });
    return res.ok && (await res.json() as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/** Bring the project that holds this chat to the front (the same relay a detail button rides). */
export function openProject(vault: string): void {
  void fetch('/api/assistant/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vault }),
  }).catch(() => { /* the row stays; the next click retries */ });
}

function GlanceRow({ c, keyed, onAnswered }: { c: GlanceChat; keyed: boolean; onAnswered: (sessionId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const permission = c.ask?.kind === 'permission';
  const act = async (choice: 'allow' | 'deny') => {
    setBusy(true);
    setFailed(false);
    const ok = await answerPermission(c, choice);
    setBusy(false);
    if (ok) onAnswered(c.sessionId); else setFailed(true);
  };
  return (
    <li className="dc-glance__row" data-activity={c.activity}>
      <button type="button" className="dc-glance__head" onClick={() => openProject(c.vault)} title={`Open ${c.vault}`}>
        <span className="dc-glance__dot" aria-hidden />
        <span className="dc-glance__vault">{c.vault}</span>
        <span className="dc-glance__status">{glanceStatus(c)}</span>
        {c.title && !c.ask && <span className="dc-glance__title">{c.title}</span>}
      </button>
      {c.ask && (
        <div className="dc-glance__ask">
          {c.ask.text && <code className="dc-glance__cmd">{c.ask.tool && permission ? `${c.ask.tool} · ` : ''}{c.ask.text}</code>}
          {permission ? (
            <div className="dc-glance__actions">
              <button type="button" className="dc-glance__btn" disabled={busy} onClick={() => void act('deny')}>
                Deny{keyed && <kbd>N</kbd>}
              </button>
              <button type="button" className="dc-glance__btn dc-glance__btn--primary" disabled={busy} onClick={() => void act('allow')}>
                Allow{keyed && <kbd>Y</kbd>}
              </button>
              {failed && <span className="dc-glance__fail">Couldn't reach {c.vault}. Open it to answer.</span>}
            </div>
          ) : (
            <div className="dc-glance__actions">
              <button type="button" className="dc-glance__btn" onClick={() => openProject(c.vault)}>Answer in {c.vault}</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function GlanceList({ chats, onAnswered }: { chats: GlanceChat[]; onAnswered: (sessionId: string) => void }) {
  // The keys answer the FIRST permission prompt only, so the chips appear on that row alone.
  const keyedId = chats.find((c) => c.ask?.kind === 'permission')?.sessionId;
  return (
    <ul className="dc-glance" aria-label="Your projects right now">
      {chats.map((c) => <GlanceRow key={c.sessionId} c={c} keyed={c.sessionId === keyedId} onAnswered={onAnswered} />)}
    </ul>
  );
}

/** POST /api/assistant/delegations/dismiss — clear a closed hand-off from the notch. */
export function dismissHandoff(sessionId: string): void {
  void fetch('/api/assistant/delegations/dismiss', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }),
  }).catch(() => { /* it ages out within the hour anyway */ });
}

const PHASE_LABEL = { running: 'on it', waiting: 'waiting on you', done: 'done', closed: 'closed' } as const;

function HandoffRow({ h, onAnswered, onDismiss }: { h: Handoff; onAnswered: (sessionId: string) => void; onDismiss: (sessionId: string) => void }) {
  const phase = handoffPhase(h);
  const [open, setOpen] = useState(phase === 'waiting');
  const [busy, setBusy] = useState(false);
  const act = async (choice: 'allow' | 'deny') => {
    setBusy(true);
    const ok = await answerPermission(h, choice);
    setBusy(false);
    if (ok) onAnswered(h.sessionId);
  };
  const detail = h.ask?.text || h.lastText;
  return (
    <li className="dc-handoff" data-phase={phase}>
      <button type="button" className="dc-handoff__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="dc-glance__dot" aria-hidden />
        <span className="dc-glance__vault">{h.vault}</span>
        <span className="dc-handoff__brief">{h.brief || 'a follow-up'}</span>
        <span className="dc-handoff__phase">{PHASE_LABEL[phase]}</span>
        <span className="dc-handoff__ago">{ago(h.endedAt ?? h.startedAt)}</span>
      </button>
      {open && (
        <div className="dc-handoff__body">
          {detail && <p className="dc-handoff__text">{detail}</p>}
          <div className="dc-glance__actions">
            {h.ask?.kind === 'permission' && (
              <>
                <button type="button" className="dc-glance__btn" disabled={busy} onClick={() => void act('deny')}>Deny</button>
                <button type="button" className="dc-glance__btn dc-glance__btn--primary" disabled={busy} onClick={() => void act('allow')}>Allow</button>
              </>
            )}
            {phase !== 'closed' && <button type="button" className="dc-glance__btn" onClick={() => openProject(h.vault)}>Open {h.vault}</button>}
            {phase === 'closed' && <button type="button" className="dc-glance__btn" onClick={() => onDismiss(h.sessionId)}>Clear</button>}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * What the Assistant handed off: one row per project chat it started or wrote into — the brief
 * it gave, where that stands, and (opened) the project's last reply. Closed ones linger an hour.
 */
export function HandoffList({ handoffs, onAnswered, onDismiss }: {
  handoffs: Handoff[];
  onAnswered: (sessionId: string) => void;
  onDismiss: (sessionId: string) => void;
}) {
  return (
    <section className="dc-handoffs" aria-label="Handed off">
      <h3 className="dc-notch__section">Handed off</h3>
      <ul>
        {handoffs.map((h) => <HandoffRow key={h.sessionId} h={h} onAnswered={onAnswered} onDismiss={onDismiss} />)}
      </ul>
    </section>
  );
}
