import { useEffect, useState } from 'react';
import { buildAppLink, routeAppLink } from '../../lib/appLink';
import {
  accountLine, ago, automationPhotoUrl,
  type AutomationPost, type FinishedNotice, type InboxNotice, type RunningAutomation,
} from './notchModel';

/**
 * The notch as a notification center (owner, 2026-10-04): what happened while the owner looked
 * elsewhere, each row one click from the window it is about.
 *
 *   Notifications — chats that finished a turn off screen, account limits and switches, and
 *                   every unread automation post. A post stays until the owner marks it seen
 *                   (the eye), clicks it (lands on the automation, marks it read) or ignores
 *                   that automation (never shown again; undo under "Ignored").
 *   Running       — every automation working right now, with its photo.
 *
 * A click routes a `dreamcontext://` link through the app's own router (`lib/appLink.ts`), the
 * one that lands a banner in the exact window, tab and place: a chat, an automation's thread.
 */

/** Land a link the way a clicked banner does. Never throws. */
export function openLink(link: string): void {
  void routeAppLink(link).catch(() => { /* the row stays; the next click retries */ });
}

export function openChat(vault: string, sessionId: string): void {
  openLink(buildAppLink({ kind: 'session', vault, claudeId: sessionId }));
}

export function openAutomation(vault: string, slug: string): void {
  openLink(buildAppLink({ kind: 'automation', vault, slug, file: null }));
}

async function post(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.ok;
  } catch {
    return false;
  }
}

export const dismissNotice = (id: string) => post('/api/assistant/inbox/dismiss', { id });
export const markPostSeen = (p: Pick<AutomationPost, 'vault' | 'slug' | 'newestId'>) =>
  post('/api/assistant/inbox/seen', { vault: p.vault, slug: p.slug, upToId: p.newestId });
export const muteAutomation = (vault: string, slug: string, muted: boolean) =>
  post('/api/assistant/inbox/mute', { vault, slug, muted });

/** An automation's photo, or its initial when it has none (the route 404s). */
export function AgentAvatar({ vault, slug, title, hasPhoto, size = 28, working = false }: {
  vault: string; slug: string; title: string; hasPhoto: boolean; size?: number; working?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const initial = (title || slug).trim().slice(0, 1).toUpperCase();
  return (
    <span className={`dc-agent-avatar${working ? ' is-working' : ''}`} style={{ width: size, height: size }} aria-hidden>
      {hasPhoto && !failed
        ? <img src={automationPhotoUrl(vault, slug)} alt="" onError={() => setFailed(true)} />
        : <span className="dc-agent-avatar__initial">{initial}</span>}
    </span>
  );
}

/** "3m" since `ms`, re-rendered every few seconds while on screen. */
function useNow(every = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(t);
  }, [every]);
  return now;
}

function FinishedRow({ n, onGone, now }: { n: FinishedNotice; onGone: (id: string) => void; now: number }) {
  return (
    <li className="dc-inbox__row" data-kind="finished">
      <button type="button" className="dc-inbox__main" onClick={() => { openChat(n.vault, n.sessionId); void dismissNotice(n.id); onGone(n.id); }} title={`Open this chat in ${n.vault}`}>
        <span className="dc-inbox__icon dc-inbox__icon--done" aria-hidden>✓</span>
        <span className="dc-inbox__body">
          <span className="dc-inbox__head"><strong>{n.vault}</strong> finished<span className="dc-inbox__ago">{ago(n.at, now)}</span></span>
          {n.title && <span className="dc-inbox__sub">{n.title}</span>}
          {n.lastText && <span className="dc-inbox__text">{n.lastText}</span>}
        </span>
      </button>
      <button type="button" className="dc-inbox__icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => { void dismissNotice(n.id); onGone(n.id); }}>×</button>
    </li>
  );
}

function NoticeRow({ n, onGone, now }: { n: InboxNotice; onGone: (id: string) => void; now: number }) {
  if (n.kind === 'finished') return <FinishedRow n={n} onGone={onGone} now={now} />;
  const canOpen = !!(n.vault && n.sessionId);
  return (
    <li className="dc-inbox__row" data-kind="account">
      <button
        type="button"
        className="dc-inbox__main"
        disabled={!canOpen}
        onClick={() => { if (n.vault && n.sessionId) { openChat(n.vault, n.sessionId); void dismissNotice(n.id); onGone(n.id); } }}
      >
        <span className="dc-inbox__icon dc-inbox__icon--account" aria-hidden>⇄</span>
        <span className="dc-inbox__body">
          <span className="dc-inbox__head"><strong>Account</strong>{n.vault ? <> · {n.vault}</> : null}<span className="dc-inbox__ago">{ago(n.at, now)}</span></span>
          <span className="dc-inbox__text">{accountLine(n)}</span>
        </span>
      </button>
      <button type="button" className="dc-inbox__icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => { void dismissNotice(n.id); onGone(n.id); }}>×</button>
    </li>
  );
}

