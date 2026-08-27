import { useEffect, useMemo, useState } from 'react';
import {
  useLauncherStatus,
  useUpdateProject,
  useUnregisterVault,
  useTouchVault,
  useUpdateAllProjects,
  type VaultStatus,
} from '../hooks/useLauncher';
import { useTeamUpdates, useTeamFetch } from '../hooks/useBrainStatus';
import {
  confirmAction, openMeetingWindow, openVaultWindow, startTitleBarDrag, toggleMaximizeWindow,
} from '../lib/desktop';
import { VaultDot } from '../components/layout/VaultDot';
import { VaultLogo, useVaultLogoPicker, useVaultLogoMenu } from '../components/layout/VaultLogo';
import { VaultSyncChip } from '../components/brain/VaultSyncChip';
import { OnboardingWizard } from './OnboardingWizard';
import { SpaceLauncher } from './space/SpaceLauncher';
import {
  initLauncherViewFromServer,
  readLauncherViewLocal,
  writeLauncherView,
  type LauncherView,
} from '../lib/launcherPrefs';
import './LauncherPage.css';

/**
 * `space` IS the launcher — projects in orbit, with federation drawn in the same
 * sky. `list` is the plain fallback for when you want names in a column (very
 * long project lists, muscle memory). The old separate `graph` ("Network") view
 * is gone: its wiring now lives in the Space, so there is ONE surface answering
 * both "where are my projects" and "how are they related" instead of two that
 * had to be kept in sync.
 *
 * The choice is persisted SERVER-side (`lib/launcherPrefs.ts`), not just in
 * localStorage: the desktop shell picks a new loopback port every launch, so a
 * localStorage-only pick was wiped on every restart.
 */

/** How often the launcher checks every project's brain repo for team pushes (background, cache-friendly). */
const TEAM_FETCH_INTERVAL_MS = 5 * 60 * 1000;

