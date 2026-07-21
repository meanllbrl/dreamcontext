import { useEffect, useMemo, useState } from 'react';
import {
  useLauncherStatus,
  useUpdateProject,
  useUnregisterVault,
  type VaultStatus,
} from '../hooks/useLauncher';
import { useTeamUpdates, useTeamFetch, type TeamVaultUpdate } from '../hooks/useBrainStatus';
import { openVaultWindow, startTitleBarDrag, toggleMaximizeWindow } from '../lib/desktop';
import { VaultDot } from '../components/layout/VaultDot';
import { TeamUpdatesBadge } from '../components/brain/TeamUpdatesBadge';
import { OnboardingWizard } from './OnboardingWizard';
import { LauncherGraph } from './LauncherGraph';
import './LauncherPage.css';

type View = 'cards' | 'graph';

/** How often the launcher checks every project's brain repo for team pushes (background, cache-friendly). */
const TEAM_FETCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Per-project brain-sync chip: reuses `VaultDot`'s green/yellow/red language
 * (`ok`/`stale`/`gone` mapped onto synced/updates-pending/not-connected) so the
 * card reads with the same at-a-glance vocabulary as the freshness dot above it.
 */
function LauncherBrainChip({ vault }: { vault?: TeamVaultUpdate }) {
  if (!vault || !vault.enabled || vault.mode !== 'full-repo') {
    return (
      <span className="launcher-brain-chip launcher-brain-chip--unconnected" title="Cloud sync not set up for this project">
        <VaultDot exists={false} needsUpdate={false} />
        Set up team sync
      </span>
    );
  }
  if (vault.updates > 0 || vault.pendingAgentMerge) {
    return <TeamUpdatesBadge vaultName={vault.name} />;
  }
  return (
    <span className="launcher-brain-chip launcher-brain-chip--synced" title="Brain repo is up to date">
      <VaultDot exists={true} needsUpdate={false} />
      Synced
    </span>
  );
}

export function LauncherPage() {
  const { data, isLoading, isError, error } = useLauncherStatus();
  const updateProject = useUpdateProject();
  const unregister = useUnregisterVault();
  const [search, setSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [view, setView] = useState<View>('cards');

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

  const vaults = data?.vaults ?? [];

  // Cards is ALWAYS the default surface — the network graph is opt-in via the
  // toggle. (We used to auto-switch to the graph at ≥2 vaults; that surprised
  // users who expected the familiar card list on every launch.)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return vaults;
    return vaults.filter(
      (v) => v.name.toLowerCase().includes(q) || v.path.toLowerCase().includes(q),
    );
  }, [vaults, search]);

  async function openVault(name: string) {
    setActionError(null);
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

  function handleRemove(v: VaultStatus) {
    const msg = v.exists
      ? `Remove “${v.name}” from the launcher? (the folder stays on disk)`
      : `“${v.name}” folder is gone. Remove it from the launcher?`;
    if (!window.confirm(msg)) return;
    setActionError(null);
    unregister.mutate(v.name, {
      onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
    });
  }

  function pickView(v: View) {
    setView(v);
  }

  return (
    <div
      className="launcher"
      // The Launcher window uses TitleBarStyle::Overlay (traffic lights float
      // over the content) and has no native title bar, so without this the
      // window is only draggable from the tiny native strip. The ENTIRE page
      // background is the drag handle (same threshold gesture as the vault
      // Header) — the top bar alone is mostly filled with controls, leaving
      // only a sliver to grab. Cards, the graph board, and the wizard opt out
      // via data-no-drag so their own interactions are never hijacked.
      onMouseDown={startTitleBarDrag}
    >
      <header
        className="launcher-bar"
        onDoubleClick={(e) => void toggleMaximizeWindow(e.target)}
      >
        <div className="launcher-actions">
          {vaults.length >= 2 && (
            <div className="launcher-viewtoggle" role="group" aria-label="View">
              <button
                type="button"
                className={`launcher-btn${view === 'cards' ? ' launcher-btn-active' : ''}`}
                onClick={() => pickView('cards')}
              >
                Cards
              </button>
              <button
                type="button"
                className={`launcher-btn${view === 'graph' ? ' launcher-btn-active' : ''}`}
                onClick={() => pickView('graph')}
              >
                Network
              </button>
            </div>
          )}
          {view === 'cards' && (
            <input
              type="search"
              className="launcher-search"
              placeholder="Search projects…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search projects"
            />
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

      {isLoading && <div className="launcher-status">Loading vaults…</div>}
      {isError && (
        <div className="launcher-error">
          {error instanceof Error ? error.message : 'Failed to load vaults.'}
        </div>
      )}

      {!isLoading && !isError && view === 'graph' && <LauncherGraph />}

      {!isLoading && !isError && view === 'cards' && (
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
                      <LauncherBrainChip vault={brainByVault.get(vault.name)} />
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
