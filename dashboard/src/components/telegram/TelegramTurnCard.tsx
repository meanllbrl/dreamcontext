import { useId, useState, type ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import './telegram.css';

/**
 * An owner message that came from Telegram, in the Super chat (owner 2026-11-07 picked a
 * collapsible card over an inline badge; plan "UI", C1). Collapsed: the "Telegram" chip, the time
 * and the message's last sentence. Open: the message as the bubble draws it. The Super's answer
 * still links under it by its ref (replyLinks), live and after a reload, desktop and phone page.
 */
export function TelegramTurnCard({ text, ts, children }: { text: string; ts: number; children: ReactNode }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const time = ts > 0 ? new Date(ts).toLocaleTimeString(locale === 'tr' ? 'tr-TR' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div className="tg-card" data-open={open ? 'true' : 'false'} data-testid="tg-turn-card">
      <button type="button" className="tg-card-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className="tg-card-chip">
          <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M14 2.5 1.8 7.3c-.5.2-.5.9 0 1.1l3 1.1 1.2 3.7c.1.4.6.5.9.2l1.7-1.6 3.1 2.3c.4.3.9.1 1-.4L14.9 3.3c.1-.5-.4-.9-.9-.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          {t('telegram.card.chip')}
        </span>
        {time && <span className="tg-card-time">{time}</span>}
        {!open && <span className="tg-card-line">{lastSentence(text)}</span>}
        {open && <span className="tg-card-line" />}
        <span className="tg-card-caret" aria-hidden>›</span>
      </button>
      {open && <div id={bodyId} className="tg-card-body">{children}</div>}
    </div>
  );
}

/** The message's last sentence, one line (what the collapsed card reads). */
export function lastSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const parts = flat.split(/(?<=[.!?…])\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? flat;
}
