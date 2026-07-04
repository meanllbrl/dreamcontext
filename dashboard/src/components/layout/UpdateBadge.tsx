import { useState, useEffect, useCallback, useRef } from 'react';
import { useVersionCheck } from '../../hooks/useVersionCheck';
import { MarkdownPreview } from '../core/MarkdownPreview';
import { useI18n } from '../../context/I18nContext';
import { api } from '../../api/client';
import { closeCurrentWindow } from '../../lib/desktop';
import './UpdateBadge.css';

/**
 * UpdateBadge — the header "Update available" pill.
 *
 * Clicking it opens a popover that ACTUALLY performs the upgrade rather than
 * just showing text: the "Upgrade everything" button runs the same
 * `dreamcontext upgrade --yes` the CLI exposes (CLI + this desktop app + every
 * registered project) as one background job, streams its log, and then offers to
 * relaunch the app so the new version takes effect.
 *
 * Renders nothing when there is no nudge (header layout unchanged).
 */
interface UpdateBadgeProps {
  /** Navigate to the Packs page (where per-pack install/remove buttons live). */
  onManagePacks?: () => void;
}

type UpgradePhase = 'idle' | 'running' | 'done' | 'error';

interface UpgradeStatus {
  state: UpgradePhase;
  output: string;
}

const POLL_MS = 1200;

