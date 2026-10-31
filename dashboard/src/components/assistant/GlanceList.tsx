import { useEffect, useRef, useState } from 'react';
import { ago, glanceStatus, handoffPhase, type GlanceChat, type Handoff } from './notchModel';
import { openChat } from './InboxList';
import { SuperAgentIcon } from '../layout/NavIcons';
import { ownerKey } from '../../lib/desktop';

/**
 * The open notch's "what is happening" rows (GET /api/assistant/glance): one per chat that is
 * asking or working, asking first. A permission prompt is answered RIGHT HERE (Allow / Deny,
 * Y / N from the keyboard — Notch.tsx owns the keys); anything else opens that project's chat.
 */

/** `refused`: the server will not take an answer from here, and no retry changes that (no key
 *  from an older shell, a browser sending no Fetch Metadata). `stale`: this prompt is not the open
 *  one any more, so the row is out of date and the next poll draws what is. */
export type AnswerOutcome = 'ok' | 'stale' | 'refused' | 'unreachable';
/** A failed answer, tied to the prompt it was for: a new prompt starts clean. */
export interface AnswerFailure { ask: string; outcome: 'refused' | 'unreachable' }

/** What a failed answer tells the owner: the chat's own card always still answers. */
export function answerFailureText(outcome: AnswerFailure['outcome'], vault: string): string {
  return outcome === 'refused' ? `This can't be answered here. Answer it in ${vault}.` : `Couldn't reach ${vault}. Open it to answer.`;
}

/** POST /api/assistant/answer — the owner's own Allow / Deny on a project's permission prompt. */
export async function answerPermission(c: Pick<GlanceChat, 'sessionId' | 'ask'>, choice: 'allow' | 'deny'): Promise<AnswerOutcome> {
  if (!c.ask) return 'unreachable';
  try {
    const key = await ownerKey();
    const res = await fetch('/api/assistant/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Dreamcontext-Owner-Key': key } : {}) },
      body: JSON.stringify({ sessionId: c.sessionId, question: c.ask.id, choice }),
    });
    const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (res.ok && body?.ok === true) return 'ok';
    if (body?.error === 'not_waiting' || body?.error === 'unknown_session') return 'stale';
    return body?.error === 'owner_page_only' ? 'refused' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** Bring the project that holds this chat to the front (the same relay a detail button rides). */
export function openProject(vault: string): void {
  void fetch('/api/assistant/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vault }),
  }).catch(() => { /* the row stays; the next click retries */ });
}

/** Refused, Allow and Deny leave with the focus on them: it moves to the way to the chat. Only
 *  after a press on them, never out of the composer on a Y / N or a spoken word. */
export function useRefusalFocus(failed: AnswerFailure['outcome'] | null | undefined) {
  const pressed = useRef(false);
  const chat = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!failed) return;
    if (failed === 'refused' && pressed.current) chat.current?.focus();
    pressed.current = false;
  }, [failed]);
  return { pressed, chat };
}

