import { forwardRef, useState } from 'react';
import { answerPermission, dismissHandoff } from './GlanceList';
import { AgentAvatar, dismissNotice, markPostSeen, muteAutomation, openAutomation, openChat } from './InboxList';
import {
  accountLine, glanceStatus, handoffPhase,
  type AutomationPost, type GlanceChat, type Handoff, type InboxNotice, type RunningAutomation,
} from './notchModel';

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
  /** The Assistant thinking out loud (a `progress` cue): shown silently, folds by itself. */
  | { kind: 'progress'; text: string; name: string; avatar: string | null }
  /** A chat that finished off screen, or an account notice. */
  | { kind: 'notice'; notice: InboxNotice }
  | { kind: 'post'; post: AutomationPost }
  | { kind: 'started'; run: RunningAutomation }
  | { kind: 'summary'; chats: GlanceChat[]; handoffs: Handoff[]; inbox?: number; running?: RunningAutomation[] };

/** The peeks that only SAY something and fold by themselves (vs. one waiting on an answer). */
export const EVENT_PEEKS: ReadonlySet<PeekItem['kind']> = new Set(['finished', 'notice', 'post', 'started']);

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
      {item.kind !== 'summary' && item.kind !== 'progress' && (
        <button type="button" className="dc-peek__close" aria-label="Not now" title="Not now" onClick={onDone}>×</button>
      )}
      {item.kind === 'permission' && item.chat.ask && (
        <>
          <p className="dc-peek__line"><strong>{item.chat.vault}</strong> needs permission</p>
          <code className="dc-glance__cmd">{item.chat.ask.tool ? `${item.chat.ask.tool} · ` : ''}{item.chat.ask.text}</code>
          <div className="dc-glance__actions">
            <button type="button" className="dc-glance__btn" disabled={busy} onClick={() => void answer(item.chat.sessionId, item.chat.ask, 'deny')}>Deny</button>
            <button type="button" className="dc-glance__btn dc-glance__btn--primary" disabled={busy} onClick={() => void answer(item.chat.sessionId, item.chat.ask, 'allow')}>Allow</button>
            <button type="button" className="dc-peek__quiet" onClick={() => { openChat(item.chat.vault, item.chat.sessionId); onDone(); }}>Open {item.chat.vault}</button>
            {failed && <span className="dc-glance__fail">Couldn't reach {item.chat.vault}.</span>}
          </div>
        </>
      )}
      {item.kind === 'question' && item.chat.ask && (
        <>
          <p className="dc-peek__line"><strong>{item.chat.vault}</strong> has a question</p>
          {item.chat.ask.text && <p className="dc-peek__text">{item.chat.ask.text}</p>}
          <div className="dc-glance__actions">
            <button type="button" className="dc-glance__btn dc-glance__btn--primary" onClick={() => { openChat(item.chat.vault, item.chat.sessionId); onDone(); }}>Answer in {item.chat.vault}</button>
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
            <button type="button" className="dc-glance__btn dc-glance__btn--primary" onClick={() => { openChat(item.handoff.vault, item.handoff.sessionId); onDone(); }}>Open {item.handoff.vault}</button>
            <button type="button" className="dc-peek__quiet" onClick={onOpenChat}>Follow up</button>
            {handoffPhase(item.handoff) === 'closed' && (
              <button type="button" className="dc-peek__quiet" onClick={() => { dismissHandoff(item.handoff.sessionId); onDone(); }}>Clear</button>
            )}
          </div>
        </>
      )}
      {item.kind === 'progress' && (
        <div className="dc-peek__progress">
          {item.avatar
            ? <img className="dc-peek__avatar" src={item.avatar} alt="" />
            : <span className="dc-peek__avatar dc-peek__avatar--initial" aria-hidden>{item.name.slice(0, 1)}</span>}
          <p className="dc-peek__text dc-peek__text--progress">{item.text}</p>
        </div>
      )}
      {item.kind === 'notice' && item.notice.kind === 'finished' && (
        <>
          <p className="dc-peek__line"><strong>{item.notice.vault}</strong> finished{item.notice.title && <span className="dc-peek__brief"> · {item.notice.title}</span>}</p>
          {item.notice.lastText && <p className="dc-peek__text">{item.notice.lastText}</p>}
          <div className="dc-glance__actions">
            <button type="button" className="dc-glance__btn dc-glance__btn--primary" onClick={() => {
              if (item.notice.kind !== 'finished') return;
              openChat(item.notice.vault, item.notice.sessionId);
              void dismissNotice(item.notice.id);
              onDone();
            }}>Open the chat</button>
            <button type="button" className="dc-peek__quiet" onClick={() => { void dismissNotice(item.notice.id); onDone(); }}>Dismiss</button>
          </div>
        </>
      )}
      {item.kind === 'notice' && item.notice.kind === 'account' && (
        <>
          <p className="dc-peek__line"><strong>Account</strong>{item.notice.vault && <span className="dc-peek__brief"> · {item.notice.vault}</span>}</p>
          <p className="dc-peek__text">{accountLine(item.notice)}</p>
        </>
      )}
      {item.kind === 'post' && (
        <>
          <div className="dc-peek__agent">
            <AgentAvatar vault={item.post.vault} slug={item.post.slug} title={item.post.title} hasPhoto={item.post.hasPhoto} size={24} />
            <p className="dc-peek__line"><strong>{item.post.title}</strong><span className="dc-peek__brief"> · {item.post.vault}</span></p>
          </div>
          {item.post.text && <p className="dc-peek__text">{item.post.text}</p>}
          <div className="dc-glance__actions">
            <button type="button" className="dc-glance__btn dc-glance__btn--primary" onClick={() => { openAutomation(item.post.vault, item.post.slug); void markPostSeen(item.post); onDone(); }}>Open</button>
            <button type="button" className="dc-peek__quiet" onClick={() => { void markPostSeen(item.post); onDone(); }}>Seen</button>
            <button type="button" className="dc-peek__quiet" onClick={() => { void muteAutomation(item.post.vault, item.post.slug, true); onDone(); }}>Ignore {item.post.title}</button>
          </div>
        </>
      )}
      {item.kind === 'started' && (
        <button type="button" className="dc-peek__agent dc-peek__agent--button" onClick={() => { openAutomation(item.run.vault, item.run.slug); onDone(); }}>
          <AgentAvatar vault={item.run.vault} slug={item.run.slug} title={item.run.title} hasPhoto={item.run.hasPhoto} size={24} working />
          <span className="dc-peek__line"><strong>{item.run.title}</strong> started<span className="dc-peek__brief"> · {item.run.vault}</span></span>
        </button>
      )}
      {item.kind === 'summary' && (
        <>
          {item.chats.length === 0 && item.handoffs.length === 0 && !item.inbox && !item.running?.length && <p className="dc-peek__line dc-peek__idle">All quiet. Hold the hotkey to talk.</p>}
          {!!item.running?.length && (
            <div className="dc-peek__running" aria-label="Automations running">
              {item.running.slice(0, 5).map((r) => (
                <button key={`${r.vault}::${r.slug}`} type="button" className="dc-peek__run" title={`${r.title} · ${r.vault}`} onClick={() => openAutomation(r.vault, r.slug)}>
                  <AgentAvatar vault={r.vault} slug={r.slug} title={r.title} hasPhoto={r.hasPhoto} size={22} working />
                </button>
              ))}
              <span className="dc-peek__brief">{item.running.length === 1 ? `${item.running[0].title} is running` : `${item.running.length} automations running`}</span>
            </div>
          )}
          {!!item.inbox && <p className="dc-peek__line">{item.inbox === 1 ? '1 notification' : `${item.inbox} notifications`} waiting</p>}
          <ul className="dc-peek__rows">
            {item.chats.slice(0, 3).map((c) => (
              <li key={c.sessionId}>
                <button type="button" className="dc-peek__row" data-activity={c.activity} onClick={() => openChat(c.vault, c.sessionId)}>
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
