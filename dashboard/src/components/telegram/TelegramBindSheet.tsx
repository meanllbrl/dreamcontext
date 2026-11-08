import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../context/I18nContext';
import { emitInstance, useApi, useVault } from '../../context/VaultContext';
import { RequestError } from '../../api/client';
import { isDesktop, openExternalUrl } from '../../lib/desktop';
import { MaskedSecretInput } from '../core/MaskedSecretInput';
import { HandsfreeQr } from '../handsfree/HandsfreeParts';
import {
  TelegramShellError, atName, botLink, rowOf, telegramRoutes, telegramShell, useInvalidateTelegram, useTelegramStatus,
  type PairingStart, type ShellRefusal, type TelegramStatusRow,
} from '../../api/telegram';
import { DELETE_ARM_MS } from '../../lib/agentDraft';
import { CREATION_TTL_MS } from '../../../../src/lib/telegram/contract.js';
import './telegram.css';

/**
 * Binding a Super or an AI Team member to its own Telegram bot (plan U, X, W7; approved drafts
 * bind-sheet-mockup.html and settings-telegram-mockup.html).
 *
 * With a manager bot set up in Settings the sheet has ONE step: "Telegram'da oluştur" opens
 * Telegram's own create window (the owner's tap there is the confirmation) and the sheet waits.
 * Without one it says so and links to Settings. Either way "Kendi botunun anahtarını gir" opens
 * the own-token flow: (1) BotFather steps and the masked token, (2) the single-use deep link and
 * QR, (3) the macOS confirm the SHELL raises (Rust NSAlert): only the owner's click there makes a
 * binding live. The token leaves this component's state the moment step 1's POST answers; it is
 * never in a URL, a draft or storage.
 *
 * Bound: the connected view (bot, who talks, "only this Mac", what Telegram sees, open, remove).
 */
type Step =
  | { kind: 'auto' }
  | { kind: 'token' }
  /** `since`: when this pairing began. A status read older than it is about some other pairing
   *  (the cache can still hold an earlier pending row), so it never raises this one's confirm. */
  | { kind: 'pairing'; start: PairingStart; asked: boolean; cancelled: boolean; since: number }
  | { kind: 'creating'; link: string | null; until: number }
  | { kind: 'readopting' }
  | { kind: 'done' };

