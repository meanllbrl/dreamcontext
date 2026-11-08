import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { useApi } from '../../context/VaultContext';
import { isDesktop, openExternalUrl } from '../../lib/desktop';
import { DELETE_ARM_MS } from '../../lib/agentDraft';
import {
  TelegramShellError, atName, botLink, rowOf, telegramRoutes, telegramShell, useInvalidateTelegram, useTelegramStatus,
} from '../../api/telegram';
import { TelegramBindSheet } from './TelegramBindSheet';
import './telegram.css';

/**
 * A member's "Telegram" section in its profile, right under "İş" (plan U, V2, W3, W8; drawn in
 * bind-sheet-mockup.html §4). Unbound: one line and "Telegram'a bağla" (the same sheet, titled with
 * the member's name). Bound: "Bağlı", the bot and who talks, the routine list, open and remove.
 *
 * Routine forwarding is device-only and off by default. Ticking a box mints a request id and the
 * SHELL raises the macOS confirm, then turns it on with the owner key; unticking is keyless (less
 * data leaves the Mac). A routine whose approval changed shows unticked (the server says `on`).
 */
export function TelegramMemberSection({ slug, name }: { slug: string; name: string }) {
  const { t } = useI18n();
  const api = useApi();
  const routes = telegramRoutes(api);
  const status = useTelegramStatus();
  const invalidate = useInvalidateTelegram();
  const row = rowOf(status.data, slug);
  const bound = row?.state === 'active';
  const [sheet, setSheet] = useState(false);
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const forward = useQuery({
    queryKey: ['telegram', 'forward', slug],
    queryFn: () => routes.forwardList(slug),
    enabled: bound,
    retry: 0,
  });

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), DELETE_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const toggle = (routine: string, on: boolean) => {
    if (pending) return;
    setPending(routine);
    setError(null);
    const done = () => { setPending(null); void forward.refetch(); };
    if (!on) {
      routes.forwardOff(slug, routine).then(done).catch(() => { done(); setError(t('telegram.error.generic')); });
      return;
    }
    routes.forwardRequest(slug, routine)
      .then(({ forwardRequestId }) => telegramShell.confirmForward(forwardRequestId))
      .then(done)
      .catch((e) => { done(); setError(e instanceof TelegramShellError ? t(`telegram.refusal.${e.reason}`) : t('telegram.error.generic')); });
  };

  const remove = () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false);
    routes.unbind(slug).then(invalidate).catch(() => setError(t('telegram.error.generic')));
  };

  const link = row ? botLink(row.botUsername) : null;

  return (
    <section className="agp-section" aria-label={t('telegram.member.title')} data-section="telegram">
      <div className="tg-member">
        <div className="tg-row-between">
          <h3 className="agp-h">{t('telegram.member.title')}</h3>
          {bound && <span className="tg-chip tg-chip--good">{t('telegram.bound')}</span>}
        </div>
        {!bound ? (
          <>
            <p className="agp-hint">{t('telegram.member.hint')}</p>
            <button type="button" className="agp-btn tg-btn--start" onClick={() => setSheet(true)} data-testid="tg-member-bind">
              {t('telegram.bind')}
            </button>
          </>
        ) : (
          <>
            <p className="tg-member-who">
              {atName(row?.botUsername)}{row?.userLabel && <span>{' · '}{t('telegram.member.with').replace('{who}', atName(row.userLabel))}</span>}
            </p>
            <p className="tg-forward-title">{t('telegram.forward.title')}</p>
            {forward.isLoading ? (
              <p className="agp-muted">{t('telegram.loading')}</p>
            ) : forward.isError ? (
              <p className="agp-muted">{t('telegram.forward.unavailable')}</p>
            ) : (forward.data?.routines.length ?? 0) === 0 ? (
              <p className="agp-muted">{t('telegram.forward.none')}</p>
            ) : (
              <ul className="tg-forward" data-testid="tg-forward-list">
                {forward.data!.routines.map((r) => (
                  <li key={r.slug}>
                    <label className="tg-check">
                      <input type="checkbox" checked={r.on} disabled={!isDesktop() || pending !== null}
                        onChange={(e) => toggle(r.slug, e.target.checked)} data-routine={r.slug} />
                      <span>{r.title}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="agp-hint">{t('telegram.forward.always')}</p>
            <div className="tg-member-links">
              {link && <button type="button" className="tg-link" onClick={() => void openExternalUrl(link)}>{t('telegram.openInTelegram')}</button>}
              <button type="button" className="tg-link tg-link--danger" onClick={remove} data-testid="tg-member-unbind">
                {armed ? t('telegram.unbind.confirm') : t('telegram.member.remove')}
              </button>
            </div>
          </>
        )}
        {error && <p className="tg-error" role="alert">{error}</p>}
      </div>
      {sheet && <TelegramBindSheet target={slug} name={name} onClose={() => setSheet(false)} />}
    </section>
  );
}
