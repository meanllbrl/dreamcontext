import type { ReactNode } from 'react';
import { avatarHue } from './chatEntities';
import { fmtTokens } from '../../../lib/agentComposer';
import './notices.css';

/**
 * The ONE shape every chat notice takes (owner 2026-10-07, approved board
 * `_dream_context/tmp/account-banners/notices-redesign.png`): a toned badge, a 2–5 word
 * headline, and the facts drawn as pictures — avatars, meters, a context bar, steps — never
 * as a sentence. An explanation that does not fit a headline goes in `detail` (hover) rather
 * than in the card, and a notice the user can act on carries the button that does it instead
 * of instructions on where to find it.
 */

export type NoticeTone = 'info' | 'good' | 'warn' | 'bad';

export function Notice({
  tone = 'info', icon, title, meta, actions, detail, onDismiss, hero = false, slim = false,
  role = 'status', children, testId, className = '',
}: {
  tone?: NoticeTone;
  icon: ReactNode;
  title: ReactNode;
  /** Right of the headline: a time, a big number, a meter. */
  meta?: ReactNode;
  /** Buttons, right of the headline. */
  actions?: ReactNode;
  /** The full sentence the headline condenses — a hover, never a paragraph in the card. */
  detail?: string;
  onDismiss?: () => void;
  /** A long-running operation in progress: ringed, so it reads as live. */
  hero?: boolean;
  slim?: boolean;
  role?: 'status' | 'alert';
  children?: ReactNode;
  testId?: string;
  /** Placement hooks (`is-dock` = the composer's slot) and stable selectors for verify scripts. */
  className?: string;
}) {
  return (
    <div
      className={`chat-notice${hero ? ' is-hero' : ''}${slim ? ' is-slim' : ''}${className ? ` ${className}` : ''}`}
      data-tone={tone}
      role={role}
      title={detail}
      data-testid={testId}
    >
      <div className="chat-notice-head">
        <span className="chat-notice-badge" aria-hidden>{icon}</span>
        <span className="chat-notice-title">{title}</span>
        {meta}
        {actions}
        {onDismiss && (
          <button
            type="button"
            className="chat-notice-x"
            aria-label="Dismiss this notice"
            title="Dismiss"
            onClick={onDismiss}
          >×</button>
        )}
      </div>
      {children}
    </div>
  );
}

/** A row under the headline, aligned with the title (past the badge). */
export function NoticeRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`chat-notice-row ${className}`}>{children}</div>;
}

export function NoticeButton({ children, primary = false, onClick, disabled = false, title }: {
  children: ReactNode;
  primary?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`chat-notice-btn${primary ? ' is-primary' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >{children}</button>
  );
}

export function NoticeChip({ tone, children, title }: { tone?: NoticeTone; children: ReactNode; title?: string }) {
  return <span className="chat-notice-chip" data-tone={tone} title={title}>{children}</span>;
}

/** The big number on a receipt: `482k → 21k`. */
export function TokenDrop({ from, to }: { from: number; to?: number }) {
  return (
    <span className="chat-notice-big">
      {fmtTokens(from)}
      <small aria-hidden>→</small>
      {to === undefined ? '…' : fmtTokens(to)}
    </span>
  );
}

/**
 * Before and after on one track: the hatched span is what the context WAS, the solid span what
 * it is now. Relative to `from` — the window size is not on every notice that shows this, and
 * the drop is the point, not the ceiling.
 */
export function ContextShrink({ from, to, left, right }: {
  from: number;
  to?: number;
  left?: ReactNode;
  right?: ReactNode;
}) {
  const now = to === undefined ? null : Math.max(1.5, Math.min(100, (to / Math.max(1, from)) * 100));
  return (
    <div className="chat-notice-ctx">
      <div className="chat-notice-ctx-bar" data-pending={to === undefined || undefined}>
        <span className="chat-notice-ctx-was" />
        {now !== null && <span className="chat-notice-ctx-now" style={{ width: `${now}%` }} />}
      </div>
      {(left || right) && (
        <div className="chat-notice-ctx-lab"><span>{left}</span><span>{right}</span></div>
      )}
    </div>
  );
}

export type StepState = 'done' | 'run' | 'todo' | 'fail';

export function Steps({ steps }: { steps: Array<{ label: string; state: StepState }> }) {
  return (
    <ol className="chat-notice-steps">
      {steps.map((s) => (
        <li key={s.label} className="chat-notice-step" data-state={s.state}>
          <span className="chat-notice-step-dot" aria-hidden>
            {s.state === 'done' && <CheckGlyph />}
            {s.state === 'fail' && '!'}
          </span>
          <span className="chat-notice-step-label">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

// ─── Accounts ────────────────────────────────────────────────────────────────────────

/** `mehmet@ouromedia.net` → `ouromedia.net`: in a list of one person's accounts the domain is
 *  the part that tells them apart. A personal-mail domain keeps the local part instead. */
export function accountShortName(email: string): string {
  const at = email.indexOf('@');
  if (at < 0) return email;
  const domain = email.slice(at + 1);
  return /^(gmail|googlemail|outlook|hotmail|icloud|me|yahoo|proton|protonmail)\./i.test(domain)
    ? email.slice(0, at)
    : domain;
}

/** From the SHORT name, not the address: one person's accounts usually share the local part
 *  (`mehmet@…` ×3 all read "ME"), and the domain is what tells them apart. */
function initials(email: string): string {
  const label = email.includes('@') ? accountShortName(email) : email;
  const parts = label.split(/[^a-z0-9]+/i).filter(Boolean);
  const a = parts[0]?.[0] ?? label[0] ?? '?';
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? '';
  return (a + b).toUpperCase();
}

export function AccountAvatar({ email, size = 'sm', off = false }: { email: string; size?: 'sm' | 'lg'; off?: boolean }) {
  const hue = avatarHue(email);
  return (
    <span
      className={`chat-notice-av${size === 'lg' ? ' is-lg' : ''}${off ? ' is-off' : ''}`}
      style={{ background: `hsl(${hue} 55% 52%)` }}
      aria-hidden
    >{initials(email)}</span>
  );
}

/** A small usage meter: `5h ▬▬──`. Tone follows the same bands as the composer's ring. */
export function UsageMeter({ label, percent, showValue = false }: { label: string; percent: number; showValue?: boolean }) {
  const p = Math.max(0, Math.min(100, percent));
  const band = p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'good';
  return (
    <span className="chat-notice-meter" title={`${label} ${Math.round(p)}%`}>
      {label}
      <i><b data-tone={band} style={{ width: `${Math.max(2, p)}%` }} /></i>
      {showValue && `${Math.round(p)}%`}
    </span>
  );
}

// ─── Glyphs (stroke icons, currentColor — the badge tone colours them) ───────────────

const svg = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
function CheckGlyph() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;
}
export const Glyph = {
  swap: () => svg(<><path d="M7 4 3 8l4 4" /><path d="M3 8h14" /><path d="m17 20 4-4-4-4" /><path d="M21 16H7" /></>),
  leaf: () => svg(<><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z" /><path d="M2 21c0-3 1.9-5.4 5.1-6" /></>),
  clock: () => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  lock: () => svg(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>),
  key: () => svg(<><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.3-9.3M17 6l3 3M15 8l2 2" /></>),
  unplug: () => svg(<path d="M2 2l20 20M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.2-1.6M12 20h.01" />),
  moon: () => svg(<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />),
  branch: () => svg(<><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-6 3-12 5" /></>),
  stack: () => svg(<><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></>),
  task: () => svg(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>),
  user: () => svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  check: () => svg(<path d="M20 6 9 17l-5-5" />),
};