export function LauncherPage() {
  const { data, isLoading, isError, error } = useLauncherStatus();
  const updateProject = useUpdateProject();
  const unregister = useUnregisterVault();
  const touch = useTouchVault();
  const updateAll = useUpdateAllProjects();
  const [search, setSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  /**
   * `null` until we know the answer. On a fresh launch the origin is new, so the
   * localStorage mirror is empty and only the server file knows what was picked —
   * rendering List in the meantime would flash the wrong surface, so the body is
   * withheld for the one localhost round-trip it takes to find out.
   */
  const [view, setView] = useState<LauncherView | null>(readLauncherViewLocal);
  /** How many projects `Update all` has got through, for the button's counter. */
  const [updateAllDone, setUpdateAllDone] = useState(0);
  /** One hidden file input + the right-click menu that opens it — see VaultLogo.tsx.
   *  The setter deliberately has NO visible button: right-click the card. */
  const logoPicker = useVaultLogoPicker(setActionError);
  const logoMenu = useVaultLogoMenu(logoPicker.pick);

  const { data: teamVaults } = useTeamUpdates();
  const teamFetch = useTeamFetch();
  const brainByVault = useMemo(
    () => new Map((teamVaults ?? []).map((v) => [v.name, v])),
    [teamVaults],
  );

  // Background team-fetch: a real (but cache-friendly) pull-only check across
  // every registered project's brain repo, so the per-card chip reflects
  // teammates' pushes without the user opening each vault. Fires once on
  // mount, then on an interval — never on every render.
  useEffect(() => {
    teamFetch.mutate(undefined);
    const id = setInterval(() => teamFetch.mutate(undefined), TEAM_FETCH_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve the remembered surface. Only when the local mirror is empty, which
  // means this is the first window of a fresh launch (new port → new origin →
  // empty localStorage) — once it is seeded, the mirror IS the server's answer
  // and re-reading would only race the user's own click.
  useEffect(() => {
    if (view !== null) return;
    let cancelled = false;
    void initLauncherViewFromServer().then((v) => {
      if (!cancelled) setView((prev) => prev ?? v);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const vaults = data?.vaults ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return vaults;
    return vaults.filter(
      (v) => v.name.toLowerCase().includes(q) || v.path.toLowerCase().includes(q),
    );
  }, [vaults, search]);

  async function openVault(name: string) {
    setActionError(null);
    // Recency drives orbital radius in the Space view, so every open stamps the
    // registry. Fire-and-forget: a failed stamp must never block the open.
    touch.mutate(name);
    try {
      await openVaultWindow(name);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleUpdate(name: string) {
    setActionError(null);
    updateProject.mutate(name, {
      onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
    });
  }

  async function handleRemove(v: VaultStatus) {
    const ok = await confirmAction({
      title: `Remove “${v.name}” from the launcher?`,
      body: v.exists ? 'The folder stays on disk.' : 'Its folder is gone from disk.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setActionError(null);
    unregister.mutate(v.name, {
      onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
    });
  }

  /** Every project the running CLI could bring forward right now. */
  const stale = useMemo(() => vaults.filter((v) => v.exists && v.needsUpdate), [vaults]);

  function handleUpdateAll() {
    if (stale.length === 0) return;
    setActionError(null);
    setUpdateAllDone(0);
    updateAll.mutate(
      { names: stale.map((v) => v.name), onProgress: setUpdateAllDone },
      {
        onSuccess: (result) => {
          // Partial failure is the interesting case: say exactly which projects
          // are still behind instead of a silent "done".
          if (result.failed.length > 0) {
            setActionError(
              `Updated ${result.updated.length} of ${stale.length}. Failed: ` +
                result.failed.map((f) => `${f.name} (${f.message})`).join(', '),
            );
          }
        },
        onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
      },
    );
  }

  function pickView(v: LauncherView) {
    setView(v);
    writeLauncherView(v);
  }

  return (
    <div
      className={`launcher${view === 'space' ? ' launcher--space' : ''}`}
      // The Launcher window uses TitleBarStyle::Overlay (traffic lights float
      // over the content) and has no native title bar, so without this the
      // window is only draggable from the tiny native strip. The ENTIRE page
      // background is the drag handle (same threshold gesture as the vault
      // Header) — the top bar alone is mostly filled with controls, leaving
      // only a sliver to grab. Cards, the Space, and the wizard opt out via
      // data-no-drag so their own interactions are never hijacked.
      onMouseDown={startTitleBarDrag}
    >
      <header
        className="launcher-bar"
        onDoubleClick={(e) => void toggleMaximizeWindow(e.target)}
      >
        <div className="launcher-actions">
          <div className="launcher-viewtoggle" role="group" aria-label="View">
            <button
              type="button"
              className={`launcher-btn${view === 'space' ? ' launcher-btn-active' : ''}`}
              onClick={() => pickView('space')}
            >
              Space
            </button>
            <button
              type="button"
              className={`launcher-btn${view === 'list' ? ' launcher-btn-active' : ''}`}
              onClick={() => pickView('list')}
            >
              List
            </button>
          </div>
          <input
            type="search"
            className="launcher-search"
            placeholder="Search projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search projects"
          />
          {stale.length > 0 && (
            <button
              type="button"
              className="launcher-btn launcher-btn-update"
              disabled={updateAll.isPending}
              title={`Run dreamcontext update in: ${stale.map((v) => v.name).join(', ')}`}
              onClick={handleUpdateAll}
            >
              {updateAll.isPending
                ? `Updating ${updateAllDone}/${stale.length}…`
                : `Update all (${stale.length})`}
            </button>
          )}
          <button
            type="button"
            className="launcher-btn launcher-btn-primary"
            onClick={() => setWizardOpen(true)}
          >
            + Add Project
          </button>
        </div>
      </header>

      {actionError && <div className="launcher-error">{actionError}</div>}
      {/* The hidden file input + the right-click menu that opens it — rendered once. */}
      {logoPicker.input}
      {logoMenu.element}

      {(isLoading || view === null) && <div className="launcher-status">Loading vaults…</div>}
      {isError && (
        <div className="launcher-error">
          {error instanceof Error ? error.message : 'Failed to load vaults.'}
        </div>
      )}

      {!isLoading && !isError && view === 'space' && (
        <SpaceLauncher
          query={search}
          onAddProject={() => setWizardOpen(true)}
          onOpenMeetingRoom={() => void openMeetingWindow()}
          onError={setActionError}
        />
      )}

      {!isLoading && !isError && view === 'list' && (
        <>
          {filtered.length === 0 && (
            <div className="launcher-empty">
              {vaults.length === 0
                ? 'No projects yet. Use “+ Add Project” to create one or set up an existing folder.'
                : 'No projects match your search.'}
            </div>
          )}

          <div className="launcher-grid">
            {filtered.map((vault) => {
              return (
                <div
                  key={vault.name}
                  className={`launcher-card${vault.exists ? '' : ' launcher-card--gone'}`}
                  // Cards keep normal pointer behaviour (text selection on the
                  // path, hover states) — only the empty background drags.
                  data-no-drag
                  // The logo setter lives behind right-click — a once-per-project act
                  // does not earn a permanent button on every card.
                  onContextMenu={vault.exists ? (e) => logoMenu.open(e, vault.name, vault.logo) : undefined}
                >
                  <div className="launcher-card-head">
                    <VaultDot
                      exists={vault.exists}
                      needsUpdate={vault.needsUpdate}
                      title={
                        !vault.exists
                          ? 'Folder is gone'
                          : vault.needsUpdate
                            ? `Update available: v${vault.setupVersion} → v${vault.latestVersion}`
                            : 'Up to date'
                      }
                    />
                    {/* The project's own face (`assets/logo.*` in its vault), beside — not
                        instead of — the status dot: the dot is health, the logo is identity. */}
                    <VaultLogo name={vault.name} hasLogo={vault.logo} stamp={vault.logoStamp} />
                    <span className="launcher-card-name">{vault.name}</span>
                  </div>
                  <div className="launcher-card-path">{vault.path}</div>

                  {!vault.exists && (
                    <div className="launcher-card-warn">Folder no longer exists on disk.</div>
                  )}
                  {vault.exists && vault.needsUpdate && (
                    <div className="launcher-card-warn launcher-card-warn--stale">
                      Skills out of date — v{vault.setupVersion} → v{vault.latestVersion}.
                    </div>
                  )}

                  {vault.exists && (
                    <div className="launcher-card-brain">
                      <VaultSyncChip vault={brainByVault.get(vault.name)} />
                    </div>
                  )}

                  <div className="launcher-card-actions">
                    {vault.exists && (
                      <button
                        type="button"
                        className="launcher-card-open launcher-link-btn"
                        onClick={() => openVault(vault.name)}
                      >
                        Open →
                      </button>
                    )}
                    {vault.exists && vault.needsUpdate && (
                      <button
                        type="button"
                        className="launcher-btn launcher-btn-update"
                        disabled={updateProject.isPending}
                        onClick={() => handleUpdate(vault.name)}
                      >
                        {updateProject.isPending && updateProject.variables === vault.name
                          ? 'Updating…'
                          : 'Update'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="launcher-btn launcher-btn-remove"
                      disabled={unregister.isPending}
                      onClick={() => handleRemove(vault)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {wizardOpen && (
        <OnboardingWizard
          onClose={() => setWizardOpen(false)}
          onReady={async (vaultName) => {
            setWizardOpen(false);
            await openVault(vaultName);
          }}
        />
      )}
    </div>
  );
}
