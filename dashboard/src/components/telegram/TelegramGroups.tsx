import { useEffect, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useApi } from '../../context/VaultContext';
import { DELETE_ARM_MS } from '../../lib/agentDraft';
import { TelegramShellError, telegramRoutes, telegramShell, useInvalidateTelegram, type TelegramStatusRow } from '../../api/telegram';
import './telegram.css';

/** Turkish month names with their ablative ending ("17 Kasım'dan beri"). */
const TR_MONTHS_FROM = ["Ocak'tan", "Şubat'tan", "Mart'tan", "Nisan'dan", "Mayıs'tan", "Haziran'dan", "Temmuz'dan", "Ağustos'tan", "Eylül'den", "Ekim'den", "Kasım'dan", "Aralık'tan"];

export function sinceLabel(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (locale.startsWith('tr')) return `${d.getDate()} ${TR_MONTHS_FROM[d.getMonth()]} beri`;
  return `since ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

/**
 * A bound bot's Telegram groups (tg-grup D3; approved screen 4): each permitted group with the
 * day it was bound and "Gruptan çıkar" (armed, the bot leaves the group); a group whose owner
 * wrote /bagla waits here with "Bağla", which raises the Mac's own confirm. The hint says how to
 * add one. Shown for a bound row only.
 */
export function TelegramGroups({ row }: { row: TelegramStatusRow }) {
  const { t, locale } = useI18n();
  const api = useApi();
  const routes = telegramRoutes(api);
  const invalidate = useInvalidateTelegram();
  const [armed, setArmed] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = row.groups ?? [];
  const asks = row.groupAsks ?? [];

  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), DELETE_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const remove = (chatId: number) => {
    if (armed !== chatId) { setArmed(chatId); return; }
    setArmed(null);
    setError(null);
    routes.groupRemove(row.target, chatId).then(invalidate).catch(() => { setError(t('telegram.error.generic')); invalidate(); });
  };

  const bind = (id: string) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    telegramShell.confirmGroup(id)
      .then(() => { setBusy(null); invalidate(); })
      .catch((e) => { setBusy(null); invalidate(); setError(e instanceof TelegramShellError ? t(`telegram.refusal.${e.reason}`) : t('telegram.error.generic')); });
  };

  return (
    <div className="tg-groups" data-testid={`tg-groups-${row.target}`}>
      <p className="tg-forward-title">{t('telegram.groups.title')}</p>
      {asks.map((a) => (
        <div key={a.id} className="tg-group-row" data-testid="tg-group-ask">
          <span className="tg-group-name">{t('telegram.groups.asks').replace('{title}', a.title)}</span>
          <button type="button" className="tg-btn tg-btn--primary" onClick={() => bind(a.id)} disabled={busy !== null}>{t('telegram.groups.bind')}</button>
        </div>
      ))}
      {groups.length === 0 && asks.length === 0 && <p className="tg-hint">{t('telegram.groups.none')}</p>}
      {groups.map((g) => (
        <div key={g.chatId} className="tg-group-row" data-testid="tg-group">
          <span className="tg-group-name">
            {g.title}
            <span className="tg-group-since">{sinceLabel(g.boundAt, locale)}</span>
          </span>
          <button type="button" className={`tg-btn tg-btn--danger${armed === g.chatId ? ' is-armed' : ''}`} onClick={() => remove(g.chatId)}>
            {armed === g.chatId ? t('telegram.unbind.confirm') : t('telegram.groups.remove')}
          </button>
        </div>
      ))}
      <p className="tg-hint">{t('telegram.groups.hint')}</p>
      {error && <p className="tg-error" role="alert">{error}</p>}
    </div>
  );
}