function PostRow({ p, onGone, now }: { p: AutomationPost; onGone: (key: string) => void; now: number }) {
  const at = Date.parse(p.at);
  const failed = p.textFrom === 'error';
  return (
    <li className="dc-inbox__row" data-kind="post" data-needs-you={p.needsYou ? '' : undefined} data-failed={failed ? '' : undefined}>
      <button
        type="button"
        className="dc-inbox__main"
        onClick={() => { openAutomation(p.vault, p.slug); void markPostSeen(p); onGone(p.key); }}
        title={`Open ${p.title} in ${p.vault}`}
      >
        <AgentAvatar vault={p.vault} slug={p.slug} title={p.title} hasPhoto={p.hasPhoto} />
        <span className="dc-inbox__body">
          <span className="dc-inbox__head">
            <strong>{p.title}</strong><span className="dc-inbox__where"> · {p.vault}</span>
            {p.needsYou && <span className="dc-inbox__tag">needs you</span>}
            {failed && <span className="dc-inbox__tag dc-inbox__tag--bad">failed</span>}
            {Number.isFinite(at) && <span className="dc-inbox__ago">{ago(at, now)}</span>}
          </span>
          {p.text && <span className="dc-inbox__text">{p.text}</span>}
        </span>
      </button>
      <span className="dc-inbox__actions">
        <button type="button" className="dc-inbox__icon-btn" aria-label="Mark as seen" title="Mark as seen" onClick={() => { void markPostSeen(p); onGone(p.key); }}>
          <EyeIcon />
        </button>
        <button type="button" className="dc-inbox__icon-btn" aria-label={`Ignore ${p.title}`} title={`Never show ${p.title} here again`} onClick={() => { void muteAutomation(p.vault, p.slug, true); onGone(p.key); }}>
          <MuteIcon />
        </button>
      </span>
    </li>
  );
}

function RunningRow({ r, now }: { r: RunningAutomation; now: number }) {
  return (
    <li className="dc-inbox__row" data-kind="running">
      <button type="button" className="dc-inbox__main" onClick={() => openAutomation(r.vault, r.slug)} title={`Open ${r.title} in ${r.vault}`}>
        <AgentAvatar vault={r.vault} slug={r.slug} title={r.title} hasPhoto={r.hasPhoto} working />
        <span className="dc-inbox__body">
          <span className="dc-inbox__head"><strong>{r.title}</strong><span className="dc-inbox__where"> · {r.vault}</span><span className="dc-inbox__ago">{ago(r.since, now)}</span></span>
          <span className="dc-inbox__sub">working…</span>
        </span>
      </button>
    </li>
  );
}

export function InboxList({ notices, posts, running, muted, onNoticeGone, onPostGone }: {
  notices: InboxNotice[];
  posts: AutomationPost[];
  running: RunningAutomation[];
  muted: Array<{ vault: string; slug: string }>;
  onNoticeGone: (id: string) => void;
  onPostGone: (key: string) => void;
}) {
  const now = useNow();
  const [showMuted, setShowMuted] = useState(false);
  const count = notices.length + posts.length;
  return (
    <>
      {count > 0 && (
        <section className="dc-inbox" aria-label="Notifications">
          <h3 className="dc-notch__section">Notifications</h3>
          <ul>
            {notices.map((n) => <NoticeRow key={n.id} n={n} onGone={onNoticeGone} now={now} />)}
            {posts.map((p) => <PostRow key={p.key} p={p} onGone={onPostGone} now={now} />)}
          </ul>
        </section>
      )}
      {running.length > 0 && (
        <section className="dc-inbox" aria-label="Automations running">
          <h3 className="dc-notch__section">Running</h3>
          <ul>{running.map((r) => <RunningRow key={`${r.vault}::${r.slug}`} r={r} now={now} />)}</ul>
        </section>
      )}
      {muted.length > 0 && (
        <section className="dc-inbox dc-inbox--muted">
          <button type="button" className="dc-inbox__muted-toggle" aria-expanded={showMuted} onClick={() => setShowMuted((v) => !v)}>
            Ignored automations ({muted.length}) {showMuted ? '▴' : '▾'}
          </button>
          {showMuted && (
            <ul>
              {muted.map((m) => (
                <li key={`${m.vault}::${m.slug}`} className="dc-inbox__muted-row">
                  <span>{m.slug} · {m.vault}</span>
                  <button type="button" className="dc-glance__btn" onClick={() => void muteAutomation(m.vault, m.slug, false)}>Show again</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function EyeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function MuteIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      <path d="M18.6 13A17.9 17.9 0 0 1 18 8" />
      <path d="M6.3 6.3A5.9 5.9 0 0 0 6 8c0 7-3 9-3 9h14" />
      <path d="M18 8a6 6 0 0 0-9.3-5" />
      <path d="M2 2l20 20" />
    </svg>
  );
}
