import { useEffect, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useApi } from '../../context/VaultContext';
import { isDesktop } from '../../lib/desktop';
import { DELETE_ARM_MS } from '../../lib/agentDraft';
import { MaskedSecretInput } from '../core/MaskedSecretInput';
import { PairingView, TelegramBindSheet } from '../telegram/TelegramBindSheet';
import {
  TelegramShellError, atName, telegramRoutes, telegramShell, useInvalidateTelegram, useTelegramManager,
  type PairingStart,
} from '../../api/telegram';
import { RequestError } from '../../api/client';
import '../telegram/telegram.css';

/**
 * Settings → Bağlantılar → Telegram: the device's ONE manager bot (plan X2, Z4, AA3; drawn in
 * settings-telegram-mockup.html). Set up once on this Mac, for every project: after that the Super
 * and every member get their own bot with one tap in Telegram.
 *
 * Not set up: three steps, the masked token, the pairing link, and the macOS confirm the shell
 * raises ("… bu Mac'in Telegram yöneticisi olsun mu?"); the paired user becomes the owner id.
 * Set up: "Hazır", the manager and who it answers, every bot bound on this Mac, the account-limit
 * note, the own-token fallback and Kaldır. An alarm (another poller, a revoked or rewritten key)
 * replaces it with the warning and "Yeni anahtarı gir". In a browser tab: one line, setup is in
 * the Mac app only.
 */
type Flow = { kind: 'idle' } | { kind: 'token' } | { kind: 'pairing'; start: PairingStart; asked: boolean; cancelled: boolean };

export function TelegramSettings() {
  const { t } = useI18n();
  const api = useApi();
  const routes = telegramRoutes(api);
  const invalidate = useInvalidateTelegram();
  const desktop = isDesktop();
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const status = useTelegramManager({ enabled: desktop, waiting: flow.kind === 'pairing' });
  const manager = status.data?.manager ?? null;
  const alarm = status.data?.alarm ?? null;
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [ownToken, setOwnToken] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), DELETE_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  // The manager's pairing: once its /start arrived, the shell raises the native confirm.
  useEffect(() => {
    if (flow.kind !== 'pairing' || flow.asked || manager?.state !== 'pending' || !manager.userLabel) return;
    setFlow({ ...flow, asked: true });
    void telegramShell.confirmBinding(flow.start.pairingId)
      .then((r) => {
        if (!r.ok) setFlow((f) => (f.kind === 'pairing' ? { ...f, cancelled: true } : f));
        invalidate();
      })
      .catch((e) => setError(e instanceof TelegramShellError ? t(`telegram.refusal.${e.reason}`) : t('telegram.error.generic')));
  }, [flow, manager?.state, manager?.userLabel, invalidate, t]);

  useEffect(() => {
    if (flow.kind === 'pairing' && manager?.state === 'active' && !alarm) setFlow({ kind: 'idle' });
  }, [flow.kind, manager?.state, alarm]);

  if (!desktop) {
    return <div className="tg-settings"><p className="tg-hint" data-testid="tg-settings-browser">{t('telegram.browserOnly')}</p></div>;
  }
  if (status.isLoading) return <div className="tg-settings"><p className="tg-hint">{t('telegram.loading')}</p></div>;

  const submit = () => {
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    routes.managerBind(value)
      .then((start) => { setToken(''); setBusy(false); setFlow({ kind: 'pairing', start, asked: false, cancelled: false }); invalidate(); })
      .catch((e) => {
        setBusy(false);
        setError(e instanceof RequestError && e.status === 400 ? t('telegram.token.bad') : t('telegram.error.generic'));
      });
  };

  const remove = () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false);
    routes.managerUnbind().then(invalidate).catch(() => setError(t('telegram.error.generic')));
  };

  const tokenForm = (
    <>
      <MaskedSecretInput value={token} onChange={setToken} onSubmit={submit} ariaLabel={t('telegram.token.label')} placeholder="123456:ABC…" disabled={busy} />
      <p className="tg-note">{t('telegram.manager.keyNote')}</p>
      <div className="tg-actions">
        {flow.kind === 'token' && <button type="button" className="tg-btn" onClick={() => { setToken(''); setFlow({ kind: 'idle' }); }}>{t('telegram.cancel')}</button>}
        <button type="button" className="tg-btn tg-btn--primary" onClick={submit} disabled={!token.trim() || busy} data-testid="tg-manager-next">{t('telegram.next')}</button>
      </div>
    </>
  );

  let body;
  if (flow.kind === 'pairing') {
    body = (
      <PairingView start={flow.start} row={manager} cancelled={flow.cancelled}
        onRestart={() => setFlow({ kind: 'token' })} onAskAgain={() => setFlow({ ...flow, asked: false, cancelled: false })} />
    );
  } else if (alarm && flow.kind !== 'token') {
    body = (
      <>
        <p className="tg-warn" role="alert" data-testid="tg-manager-alarm">{t('telegram.manager.alarm')}</p>
        <p className="tg-hint">{t('telegram.manager.no409')}</p>
        <button type="button" className="tg-btn tg-btn--primary tg-btn--start" onClick={() => setFlow({ kind: 'token' })}>{t('telegram.manager.newKey')}</button>
      </>
    );
  } else if (manager?.state === 'active' && flow.kind !== 'token') {
    const bots = status.data?.bots ?? [];
    body = (
      <>
        <div className="tg-row-between"><span /><span className="tg-chip tg-chip--good">{t('telegram.manager.ready')}</span></div>
        <p className="tg-member-who">
          {t('telegram.manager.who').replace('{bot}', atName(manager.botUsername))}
          {manager.userLabel && <span>{' · '}{atName(manager.userLabel)}</span>}
        </p>
        <p className="tg-forward-title">{t('telegram.manager.bots')}</p>
        {bots.length === 0 ? (
          <p className="tg-hint">{t('telegram.manager.noBots')}</p>
        ) : (
          <dl className="tg-bots" data-testid="tg-manager-bots">
            {bots.map((b) => (
              <div key={`${b.projectName}/${b.target}`} style={{ display: 'contents' }}>
                <dt>{b.target === 'super' ? t('telegram.manager.superOf').replace('{project}', b.projectName) : b.label}</dt>
                <dd>{atName(b.botUsername)}</dd>
              </div>
            ))}
          </dl>
        )}
        {status.data?.managementOff && <p className="tg-warn">{t('telegram.manager.modeOff')}</p>}
        <p className="tg-hint">{t('telegram.manager.limit')}</p>
        <div className="tg-actions tg-actions--between">
          <button type="button" className="tg-link" onClick={() => setOwnToken(true)}>{t('telegram.ownToken')}</button>
          <button type="button" className="tg-link tg-link--danger" onClick={remove} data-testid="tg-manager-remove">
            {armed ? t('telegram.unbind.confirm') : t('telegram.member.remove')}
          </button>
        </div>
        <p className="tg-hint">{t('telegram.manager.removeNote')}</p>
      </>
    );
  } else {
    body = (
      <>
        {flow.kind !== 'token' && (
          <ol className="tg-steps">
            <li>{t('telegram.manager.step1')}</li>
            <li>{t('telegram.manager.step2')}</li>
            <li>{t('telegram.manager.step3')}</li>
          </ol>
        )}
        {tokenForm}
      </>
    );
  }

  return (
    <div className="tg-settings" data-testid="tg-settings">
      {body}
      {error && <p className="tg-error" role="alert">{error}</p>}
      {ownToken && <TelegramBindSheet target="super" name={null} startWith="token" onClose={() => setOwnToken(false)} />}
    </div>
  );
}
