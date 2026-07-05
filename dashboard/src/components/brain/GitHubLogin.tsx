import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import {
  useAuthStatus,
  useDeviceStart,
  useDevicePoll,
  useSubmitPatToken,
  useLogoutGitHub,
} from '../../hooks/useBrainStatus';
import './GitHubLogin.css';

/** The GitHub octocat mark — reused by the Sidebar CTA so both surfaces read as one brand. */
export function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

type DeviceFlowPhase = 'idle' | 'starting' | 'waiting' | 'error';

const MAX_POLL_ATTEMPTS = 300; // ~ generous ceiling; real bound is expiresIn

/**
 * The "sign into dreamcontext with GitHub" surface. B1: OAuth device flow —
 * shows the user_code + an "Open GitHub" link, polls on the SERVER-returned
 * interval (honoring `slow_down`), lands the token in the global 0600 secrets
 * store server-side. B2: a loud scope disclosure ("this grants access to all
 * your private repositories") plus a fine-grained-PAT recommendation that
 * reveals a paste-in fallback.
 */
export function GitHubLogin() {
  const { t } = useI18n();
  const { data: authStatus, isLoading } = useAuthStatus();
  const deviceStart = useDeviceStart();
  const devicePoll = useDevicePoll();
  const submitPat = useSubmitPatToken();
  const logout = useLogoutGitHub();

  const [phase, setPhase] = useState<DeviceFlowPhase>('idle');
  const [deviceInfo, setDeviceInfo] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [showPatForm, setShowPatForm] = useState(false);
  const [patValue, setPatValue] = useState('');
  const [patError, setPatError] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const stoppedRef = useRef(false);

  const stopPolling = useCallback(() => {
    stoppedRef.current = true;
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const schedulePoll = useCallback((sessionId: string, intervalSeconds: number) => {
    if (stoppedRef.current) return;
    pollTimer.current = setTimeout(async () => {
      if (stoppedRef.current) return;
      attemptsRef.current += 1;
      if (attemptsRef.current > MAX_POLL_ATTEMPTS) {
        setPhase('error');
        setDeviceError(t('brain.auth.device.expired'));
        return;
      }
      try {
        const result = await devicePoll.mutateAsync(sessionId);
        if (stoppedRef.current) return;
        switch (result.status) {
          case 'authorized':
            stopPolling();
            setPhase('idle');
            setDeviceInfo(null);
            break;
          case 'slow_down':
            schedulePoll(sessionId, result.interval);
            break;
          case 'pending':
            schedulePoll(sessionId, intervalSeconds);
            break;
          case 'expired':
            stopPolling();
            setPhase('error');
            setDeviceError(t('brain.auth.device.expired'));
            break;
          case 'denied':
            stopPolling();
            setPhase('error');
            setDeviceError(t('brain.auth.device.denied'));
            break;
          default:
            stopPolling();
            setPhase('error');
            setDeviceError(result.message ?? t('brain.auth.device.error'));
        }
      } catch (err) {
        stopPolling();
        setPhase('error');
        setDeviceError(err instanceof Error ? err.message : String(err));
      }
      // The devicePoll mutation invalidates nothing itself — the terminal
      // 'authorized' branch above is what wakes up useAuthStatus.
    }, Math.max(1, intervalSeconds) * 1000);
  }, [devicePoll, stopPolling, t]);

  const startDeviceFlow = async () => {
    setDeviceError(null);
    setPhase('starting');
    stoppedRef.current = false;
    attemptsRef.current = 0;
    try {
      const started = await deviceStart.mutateAsync();
      setDeviceInfo({ userCode: started.userCode, verificationUri: started.verificationUri });
      setPhase('waiting');
      schedulePoll(started.sessionId, started.interval);
    } catch (err) {
      setPhase('error');
      setDeviceError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancelDeviceFlow = () => {
    stopPolling();
    setPhase('idle');
    setDeviceInfo(null);
  };

  const handleSubmitPat = async () => {
    setPatError(null);
    try {
      await submitPat.mutateAsync(patValue.trim());
      setPatValue('');
      setShowPatForm(false);
    } catch (err) {
      setPatError(err instanceof Error ? err.message : String(err));
    }
  };

  if (isLoading) {
    return <p className="settings-field-hint">{t('common.loading')}</p>;
  }

  if (authStatus?.connected) {
    return (
      <div className="gh-login gh-login--connected">
        <span className="gh-login-badge">
          <GitHubMark size={15} />
          {authStatus.login ? t('brain.auth.signedInAs').replace('{login}', authStatus.login) : t('brain.auth.signedIn')}
        </span>
        <button
          type="button"
          className="btn btn--ghost gh-login-logout"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          {t('brain.auth.signOut')}
        </button>
      </div>
    );
  }

  return (
    <div className="gh-login">
      <p className="gh-login-disclosure">{t('brain.auth.scopeDisclosure')}</p>

      {phase === 'waiting' && deviceInfo ? (
        <div className="gh-login-device">
          <p className="gh-login-device-hint">{t('brain.auth.device.hint')}</p>
          <div className="gh-login-code">{deviceInfo.userCode}</div>
          <a
            className="btn btn--primary gh-login-open"
            href={deviceInfo.verificationUri}
            target="_blank"
            rel="noreferrer"
          >
            {t('brain.auth.device.open')}
          </a>
          <p className="gh-login-waiting">
            <span className="gh-login-spinner" aria-hidden="true" />
            {t('brain.auth.device.waiting')}
          </p>
          <button type="button" className="btn btn--ghost" onClick={cancelDeviceFlow}>
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn--primary gh-login-start"
          onClick={startDeviceFlow}
          disabled={phase === 'starting'}
        >
          <GitHubMark size={15} />
          {phase === 'starting' ? t('brain.auth.device.starting') : t('brain.auth.continueWithGithub')}
        </button>
      )}
      {deviceError && <p className="settings-test-err">✗ {deviceError}</p>}

      <button
        type="button"
        className="gh-login-pat-toggle"
        onClick={() => setShowPatForm((v) => !v)}
      >
        {showPatForm ? t('brain.auth.pat.hide') : t('brain.auth.pat.recommend')}
      </button>

      {showPatForm && (
        <div className="gh-login-pat-form">
          <p className="settings-field-hint">{t('brain.auth.pat.hint')}</p>
          <div className="settings-field-row">
            <input
              type="password"
              className="settings-text-input"
              autoComplete="off"
              placeholder={t('brain.auth.pat.placeholder')}
              value={patValue}
              onChange={(e) => setPatValue(e.target.value)}
            />
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleSubmitPat}
              disabled={submitPat.isPending || !patValue.trim()}
            >
              {submitPat.isPending ? t('brain.auth.pat.submitting') : t('brain.auth.pat.submit')}
            </button>
          </div>
          {patError && <p className="settings-test-err">✗ {patError}</p>}
        </div>
      )}
    </div>
  );
}
