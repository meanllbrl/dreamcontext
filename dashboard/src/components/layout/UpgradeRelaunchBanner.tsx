import { useCallback, useEffect, useRef, useState } from 'react';
import { useServerHealth } from '../../hooks/useServerHealth';
import { useI18n } from '../../context/I18nContext';
import { useApi } from '../../context/VaultContext';
import { isDesktop, quitApp } from '../../lib/desktop';
import { RELAUNCH_POLL_MS, relaunchHeld } from './relaunchGate';
import './UpgradeRelaunchBanner.css';

/**
 * UpgradeRelaunchBanner — the desktop app's automatic self-heal.
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
 * this banner notices it and relaunches the WHOLE app onto the new version — no
 * terminal, no manual quit. A short countdown auto-fires so it's genuinely
 * automatic, with "Later" as an escape hatch. The countdown never STARTS while an
 * agent is mid-work (`agentsWorking`, read from the live processes — relaunchGate.ts):
 * it holds, says so, and restarts from 20 once every tab is between turns, so an update
 * never cuts a turn, a background shell or a sub-agent off. Renders nothing when there's
 * no pending upgrade or off-desktop.
 */
const COUNTDOWN_SECONDS = 20;
// If a "successful" relaunch hasn't torn this window down within this grace period,
// the quit silently no-op'd (e.g. OS-level close suppression) — surface the manual
// fallback instead of a permanent "Relaunching…". A real relaunch unmounts first.
const RELAUNCH_STUCK_MS = 8_000;

export function UpgradeRelaunchBanner() {
  const { t } = useI18n();
  const api = useApi();
  const [polling, setPolling] = useState(false);
  const { health, refetch } = useServerHealth({ refetchInterval: polling ? RELAUNCH_POLL_MS : false });
  const ready = health?.upgradeReady ?? null;
  const running = __DC_VERSION__;
  // Only desktop can relaunch itself; only act on a CONFIRMED newer version.
  const active = isDesktop() && !!ready && ready !== running;
  const held = relaunchHeld(health?.agentsWorking);
  useEffect(() => setPolling(active), [active]);

  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  const [deferred, setDeferred] = useState(false);
  const [relaunching, setRelaunching] = useState(false);
  const [failed, setFailed] = useState(false);
  const firedRef = useRef(false);

  const doRelaunch = useCallback(async () => {
    if (firedRef.current) return;
    firedRef.current = true;
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

  // An agent at work holds the countdown and resets it: when the work ends, the owner gets
  // the full, visible countdown again rather than whatever was left.
  useEffect(() => {
    if (held) setSecondsLeft(COUNTDOWN_SECONDS);
  }, [held]);

  // Countdown ticker — runs only while a relaunch is pending, not deferred/failed/held.
  useEffect(() => {
    if (!active || deferred || relaunching || failed || held) return;
    if (secondsLeft <= 0) {
      // Ask once more at the moment of firing: a turn may have started inside the last poll.
      let cancelled = false;
      void refetch()
        .catch(() => undefined)
        .then((fresh) => {
          if (cancelled || relaunchHeld(fresh?.agentsWorking)) return;
          void doRelaunch();
        });
      return () => { cancelled = true; };
    }
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [active, deferred, relaunching, failed, held, secondsLeft, doRelaunch, refetch]);

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
  const message = relaunching
    ? t('upgradeRelaunch.relaunching')
    : failed
      ? t('upgradeRelaunch.failed')
      : deferred
        ? t('upgradeRelaunch.deferred').replace('{version}', version)
        : held
          ? t('upgradeRelaunch.waiting')
              .replace('{version}', version)
              .replace('{count}', String(health?.agentsWorking ?? 0))
          : t('upgradeRelaunch.countdown')
            .replace('{version}', version)
            .replace('{seconds}', String(secondsLeft));

  return (
    <div className="upgrade-relaunch-banner" role="status" aria-live="polite">
      <span className="upgrade-relaunch-msg">{message}</span>
      {!relaunching && (
        <span className="upgrade-relaunch-actions">
          <button
            className="upgrade-relaunch-btn upgrade-relaunch-btn--primary"
            onClick={() => void doRelaunch()}
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