export function UpdateBadge({ onManagePacks }: UpdateBadgeProps) {
  const { t } = useI18n();
  const { data } = useVersionCheck();
  const nudge = data?.nudge ?? null;
  const newPacks = data?.newPacks ?? [];
  const cliOutdated = data?.cliOutdated ?? false;
  const currentCli = data?.currentCli ?? null;
  const latestCli = data?.latestCli ?? null;
  const [expanded, setExpanded] = useState(false);

  const [phase, setPhase] = useState<UpgradePhase>('idle');
  const [log, setLog] = useState('');
  const [relaunching, setRelaunching] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const applyStatus = useCallback((s: UpgradeStatus) => {
    setLog(s.output);
    if (s.state === 'done' || s.state === 'error') {
      setPhase(s.state);
      stopPolling();
    } else if (s.state === 'running') {
      setPhase('running');
    }
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(() => {
      api.get<UpgradeStatus>('/launcher/upgrade/status')
        .then(applyStatus)
        .catch(() => { /* transient — keep polling */ });
    }, POLL_MS);
  }, [applyStatus, stopPolling]);

  // Restore an in-flight OR just-finished upgrade on (re)mount — popover closed+reopened,
  // window reloaded mid-upgrade, or an upgrade that completed but wasn't relaunched yet. We
  // must surface `done`/`error` too, not just `running`: otherwise a finished-but-unrelaunched
  // upgrade reappears as the fresh "Upgrade everything" idle button, and clicking it POSTs a
  // whole redundant re-upgrade (server state is `done`, not `running`, so it starts over).
  useEffect(() => {
    let cancelled = false;
    api.get<UpgradeStatus>('/launcher/upgrade/status')
      .then((s) => {
        if (cancelled || s.state === 'idle') return;
        applyStatus(s);                          // restores the done/error surface + log tail
        if (s.state === 'running') startPolling(); // only a live job needs polling
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [applyStatus, startPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startUpgrade = useCallback(async () => {
    setPhase('running');
    setLog('');
    try {
      await api.post('/launcher/upgrade', {});
      startPolling();
    } catch (e) {
      setPhase('error');
      setLog(e instanceof Error ? e.message : 'Failed to start the upgrade.');
    }
  }, [startPolling]);

  const relaunch = useCallback(async () => {
    setRelaunching(true);
    try {
      const r = await api.post<{ ok?: boolean; reason?: string }>('/launcher/relaunch', {});
      if (r?.ok) {
        // The detached relauncher WILL reopen the app after this window closes. Only then is
        // it safe to quit — the window is going away, so no need to reset state.
        await closeCurrentWindow();
        return;
      }
      // Nothing will reopen the app (not installed / stale manifest). Closing here would quit
      // into a dead end with no way back — so keep the window open and tell the user instead.
      setLog((prev) => `${prev}\n\nCouldn't relaunch automatically (${r?.reason ?? 'app not installed'}). Reopen the app manually to finish.`.trimStart());
    } catch {
      // Couldn't even reach the relaunch service — same rule: don't quit into a dead end.
      setLog((prev) => `${prev}\n\nCouldn't reach the relaunch service. Reopen the app manually to finish.`.trimStart());
    }
    setRelaunching(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't let Escape dismiss the popover mid-upgrade — the user would lose
      // sight of the running job (it keeps running, but the affordance vanishes).
      if (e.key === 'Escape' && expanded && phase !== 'running') {
        setExpanded(false);
      }
    },
    [expanded, phase],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Show whenever there's genuinely something to upgrade: a newer CLI, new packs,
  // or any prose nudge. `cliOutdated` matters most in the desktop app, where the
  // prose CLI line is suppressed but the app can still perform the upgrade.
  const hasUpdate = cliOutdated || newPacks.length > 0 || !!nudge;
  if (!hasUpdate) return null;

  const versionLine =
    cliOutdated && currentCli && latestCli ? `v${currentCli} → v${latestCli}` : null;

  const busy = phase === 'running' || relaunching;

  return (
    <div className="update-badge">
      <button
        className="update-badge-trigger"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        title={t('update.title')}
      >
        <span className={`update-badge-dot ${phase === 'running' ? 'update-badge-dot--busy' : ''}`} />
        <span className="update-badge-label">
          {phase === 'running' ? t('update.upgrading') : t('update.available')}
        </span>
      </button>
      {expanded && (
        <div className="update-badge-popover">
          <div className="update-badge-popover-header">
            <span className="update-badge-popover-title">{t('update.title')}</span>
            <button
              className="update-badge-dismiss"
              onClick={() => setExpanded(false)}
              disabled={phase === 'running'}
              title={t('update.dismiss')}
              aria-label={t('update.dismiss')}
            >
              ×
            </button>
          </div>

          {/* Running / done / error → the live upgrade surface. */}
          {phase !== 'idle' ? (
            <div className="update-badge-content">
              <div className={`update-badge-status update-badge-status--${phase}`}>
                {phase === 'running' && <span className="update-badge-spinner" aria-hidden="true" />}
                <span className="update-badge-status-text">
                  {phase === 'running' && t('update.upgrading')}
                  {phase === 'done' && t('update.upgraded')}
                  {phase === 'error' && t('update.upgradeFailed')}
                </span>
              </div>
              {log && <pre className="update-badge-log">{log}</pre>}
              {phase === 'done' && <p className="update-badge-note">{t('update.relaunchHint')}</p>}
            </div>
          ) : (
            <div className="update-badge-content">
              {versionLine && <p className="update-badge-version">{versionLine}</p>}
              <p className="update-badge-hint">{t('update.upgradeHint')}</p>
              {nudge && (
                <details className="update-badge-details">
                  <summary>{t('update.title')}</summary>
                  <MarkdownPreview content={nudge} />
                </details>
              )}
            </div>
          )}

          {/* Action row — the button changes with the phase. */}
          {phase === 'idle' && (
            <button className="update-badge-action" onClick={startUpgrade} disabled={busy}>
              {t('update.upgradeAll')}
            </button>
          )}
          {phase === 'done' && (
            <button className="update-badge-action" onClick={relaunch} disabled={relaunching}>
              {t('update.relaunch')}
            </button>
          )}
          {phase === 'error' && (
            <button className="update-badge-action" onClick={startUpgrade} disabled={busy}>
              {t('update.retry')}
            </button>
          )}

          {/* New-packs shortcut stays available when we're not mid-upgrade. */}
          {phase === 'idle' && newPacks.length > 0 && onManagePacks && (
            <button
              className="update-badge-action update-badge-action--secondary"
              onClick={() => {
                onManagePacks();
                setExpanded(false);
              }}
            >
              {t('update.managePacks')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
