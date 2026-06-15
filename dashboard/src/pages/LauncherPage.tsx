import { useMemo, useState } from 'react';
import {
  useLauncherStatus,
  useUpdateProject,
  useUnregisterVault,
  type VaultStatus,
} from '../hooks/useLauncher';
import { openVaultWindow } from '../lib/desktop';
import { OnboardingWizard } from './OnboardingWizard';
import { LauncherGraph } from './LauncherGraph';
import './LauncherPage.css';

type View = 'cards' | 'graph';

export function LauncherPage() {
  const { data, isLoading, isError, error } = useLauncherStatus();
  const updateProject = useUpdateProject();
  const unregister = useUnregisterVault();
  const [search, setSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [view, setView] = useState<View>('cards');

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
    <div className="launcher">
      <header className="launcher-bar">
        <h1 className="launcher-title">Launcher · all projects</h1>
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
              const dotClass = !vault.exists
                ? 'launcher-card-dot--gone'
                : vault.needsUpdate
                  ? 'launcher-card-dot--stale'
                  : 'launcher-card-dot--ok';
              return (
                <div
                  key={vault.name}
                  className={`launcher-card${vault.exists ? '' : ' launcher-card--gone'}`}
                >
                  <div className="launcher-card-head">
                    <span
                      className={`launcher-card-dot ${dotClass}`}
                      title={
                        !vault.exists
                          ? 'Folder is gone'
                          : vault.needsUpdate
                            ? `Update available: v${vault.setupVersion} → v${vault.latestVersion}`
                            : 'Up to date'
                      }
                      aria-hidden
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
