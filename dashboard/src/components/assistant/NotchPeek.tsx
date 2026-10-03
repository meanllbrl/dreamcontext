import { forwardRef, useState } from 'react';
import { answerPermission, dismissHandoff, openProject } from './GlanceList';
import { glanceStatus, handoffPhase, type GlanceChat, type Handoff } from './notchModel';

/**
 * The PEEK: the collapsed notch growing just enough to say one thing, without opening the chat
 * and without taking focus (the owner may be typing elsewhere). It drops down on hover, and by
 * itself when something happens — a project asks for permission (it stays until answered or
 * waved away), or a hand-off finishes (it shows the reply for a few seconds).
 *
 * What it shows, most urgent first: the permission to answer; a question to go answer; the
 * hand-off that just finished; else (hover) up to three live lines.
 */

export type PeekItem =
  | { kind: 'permission'; chat: Pick<GlanceChat, 'sessionId' | 'vault' | 'ask'> }
  | { kind: 'question'; chat: Pick<GlanceChat, 'sessionId' | 'vault' | 'ask'> }
  | { kind: 'finished'; handoff: Handoff }
  | { kind: 'summary'; chats: GlanceChat[]; handoffs: Handoff[] };

/** Pick what the peek says. `finishedId` is the hand-off that just ended, if any. */
export function peekItem(chats: GlanceChat[], handoffs: Handoff[], finishedId: string | null): PeekItem {
  const permission = chats.find((c) => c.ask?.kind === 'permission');
  if (permission) return { kind: 'permission', chat: permission };
  const question = chats.find((c) => c.ask?.kind === 'question');
  if (question) return { kind: 'question', chat: question };
  const finished = finishedId ? handoffs.find((h) => h.sessionId === finishedId) : undefined;
  if (finished) return { kind: 'finished', handoff: finished };
  return { kind: 'summary', chats, handoffs };
}

export const NotchPeek = forwardRef<HTMLDivElement, {
  item: PeekItem;
  onOpenChat: () => void;
  onDone: () => void;
}>(function NotchPeek({ item, onOpenChat, onDone }, ref) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const answer = async (sessionId: string, ask: GlanceChat['ask'], choice: 'allow' | 'deny') => {
    setBusy(true);
    setFailed(false);
    const ok = await answerPermission({ sessionId, ask }, choice);
    setBusy(false);
    if (ok) onDone(); else setFailed(true);
  };

  return (
    <div className="dc-peek" ref={ref} data-kind={item.kind}>
      {item.kind !== 'summary' && (
        <button type="button" className="dc-peek__close" aria-label="Not now" title="Not now" onClick={onDone}>×</button>
      )}
      {item.kind === 'permission' && item.chat.ask && (
        <>
          <p className="dc-peek__line"><strong>{item.chat.vault}</strong> needs permission</p>
          <code className="dc-glance__cmd">{item.chat.ask.tool ? `${item.chat.ask.tool} · ` : ''}{item.chat.ask.text}</code>
          <div className="dc-glance__actions">
            <button type="button" className="dc-glance__btn" disabled={busy} onClick={() => void answer(item.chat.sessionId, item.chat.ask, 'deny')}>Deny</button>
            <button type="button" className="dc-glance__btn dc-glance__btn--primary" disabled={busy} onClick={() => void answer(item.chat.sessionId, item.chat.ask, 'allow')}>Allow</button>
            <button type="button" className="dc-peek__quiet" onClick={() => openProject(item.chat.vault)}>Open {item.chat.vault}</button>
            {failed && <span className="dc-glance__fail">Couldn't reach {item.chat.vault}.</span>}
          </div>
        </>
      )}
      {item.kind === 'question' && item.chat.ask && (
        <>
          <p className="dc-peek__line"><strong>{item.chat.vault}</strong> has a question</p>
          {item.chat.ask.text && <p className="dc-peek__text">{item.chat.ask.text}</p>}
          <div className="dc-glance__actions">
            <button type="button" className="dc-glance__btn dc-glance__btn--primary" onClick={() => openProject(item.chat.vault)}>Answer in {item.chat.vault}</button>
            <button type="button" className="dc-peek__quiet" onClick={onOpenChat}>Ask the assistant</button>
          </div>
        </>
      )}
      {item.kind === 'finished' && (
        <>
          <p className="dc-peek__line">
            <strong>{item.handoff.vault}</strong> {handoffPhase(item.handoff) === 'closed' ? 'closed' : 'finished'}
            {item.handoff.brief && <span className="dc-peek__brief"> · {item.handoff.brief}</span>}
          </p>
          {item.handoff.lastText && <p className="dc-peek__text">{item.handoff.lastText}</p>}
          <div className="dc-glance__actions">
            <button type="button" className="dc-glance__btn dc-glance__btn--primary" onClick={() => openProject(item.handoff.vault)}>Open {item.handoff.vault}</button>
            <button type="button" className="dc-peek__quiet" onClick={onOpenChat}>Follow up</button>
            {handoffPhase(item.handoff) === 'closed' && (
              <button type="button" className="dc-peek__quiet" onClick={() => { dismissHandoff(item.handoff.sessionId); onDone(); }}>Clear</button>
            )}
          </div>
        </>
      )}
      {item.kind === 'summary' && (
        <>
          {item.chats.length === 0 && item.handoffs.length === 0 && <p className="dc-peek__line dc-peek__idle">All quiet. Hold the hotkey to talk.</p>}
          <ul className="dc-peek__rows">
            {item.chats.slice(0, 3).map((c) => (
              <li key={c.sessionId}>
                <button type="button" className="dc-peek__row" data-activity={c.activity} onClick={() => openProject(c.vault)}>
                  <span className="dc-glance__dot" aria-hidden />
                  <strong>{c.vault}</strong>
                  <span className="dc-glance__status">{glanceStatus(c)}</span>
                  {c.title && <span className="dc-glance__title">{c.title}</span>}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="dc-peek__quiet dc-peek__open" onClick={onOpenChat}>Open the assistant ↵</button>
        </>
      )}
    </div>
  );
});
