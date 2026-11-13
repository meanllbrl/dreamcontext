import { useI18n } from '../../context/I18nContext';
import { useVault } from '../../context/VaultContext';
import { useGitHubAccess } from '../../hooks/useBrainStatus';
import { useGitHubReconnect } from '../../hooks/useGitHubReconnect';
import { buildAppLink } from '../../lib/appLink';
import { GitHubMark } from './GitHubLogin';
import './GitHubLogin.css';

/**
 * The one-click GitHub sign-in where a failure shows (plan D4): one button that starts the
 * device flow in place, then the code (already copied) while GitHub waits for approval.
 * In a browser-served dashboard the sign-in lives in the app, so this says so and links there
 * instead of drawing a button that cannot work.
 */
export function GitHubReconnect({ connect = false, className = 'btn btn--primary', onDone }: {
  /** "Connect GitHub" (nobody signed in) instead of "Reconnect GitHub". */
  connect?: boolean;
  className?: string;
  /** Runs once GitHub approved (the sync bar retries its sync). */
  onDone?: () => void;
}) {
  const { t } = useI18n();
  const { vault } = useVault();
  const { state } = useGitHubAccess();
  const r = useGitHubReconnect(onDone);

  if (state === 'desktopOnly') return <GitHubInApp vault={vault} />;

  if (r.phase === 'waiting' && r.code) {
    return (
      <div className="gh-reconnect gh-reconnect--waiting" role="status">
        <span className="gh-reconnect-code">{r.code.userCode}</span>
        <span className="gh-reconnect-hint">{r.copied ? t('github.reconnect.copied') : t('brain.auth.device.hint')}</span>
        <a className="gh-reconnect-link" href={r.code.verificationUri} target="_blank" rel="noreferrer">{t('brain.auth.device.open')}</a>
        <button type="button" className="gh-reconnect-link" onClick={r.cancel}>{t('common.cancel')}</button>
      </div>
    );
  }
  return (
    <span className="gh-reconnect">
      <button type="button" className={`${className} gh-reconnect-btn`} onClick={() => void r.start()} disabled={r.phase === 'starting'}>
        <GitHubMark size={14} />
        {r.phase === 'starting' ? t('brain.auth.device.starting') : connect ? t('github.connect') : t('brain.recovery.reconnect')}
      </button>
      {r.phase === 'error' && r.error && <span className="gh-reconnect-err" role="alert">{r.error}</span>}
    </span>
  );
}

/** "GitHub bağlantısı uygulamada yönetilir · Uygulamada aç": never "not connected" in a browser. */
export function GitHubInApp({ vault, linkOnly = false }: {
  vault: string | null | undefined;
  /** Only the link, where the row already says it is managed in the app (say it once). */
  linkOnly?: boolean;
}) {
  const { t } = useI18n();
  if (linkOnly) return vault ? <a className="gh-reconnect-link" href={buildAppLink({ kind: 'page', vault, page: 'settings', id: null })}>{t('github.openInApp')}</a> : null;
  return (
    <span className="gh-reconnect gh-reconnect--inapp">
      {t('github.desktopOnly')}
      {vault && <> · <a className="gh-reconnect-link" href={buildAppLink({ kind: 'page', vault, page: 'settings', id: null })}>{t('github.openInApp')}</a></>}
    </span>
  );
}

/**
 * One line for a surface that USES the GitHub sign-in (Team sync, Task mirroring): who it is,
 * and where it is managed; red with one-click Reconnect when GitHub rejected it.
 */
export function GitHubStatusLine({ onOpen }: { onOpen?: () => void }) {
  const { t } = useI18n();
  const { vault } = useVault();
  const { state, auth } = useGitHubAccess();
  if (state === 'loading') return null;
  if (state === 'desktopOnly') return <GitHubInApp vault={vault} />;
  const link = <button type="button" className="gh-reconnect-link" onClick={onOpen}>{t('github.where')}</button>;
  if (state === 'expired') {
    return (
      <span className="gh-status gh-status--bad">
        {t('github.line.expired')} · {link} <GitHubReconnect className="sw-btn sw-btn--accent" />
      </span>
    );
  }
  if (state === 'signedOut') {
    return <span className="gh-status">{t('github.line.signedOut')} · {link}</span>;
  }
  return <span className="gh-status">{t('github.line.connected').replace('{login}', auth?.login ?? 'GitHub')} · {link}</span>;
}
