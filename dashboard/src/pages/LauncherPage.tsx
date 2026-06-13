import { useMemo, useState } from 'react';
import { useVaults, type Vault } from '../hooks/useConnections';
import { openVaultWindow } from '../lib/desktop';
import { OnboardingWizard } from './OnboardingWizard';
import './LauncherPage.css';

export function LauncherPage() {
  const { data, isLoading, isError, error } = useVaults();
  const [search, setSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

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
    try {
      await openVaultWindow(name);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="launcher">
      <header className="launcher-bar">
        <h1 className="launcher-title">Launcher · all projects</h1>
        <div className="launcher-actions">
          <input
            type="search"
            className="launcher-search"
            placeholder="Search projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search projects"
          />
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

      {!isLoading && !isError && filtered.length === 0 && (
        <div className="launcher-empty">
          {vaults.length === 0
            ? 'No projects yet. Use “+ Add Project” to create one or set up an existing folder.'
            : 'No projects match your search.'}
        </div>
      )}

      <div className="launcher-grid">
        {filtered.map((vault: Vault) => (
          <button
            key={vault.name}
            type="button"
            className="launcher-card"
            onClick={() => openVault(vault.name)}
          >
            <div className="launcher-card-head">
              <span className="launcher-card-dot" aria-hidden />
              <span className="launcher-card-name">{vault.name}</span>
            </div>
            <div className="launcher-card-path">{vault.path}</div>
            <div className="launcher-card-open">Open →</div>
          </button>
        ))}
      </div>

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
