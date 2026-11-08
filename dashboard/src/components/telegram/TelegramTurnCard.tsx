import type { ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import './telegram.css';

/**
 * An owner message that came from Telegram, in the Super chat. It is drawn like any of his own
 * bubbles, full text, nothing to open (owner 2026-11-08); a small "Telegram" chip sits on top as
 * a header, the same pill a board element or attachment wears in his bubble
 * (`chat-msg-user-ref`). The Super's answer still links under it by its ref (replyLinks).
 */
export function TelegramTurnCard({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="tg-turn" data-testid="tg-turn-card">
      <div className="chat-msg-user-media">
        <span className="chat-msg-user-ref tg-turn-chip" data-testid="tg-turn-chip">
          <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M14 2.5 1.8 7.3c-.5.2-.5.9 0 1.1l3 1.1 1.2 3.7c.1.4.6.5.9.2l1.7-1.6 3.1 2.3c.4.3.9.1 1-.4L14.9 3.3c.1-.5-.4-.9-.9-.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          {t('telegram.card.chip')}
        </span>
      </div>
      {children}
    </div>
  );
}
