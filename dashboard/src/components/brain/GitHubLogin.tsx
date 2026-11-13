import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAuthStatus, useSubmitPatToken, useLogoutGitHub } from '../../hooks/useBrainStatus';
import { useGitHubReconnect } from '../../hooks/useGitHubReconnect';
import './GitHubLogin.css';

/** The GitHub octocat mark — reused by the Sidebar CTA so both surfaces read as one brand. */
export function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * A different account or a hand-made token: the global sign-in by token. Lives under
 * Settings → GitHub → Advanced (plan D6), and is the only way in when no OAuth App is
 * registered. Never echoes the token back.
 */
export function GitHubPatForm({ hint }: { hint?: string }) {
  const { t } = useI18n();
  const submitPat = useSubmitPatToken();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      await submitPat.mutateAsync(value.trim());
      setValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="gh-login-pat-form">
      <p className="settings-field-hint">{hint ?? t('brain.auth.pat.hint')}</p>
      <div className="settings-field-row">
        <input
          type="password"
          className="settings-text-input"
          autoComplete="off"
          aria-label={t('github.adv.account')}
          placeholder={t('brain.auth.pat.placeholder')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="button" className="btn btn--secondary" onClick={() => void submit()} disabled={submitPat.isPending || !value.trim()}>
          {submitPat.isPending ? t('brain.auth.pat.submitting') : t('brain.auth.pat.submit')}
        </button>
      </div>
      {error && <p className="settings-test-err">✗ {error}</p>}
    </div>
  );
}

/**
 * The "sign into dreamcontext with GitHub" surface: the OAuth device flow (code shown and
 * copied, github.com/login/device opened, polled on the server's interval), landing the token
 * in the global 0600 store server-side. One scope disclosure; no token is asked for here. A
 * token is the fallback only when no OAuth App is registered, otherwise it lives under
 * Settings → GitHub → Advanced.
 */
export function GitHubLogin({ tokenOption = false }: {
  /** Classic Settings only (it has no Advanced section): a folded "another account or token" form. */
  tokenOption?: boolean;
} = {}) {
  const { t } = useI18n();
  const [showToken, setShowToken] = useState(false);
  const { data: authStatus, isLoading } = useAuthStatus();
  const logout = useLogoutGitHub();
  const r = useGitHubReconnect();

  if (isLoading) {
    return <p className="settings-field-hint">{t('common.loading')}</p>;
  }

  const connectControls = authStatus?.oauthConfigured === false ? (
    <div className="gh-login gh-login--pat-primary">
      <p className="gh-login-disclosure">{t('brain.auth.oauthUnavailable')}</p>
      <GitHubPatForm />
    </div>
  ) : (
    <div className="gh-login">
      <p className="gh-login-disclosure">{t('brain.auth.scopeDisclosure')}</p>
      {r.phase === 'waiting' && r.code ? (
        <div className="gh-login-device">
          <p className="gh-login-device-hint">{r.copied ? t('github.reconnect.copied') : t('brain.auth.device.hint')}</p>
          <div className="gh-login-code">{r.code.userCode}</div>
          <a className="btn btn--primary gh-login-open" href={r.code.verificationUri} target="_blank" rel="noreferrer">
            {t('brain.auth.device.open')}
          </a>
          <p className="gh-login-waiting">
            <span className="gh-login-spinner" aria-hidden="true" />
            {t('brain.auth.device.waiting')}
          </p>
          <button type="button" className="btn btn--ghost" onClick={r.cancel}>{t('common.cancel')}</button>
        </div>
      ) : (
        <button type="button" className="btn btn--primary gh-login-start" onClick={() => void r.start()} disabled={r.phase === 'starting'}>
          <GitHubMark size={15} />
          {r.phase === 'starting' ? t('brain.auth.device.starting') : t('brain.auth.continueWithGithub')}
        </button>
      )}
      {r.phase === 'error' && r.error && <p className="settings-test-err">✗ {r.error}</p>}
      {tokenOption && (
        <button type="button" className="gh-login-pat-toggle" onClick={() => setShowToken((v) => !v)}>
          {showToken ? t('brain.auth.pat.hide') : t('github.adv.title')}
        </button>
      )}
      {tokenOption && showToken && <GitHubPatForm />}
    </div>
  );

  // Connected AND the token still authenticates → the resting green badge.
  if (authStatus?.connected && !authStatus?.needsReconnect) {
    return (
      <div className="gh-login gh-login--connected">
        <span className="gh-login-badge">
          <GitHubMark size={15} />
          {authStatus.login ? t('brain.auth.signedInAs').replace('{login}', authStatus.login) : t('brain.auth.signedIn')}
        </span>
        <button type="button" className="btn btn--ghost gh-login-logout" onClick={() => logout.mutate()} disabled={logout.isPending}>
          {t('brain.auth.signOut')}
        </button>
      </div>
    );
  }

  // Connected but GitHub REJECTED the stored token: the invalid chip + an in-place reconnect.
  if (authStatus?.connected && authStatus?.needsReconnect) {
    return (
      <div className="gh-login gh-login--expired">
        <span className="gh-login-badge gh-login-badge--expired">
          <GitHubMark size={15} />
          {authStatus.login ? t('brain.auth.expiredAs').replace('{login}', authStatus.login) : t('brain.auth.expired')}
        </span>
        <p className="settings-field-hint gh-login-expired-hint">{t('brain.auth.expiredHint')}</p>
        {connectControls}
        <button type="button" className="btn btn--ghost gh-login-logout" onClick={() => logout.mutate()} disabled={logout.isPending}>
          {t('brain.auth.signOut')}
        </button>
      </div>
    );
  }

  return connectControls;
}
