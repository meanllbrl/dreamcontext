import { useCallback, useEffect, useRef, useState } from 'react';
import { useServerHealth } from '../../hooks/useServerHealth';
import { useI18n } from '../../context/I18nContext';
import { useApi } from '../../context/VaultContext';
import { isDesktop, quitApp } from '../../lib/desktop';
import { relaunchClick } from './relaunchGate';
import './UpgradeRelaunchBanner.css';

/**
 * UpgradeRelaunchBanner — the desktop app's update-ready strip.
 *
 * The dashboard server is spawned once when the app launches and holds its route
 * table + frontend bundle in memory. After `dreamcontext upgrade` (or a plain
 * `npm i -g dreamcontext@latest`) rewrites the package on disk, that long-lived
 * server keeps serving the OLD build — an old Settings section, old routes — until
 * the app is fully quit and reopened. On macOS nothing did that automatically
 * (the drift self-exit is disabled for the desktop app), so users saw a "stale
 * even though I updated" app on other machines.
 *
 * Fix: the server flags the on-disk upgrade on GET /api/health (`upgradeReady`);
 * this banner notices it and offers to relaunch the WHOLE app onto the new version —
 * no terminal, no manual quit. It NEVER relaunches on its own: a relaunch kills every
 * chat and terminal, so the owner decides (2026-10-29). Nobody clicks, nothing closes.
 * A click while an agent is at work (`agentsWorking`, read from the live processes —
 * relaunchGate.ts) asks first, inline. Renders nothing when there's no pending upgrade
 * or off-desktop.
 */
// If a "successful" relaunch hasn't torn this window down within this grace period,
// the quit silently no-op'd (e.g. OS-level close suppression) — surface the manual
// fallback instead of a permanent "Relaunching…". A real relaunch unmounts first.
const RELAUNCH_STUCK_MS = 8_000;

export function UpgradeRelaunchBanner() {
  const { t } = useI18n();
  const api = useApi();
  const { health, refetch } = useServerHealth();
  const ready = health?.upgradeReady ?? null;
  const running = __DC_VERSION__;
  // Only desktop can relaunch itself; only act on a CONFIRMED newer version.
  const active = isDesktop() && !!ready && ready !== running;

  const [deferred, setDeferred] = useState(false);
  const [relaunching, setRelaunching] = useState(false);
  const [failed, setFailed] = useState(false);
  // How many agents were at work when the owner clicked; set = the inline confirm is open.
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const firedRef = useRef(false);

  const doRelaunch = useCallback(async () => {
    if (firedRef.current) return;
    firedRef.current = true;
    setConfirmCount(null);
    setRelaunching(true);
    setFailed(false);
    try {
      // Arms the server's detached `sleep 2; open <app>` relauncher and reports
      // whether it could (HTTP 200 with { ok }). It returns ok:false — NOT an
      // exception — when the app isn't installed / the manifest is stale.
      const r = await api.post<{ ok?: boolean; reason?: string }>('/launcher/relaunch', {});
      if (r?.ok) {
        // Only NOW is it safe to quit: a detached open WILL reopen the app. The app
        // quits → the stale server dies → the reopened (swapped) bundle spawns a
        // fresh server on the new CLI.
        await quitApp();
        return;
      }
    } catch {
      /* couldn't even reach the relaunch route — treat as failure below */
    }
    // Nothing is armed to reopen the app. Closing windows here would strand the
    // user with a quit app and no way back, so DON'T — surface a manual message
    // and let them retry. (Mirrors UpdateBadge's relaunch guard.)
    firedRef.current = false;
    setRelaunching(false);
    setFailed(true);
  }, [api]);

  // The owner's click. Ask the server at THIS moment (the cached health may be a minute
  // old): agents at work open the inline confirm, none relaunches straight away.
  const onRelaunchClick = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    const fresh = await refetch().catch(() => undefined);
    setChecking(false);
    const working = (fresh ?? health)?.agentsWorking;
    if (relaunchClick(working) === 'confirm') {
      setConfirmCount(working as number);
      return;
    }
    void doRelaunch();
  }, [checking, refetch, health, doRelaunch]);

  // Safety net: a relaunch we believed succeeded should quit the app and unmount
  // this window. If it hasn't after the grace period, the quit no-op'd — flip to
  // the manual fallback so the user is never stuck on a permanent spinner.
  useEffect(() => {
    if (!relaunching) return;
    const id = setTimeout(() => {
      firedRef.current = false;
      setRelaunching(false);
      setFailed(true);
    }, RELAUNCH_STUCK_MS);
    return () => clearTimeout(id);
  }, [relaunching]);

  if (!active) return null;

  const version = ready as string;
  const confirming = confirmCount !== null && !relaunching;
  const message = relaunching
    ? t('upgradeRelaunch.relaunching')
    : confirming
      ? t('upgradeRelaunch.confirm').replace('{count}', String(confirmCount))
      : failed
        ? t('upgradeRelaunch.failed')
        : t(deferred ? 'upgradeRelaunch.deferred' : 'upgradeRelaunch.ready').replace('{version}', version);

  return (
    <div className="upgrade-relaunch-banner" role="status" aria-live="polite">
      <span className="upgrade-relaunch-msg">{message}</span>
      {confirming && (
        <span className="upgrade-relaunch-actions">
          <button
            className="upgrade-relaunch-btn upgrade-relaunch-btn--primary"
            onClick={() => void doRelaunch()}
          >
            {t('upgradeRelaunch.anyway')}
          </button>
          <button className="upgrade-relaunch-btn" onClick={() => setConfirmCount(null)}>
            {t('upgradeRelaunch.cancel')}
          </button>
        </span>
      )}
      {!relaunching && !confirming && (
        <span className="upgrade-relaunch-actions">
          <button
            className="upgrade-relaunch-btn upgrade-relaunch-btn--primary"
            onClick={() => void onRelaunchClick()}
            disabled={checking}
          >
            {failed ? t('upgradeRelaunch.retry') : t('upgradeRelaunch.now')}
          </button>
          {!deferred && !failed && (
            <button className="upgrade-relaunch-btn" onClick={() => setDeferred(true)}>
              {t('upgradeRelaunch.later')}
            </button>
          )}
        </span>
      )}
    </div>
  );
}