function GlanceRow({ c, keyed, failure, onAnswered }: { c: GlanceChat; keyed: boolean; failure?: AnswerFailure | null; onAnswered: (sessionId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [ownFailure, setOwnFailure] = useState<AnswerFailure | null>(null);
  // This row's click, or Y / N and a spoken word, which the notch answers for it.
  const failed = [ownFailure, failure].find((f) => f && f.ask === c.ask?.id)?.outcome;
  // Refused for good: the buttons would only fail again, so the row sends him to the chat.
  const permission = c.ask?.kind === 'permission' && failed !== 'refused';
  const focus = useRefusalFocus(failed);
  const act = async (choice: 'allow' | 'deny') => {
    if (!c.ask) return;
    focus.pressed.current = true;
    setBusy(true);
    setOwnFailure(null);
    const outcome = await answerPermission(c, choice);
    setBusy(false);
    if (outcome === 'ok' || outcome === 'stale') onAnswered(c.sessionId); else setOwnFailure({ ask: c.ask.id, outcome });
  };
  return (
    <li className="dc-glance__row" data-activity={c.activity}>
      <button type="button" className="dc-glance__head" onClick={() => openChat(c.vault, c.sessionId)} title={`Open this chat in ${c.vault}`}>
        <span className="dc-glance__dot" aria-hidden />
        {c.super && <span className="dc-glance__super" title="Super Agent"><SuperAgentIcon size={14} /></span>}
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
              {failed && <span className="dc-glance__fail" role="alert">{answerFailureText(failed, c.vault)}</span>}
            </div>
          ) : (
            <div className="dc-glance__actions">
              <button ref={focus.chat} type="button" className="dc-glance__btn" onClick={() => openChat(c.vault, c.sessionId)}>Answer in {c.vault}</button>
              {failed && <span className="dc-glance__fail" role="alert">{answerFailureText(failed, c.vault)}</span>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function GlanceList({ chats, failure, onAnswered }: { chats: GlanceChat[]; failure?: AnswerFailure | null; onAnswered: (sessionId: string) => void }) {
  // The keys answer the FIRST permission prompt only, so the chips appear on that row alone.
  const keyedId = chats.find((c) => c.ask?.kind === 'permission')?.sessionId;
  return (
    <ul className="dc-glance" aria-label="Your projects right now">
      {chats.map((c) => <GlanceRow key={c.sessionId} c={c} keyed={c.sessionId === keyedId} failure={failure} onAnswered={onAnswered} />)}
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

function HandoffRow({ h, shared, onAnswered, onDismiss }: { h: Handoff; shared?: AnswerFailure | null; onAnswered: (sessionId: string) => void; onDismiss: (sessionId: string) => void }) {
  const phase = handoffPhase(h);
  const [open, setOpen] = useState(phase === 'waiting');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AnswerFailure | null>(null);
  const failed = [failure, shared].find((f) => f && f.ask === h.ask?.id)?.outcome;
  const focus = useRefusalFocus(failed);
  const act = async (choice: 'allow' | 'deny') => {
    if (!h.ask) return;
    focus.pressed.current = true;
    setBusy(true);
    setFailure(null);
    const outcome = await answerPermission(h, choice);
    setBusy(false);
    if (outcome === 'ok' || outcome === 'stale') onAnswered(h.sessionId); else setFailure({ ask: h.ask.id, outcome });
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
            {h.ask?.kind === 'permission' && failed !== 'refused' && (
              <>
                <button type="button" className="dc-glance__btn" disabled={busy} onClick={() => void act('deny')}>Deny</button>
                <button type="button" className="dc-glance__btn dc-glance__btn--primary" disabled={busy} onClick={() => void act('allow')}>Allow</button>
              </>
            )}
            {phase !== 'closed' && <button ref={focus.chat} type="button" className="dc-glance__btn" onClick={() => openChat(h.vault, h.sessionId)}>Open {h.vault}</button>}
            {phase === 'closed' && <button type="button" className="dc-glance__btn" onClick={() => onDismiss(h.sessionId)}>Clear</button>}
            {failed && <span className="dc-glance__fail" role="alert">{answerFailureText(failed, h.vault)}</span>}
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
export function HandoffList({ handoffs, failure, onAnswered, onDismiss }: {
  handoffs: Handoff[];
  failure?: AnswerFailure | null;
  onAnswered: (sessionId: string) => void;
  onDismiss: (sessionId: string) => void;
}) {
  return (
    <section className="dc-handoffs" aria-label="Handed off">
      <h3 className="dc-notch__section">Handed off</h3>
      <ul>
        {handoffs.map((h) => <HandoffRow key={h.sessionId} h={h} shared={failure} onAnswered={onAnswered} onDismiss={onDismiss} />)}
      </ul>
    </section>
  );
}
