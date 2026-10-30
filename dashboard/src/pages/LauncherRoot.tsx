import { useEffect, useState } from 'react';
import { useShellMode } from '../lib/uxMode';
import { readLayoutPrefs } from '../lib/launcherPrefs';
import { appLinksDrained } from '../lib/appLink';
import { findWindowForVault } from '../lib/windowRegistry';
import { isDesktop, vaultWindowLabel } from '../lib/desktop';
import { useLauncherStatus, type VaultStatus } from '../hooks/useLauncher';
import { UpgradeRelaunchBanner } from '../components/layout/UpgradeRelaunchBanner';
import { ProjectSwitcher } from '../components/search/ProjectSwitcher';
import { WindowChrome } from '../components/layout/WindowChrome';
import { LauncherPage } from './LauncherPage';

/** The order the launcher window tries projects in: the last one shown, then by recency.
 *  Only registered projects whose folder still exists. Pure, for launcher-root.test.ts. */
export function launchCandidates(vaults: readonly VaultStatus[], lastVault: string | null): string[] {
  const live = vaults.filter((v) => v.exists);
  const byRecency = [...live].sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '')).map((v) => v.name);
  const last = lastVault && live.some((v) => v.name === lastVault) ? [lastVault] : [];
  return [...last, ...byRecency.filter((n) => n !== lastVault)];
}

/** Held by another OS window (by its label, and by the window registry). */
async function heldElsewhere(name: string): Promise<boolean> {
  if (findWindowForVault(name)) return true;
  if (!isDesktop()) return false;
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    return !!(await WebviewWindow.getByLabel(vaultWindowLabel(name)));
  } catch {
    return false;
  }
}

function TodayLauncher() {
  return (
    <>
      <UpgradeRelaunchBanner />
      <LauncherPage />
      <ProjectSwitcher />
    </>
  );
}

/**
 * The launcher window's root. Classic (or still settling): exactly today's launcher. The new
 * shell: the window opens on the last project instead — `lastVault`, else the most recent —
 * skipping projects another window holds, once a cold-start link has had its chance (the boot
 * drain, capped at 3 s). No candidate, or the list failed: today's launcher.
 */
export function LauncherRoot() {
  const mode = useShellMode();
  const newShell = mode === 'new';
  const { data, isError } = useLauncherStatus(newShell);
  const [pick, setPick] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!newShell || pick !== undefined) return;
    if (isError) { setPick(null); return; }
    if (!data) return;
    let live = true;
    void (async () => {
      await appLinksDrained();
      for (const name of launchCandidates(data.vaults, readLayoutPrefs().lastVault)) {
        if (!(await heldElsewhere(name))) { if (live) setPick(name); return; }
      }
      if (live) setPick(null);
    })();
    return () => { live = false; };
  }, [newShell, data, isError, pick]);

  if (!newShell || pick === null) return <TodayLauncher />;
  if (pick === undefined) return null;
  return <WindowChrome initialVault={pick} />;
}