export function TelegramBindSheet({ target, name, onClose, startWith }: {
  /** `super` or a member slug. */
  target: string;
  /** Super: null. A member: its display name (the sheet's title names it). */
  name: string | null;
  onClose: () => void;
  /** Settings' "Kendi botunun anahtarını gir" opens straight on the token step. */
  startWith?: 'token';
}) {
  const { t } = useI18n();
  const api = useApi();
  const { bus } = useVault();
  const routes = telegramRoutes(api);
  const invalidate = useInvalidateTelegram();
  const [step, setStep] = useState<Step>({ kind: startWith ?? 'auto' } as Step);
  const waiting = step.kind === 'pairing' || step.kind === 'creating' || step.kind === 'readopting';
  const status = useTelegramStatus({ waiting });
  const row = rowOf(status.data, target);
  const manager = status.data?.manager ?? null;
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readopt, setReadopt] = useState<{ botUsername?: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const desktop = isDesktop();

  const title = name ? t('telegram.sheet.titleMember').replace('{name}', name) : t('telegram.sheet.titleSuper');

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Re-adopt is offered only for a target that had a managed bot (AA2).
  useEffect(() => {
    if (!desktop || row?.state === 'active') return;
    let live = true;
    routes.readoptInfo(target)
      .then((r) => { if (live) setReadopt(r.available ? { botUsername: r.botUsername } : null); })
      .catch(() => { if (live) setReadopt(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, desktop, row?.state]);

  // A live binding ends every wait.
  useEffect(() => {
    if (row?.state === 'active' && waiting) setStep({ kind: 'done' });
  }, [row?.state, waiting]);

  // Step 3: once Telegram's /start arrived (the row is pending with a user, read AFTER this pairing
  // began), the shell raises the native confirm. Once per pairing; a cancel or a refusal offers to
  // ask again.
  useEffect(() => {
    if (step.kind !== 'pairing' || step.asked || !pendingSince(row, status.dataUpdatedAt, step.since)) return;
    setStep({ ...step, asked: true });
    void telegramShell.confirmBinding(step.start.pairingId)
      .then((r) => {
        if (!r.ok) setStep((s) => (s.kind === 'pairing' ? { ...s, cancelled: true } : s));
        invalidate();
      })
      .catch((e) => {
        setError(refusalText(t, e));
        setStep((s) => (s.kind === 'pairing' ? { ...s, cancelled: true } : s));
      });
  }, [step, row, status.dataUpdatedAt, invalidate, t]);

  // A creation that heard nothing in 10 minutes (X6).
  useEffect(() => {
    if (step.kind !== 'creating') return;
    const left = step.until - Date.now();
    const timer = setTimeout(() => { setStep({ kind: 'auto' }); setError(t('telegram.create.noNews')); }, Math.max(0, left));
    return () => clearTimeout(timer);
  }, [step, t]);

  const fail = (e: unknown) => {
    setBusy(false);
    if (e instanceof RequestError && e.code === 'no_manager') { setStep({ kind: 'auto' }); invalidate(); return; }
    setError(e instanceof TelegramShellError ? refusalText(t, e) : t('telegram.error.generic'));
  };

  const submitToken = () => {
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    routes.bind(target, value)
      .then((start) => {
        setToken(''); // W7: the token leaves the component's state once step 1 answers
        setBusy(false);
        setStep({ kind: 'pairing', start, asked: false, cancelled: false, since: Date.now() });
        invalidate();
      })
      .catch((e) => {
        setBusy(false);
        setError(e instanceof RequestError && e.status === 400 ? t('telegram.token.bad') : e instanceof RequestError && e.status === 409 ? t('telegram.token.taken') : t('telegram.error.generic'));
      });
  };

  const create = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    routes.creationRequest(target)
      .then(({ creationId }) => telegramShell.startCreation(creationId))
      .then((r) => {
        setBusy(false);
        setStep({ kind: 'creating', link: r.link, until: Date.now() + CREATION_TTL_MS });
        void openExternalUrl(r.link);
      })
      .catch(fail);
  };

  const rebind = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    routes.readoptRequest(target)
      .then(({ readoptId }) => telegramShell.startReadopt(readoptId))
      .then((r) => { setBusy(false); if (r.ok) { setStep({ kind: 'readopting' }); invalidate(); } })
      .catch(fail);
  };

  const openSettings = () => {
    onClose();
    emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'settings', id: 'telegram' });
  };

  let body: ReactNode;
  if (!desktop) {
    body = <p className="tg-hint" data-testid="tg-browser-only">{t('telegram.browserOnly')}</p>;
  } else if (status.isLoading) {
    body = <p className="tg-hint">{t('telegram.loading')}</p>;
  } else if (status.isError && !status.data) {
    // A failed read is never "not set up": that would send the owner to Settings for nothing.
    body = <StatusError onRetry={() => void status.refetch()} />;
  } else if (row?.state === 'active') {
    body = <TelegramConnected row={row} fresh={step.kind === 'done'} target={target} onRemoved={onClose} />;
  } else if (step.kind === 'token') {
    body = (
      <>
        <p className="tg-step">{t('telegram.step').replace('{n}', '1')}</p>
        <ol className="tg-steps">
          <li>{t('telegram.token.step1')}</li>
          <li>{t('telegram.token.step2')}</li>
        </ol>
        <label className="tg-field">
          <span className="tg-label">{t('telegram.token.label')}</span>
          <MaskedSecretInput value={token} onChange={setToken} onSubmit={submitToken} ariaLabel={t('telegram.token.label')} placeholder="123456:ABC…" disabled={busy} />
        </label>
        <p className="tg-note">{t('telegram.deviceOnly')}</p>
        <div className="tg-actions">
          <button type="button" className="tg-btn" onClick={() => { setToken(''); setStep({ kind: 'auto' }); }}>{t('telegram.cancel')}</button>
          <button type="button" className="tg-btn tg-btn--primary" onClick={submitToken} disabled={!token.trim() || busy} data-testid="tg-token-next">{t('telegram.next')}</button>
        </div>
      </>
    );
  } else if (step.kind === 'pairing') {
    body = (
      <>
        <p className="tg-step">{t('telegram.step').replace('{n}', '2')}</p>
        <PairingView start={step.start} row={pendingSince(row, status.dataUpdatedAt, step.since) ? row : null} cancelled={step.cancelled}
          onRestart={() => setStep({ kind: 'token' })} onAskAgain={() => { setError(null); setStep({ ...step, asked: false, cancelled: false }); }} />
        <p className="tg-note">{t('telegram.pair.launchd')}</p>
      </>
    );
  } else if (step.kind === 'creating' || step.kind === 'readopting') {
    body = (
      <>
        {step.kind === 'creating' && step.link && (
          <div className="tg-qr-row">
            <HandsfreeQr value={step.link} label={t('telegram.qrLabel')} />
            <p className="tg-hint">{t('telegram.create.phone')}</p>
          </div>
        )}
        <p className="tg-wait" role="status"><span className="tg-wait-dot" aria-hidden /> {t('telegram.waiting')}</p>
      </>
    );
  } else if (manager?.state === 'active') {
    body = (
      <>
        <p className="tg-hint">{t('telegram.create.lead')}</p>
        <button type="button" className="tg-btn tg-btn--primary tg-btn--wide" onClick={create} disabled={busy} data-testid="tg-create">
          {t('telegram.create.button')}
        </button>
        <p className="tg-note">{t('telegram.create.public')}</p>
        {readopt && (
          <button type="button" className="tg-link" onClick={rebind} disabled={busy} data-testid="tg-readopt">
            {t('telegram.readopt').replace('{bot}', atName(readopt.botUsername) || '')}
          </button>
        )}
        <button type="button" className="tg-link" onClick={() => setStep({ kind: 'token' })} data-testid="tg-own-token">{t('telegram.ownToken')}</button>
      </>
    );
  } else {
    body = (
      <>
        <p className="tg-strong">{t('telegram.noManager.title')}</p>
        <p className="tg-hint">{t('telegram.noManager.lead')}</p>
        <button type="button" className="tg-btn tg-btn--primary tg-btn--start" onClick={openSettings} data-testid="tg-open-settings">{t('telegram.noManager.go')}</button>
        <button type="button" className="tg-link" onClick={() => setStep({ kind: 'token' })} data-testid="tg-own-token">{t('telegram.ownToken')}</button>
      </>
    );
  }

  return createPortal(
    <div className="tg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="tg-sheet" role="dialog" aria-modal="true" aria-labelledby="tg-sheet-title" tabIndex={-1} data-testid="tg-sheet" data-target={target}>
        <header className="tg-sheet-head">
          <div className="tg-title-row">
            <h2 id="tg-sheet-title" className="tg-title">{row?.state === 'active' ? t('telegram.connected.title') : step.kind === 'pairing' ? t('telegram.pair.title') : title}</h2>
            {row?.state === 'active' && <span className="tg-chip tg-chip--good">{t('telegram.bound')}</span>}
          </div>
          <button type="button" className="tg-icon-btn" onClick={onClose} aria-label={t('telegram.close')}>✕</button>
        </header>
        <div className="tg-sheet-body">
          {body}
          {error && <p className="tg-error" role="alert">{error}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A row that says Telegram's /start arrived for THIS pairing: pending, with a user, and read after
 *  the pairing began (the status cache may still hold an earlier pairing's pending row). */
export function pendingSince(row: TelegramStatusRow | null, readAt: number, since: number): boolean {
  return !!row && row.state === 'pending' && !!row.userLabel && readAt > since;
}

/** The status could not be read: say so, and offer to read it again. */
export function StatusError({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <p className="tg-error" role="alert" data-testid="tg-status-error">{t('telegram.error.status')}</p>
      <button type="button" className="tg-btn tg-btn--start" onClick={onRetry}>{t('telegram.retry')}</button>
    </>
  );
}

/** Step 2 of a pairing: QR + deep link, then the wait, an expiry or a cancelled native confirm. */
export function PairingView({ start, row, cancelled, onRestart, onAskAgain }: {
  start: PairingStart;
  row: TelegramStatusRow | null;
  cancelled: boolean;
  onRestart: () => void;
  onAskAgain: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  const expired = start.expiresAt <= now;
  return (
    <>
      <div className="tg-qr-row">
        <HandsfreeQr value={start.deepLink} label={t('telegram.qrLabel')} />
        <p className="tg-hint">{t('telegram.pair.qrHint')}</p>
      </div>
      <button type="button" className="tg-btn tg-btn--primary tg-btn--wide" onClick={() => void openExternalUrl(start.deepLink)} disabled={expired} data-testid="tg-open-link">
        {t('telegram.openInTelegram')}
      </button>
      {expired ? (
        <p className="tg-hint" role="status">{t('telegram.pair.expired')} <button type="button" className="tg-link" onClick={onRestart}>{t('telegram.pair.restart')}</button></p>
      ) : cancelled ? (
        <p className="tg-hint" role="status">{t('telegram.pair.cancelled')} <button type="button" className="tg-link" onClick={onAskAgain}>{t('telegram.pair.askAgain')}</button></p>
      ) : (
        <p className="tg-wait" role="status"><span className="tg-wait-dot" aria-hidden /> {row?.state === 'pending' && row.userLabel ? t('telegram.pair.confirming') : t('telegram.waiting')}</p>
      )}
    </>
  );
}

/** The bound view (plan U "Connected view"). Also drawn by the member section's own sheet. */
export function TelegramConnected({ row, fresh, target, onRemoved }: {
  row: TelegramStatusRow;
  /** Just bound in this sheet: the "Bağlandı" line from the one-tap mockup. */
  fresh: boolean;
  target: string;
  onRemoved: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const invalidate = useInvalidateTelegram();
  const [armed, setArmed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = botLink(row.botUsername);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), DELETE_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const remove = () => {
    if (removing) return;
    if (!armed) { setArmed(true); return; }
    setRemoving(true);
    telegramRoutes(api).unbind(target)
      .then(() => { invalidate(); onRemoved(); })
      .catch(() => { setRemoving(false); setArmed(false); setError(t('telegram.error.generic')); });
  };

  return (
    <div className="tg-connected" data-testid="tg-connected">
      {fresh && <p className="tg-hint" role="status">{t('telegram.connected.fresh')}</p>}
      <dl className="tg-facts">
        <dt>{t('telegram.connected.bot')}</dt><dd>{atName(row.botUsername)}</dd>
        <dt>{t('telegram.connected.who')}</dt><dd>{atName(row.userLabel) || '—'}</dd>
        <dt>{t('telegram.connected.where')}</dt><dd>{t('telegram.connected.thisMac')}</dd>
      </dl>
      <TelegramSees />
      <div className="tg-actions tg-actions--between">
        {link ? <button type="button" className="tg-btn" onClick={() => void openExternalUrl(link)}>{t('telegram.openInTelegram')}</button> : <span />}
        <button type="button" className={`tg-btn tg-btn--danger${armed ? ' is-armed' : ''}`} onClick={remove} disabled={removing} data-testid="tg-unbind">
          {armed ? t('telegram.unbind.confirm') : t('telegram.unbind')}
        </button>
      </div>
      {row.managed && <p className="tg-note">{t('telegram.unbind.managedNote')}</p>}
      {error && <p className="tg-error" role="alert">{error}</p>}
    </div>
  );
}

/** "Telegram ne görür": collapsible, closed by default (plan U, W7). */
export function TelegramSees() {
  const { t } = useI18n();
  return (
    <details className="tg-sees">
      <summary>{t('telegram.sees.title')}</summary>
      <ul>
        <li>{t('telegram.sees.answers')}</li>
        <li>{t('telegram.sees.secrets')}</li>
        <li>{t('telegram.sees.away')}</li>
        <li>{t('telegram.sees.localImages')}</li>
        <li>{t('telegram.sees.twoStep')}</li>
      </ul>
    </details>
  );
}

function refusalText(t: (k: string) => string, e: unknown): string {
  const reason: ShellRefusal = e instanceof TelegramShellError ? e.reason : 'failed';
  return t(`telegram.refusal.${reason}`);
}
