import { useState, useEffect } from 'react';
import { useI18n } from '../context/I18nContext';
import { useConfig, useUpdateConfig, type PlatformId, type SetupConfig } from '../hooks/useConfig';
import { usePacks } from '../hooks/usePacks';
import { useVaults, useAddVault, useRemoveVault } from '../hooks/useVaults';
import './SettingsPage.css';

// ─── Platform options (duplicated client-side — can't import from src/lib) ────

interface PlatformOption {
  id: PlatformId;
  labelKey: string;
}

const PLATFORM_OPTIONS: PlatformOption[] = [
  { id: 'claude', labelKey: 'settings.platform.claude' },
  { id: 'codex', labelKey: 'settings.platform.codex' },
];

// ─── Default config when config is null ───────────────────────────────────────

const DEFAULT_CONFIG: Pick<SetupConfig, 'platforms' | 'packs'> = {
  platforms: [],
  packs: [],
};

// ─── Component ────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const { t } = useI18n();
  const { data: config, isLoading: configLoading, isError: configError } = useConfig();
  const { data: packsData, isLoading: packsLoading } = usePacks();
  const { data: vaultsData } = useVaults();
  const updateConfig = useUpdateConfig();
  const addVault = useAddVault();
  const removeVault = useRemoveVault();

  const [platforms, setPlatforms] = useState<PlatformId[]>(DEFAULT_CONFIG.platforms);
  const [packs, setPacks] = useState<string[]>(DEFAULT_CONFIG.packs);
  const [dirty, setDirty] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [newVaultName, setNewVaultName] = useState('');
  const [newVaultPath, setNewVaultPath] = useState('');

  // Seed form state from loaded config
  useEffect(() => {
    const base = config ?? DEFAULT_CONFIG;
    setPlatforms(base.platforms);
    setPacks(base.packs);
    setDirty(false);
    setSaveSuccess(false);
  }, [config]);

  if (configLoading || packsLoading) {
    return <div className="loading">{t('common.loading')}</div>;
  }
  if (configError) {
    return <div className="error-state">{t('common.error')}</div>;
  }

  const catalogPacks = packsData?.packs ?? [];
  const vaults = vaultsData?.vaults ?? [];
  const currentVault = vaultsData?.current ?? null;

  const togglePlatform = (id: PlatformId) => {
    setPlatforms((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      setDirty(true);
      setSaveSuccess(false);
      return next;
    });
  };

  const togglePack = (name: string) => {
    setPacks((prev) => {
      const next = prev.includes(name) ? prev.filter((p) => p !== name) : [...prev, name];
      setDirty(true);
      setSaveSuccess(false);
      return next;
    });
  };

  const handleSave = () => {
    updateConfig.mutate(
      { platforms, packs },
      {
        onSuccess: () => {
          setDirty(false);
          setSaveSuccess(true);
        },
      },
    );
  };

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1 className="page-title">{t('settings.title')}</h1>
        <div className="settings-save-row">
          {saveSuccess && !dirty && (
            <span className="settings-saved">{t('settings.saved')}</span>
          )}
          {updateConfig.isError && (
            <span className="settings-error">{t('common.error')}</span>
          )}
          <button
            className="btn btn--primary"
            onClick={handleSave}
            disabled={!dirty || updateConfig.isPending}
          >
            {updateConfig.isPending ? t('settings.saving') : t('settings.save')}
          </button>
        </div>
      </div>

      {config === null && (
        <div className="settings-empty-notice">{t('settings.no_config')}</div>
      )}

      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.platforms')}</h2>
        <div className="settings-checkboxes">
          {PLATFORM_OPTIONS.map(({ id, labelKey }) => (
            <label key={id} className="settings-checkbox-label">
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={platforms.includes(id)}
                onChange={() => togglePlatform(id)}
              />
              <span>{t(labelKey)}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.packs')}</h2>
        {catalogPacks.length === 0 ? (
          <div className="settings-empty">{t('common.empty')}</div>
        ) : (
          <div className="settings-packs-list">
            {catalogPacks.map((pack) => (
              <label key={pack.name} className="settings-pack-item">
                <input
                  type="checkbox"
                  className="settings-checkbox"
                  checked={packs.includes(pack.name)}
                  onChange={() => togglePack(pack.name)}
                />
                <div className="settings-pack-info">
                  <span className="settings-pack-name">{pack.name}</span>
                  {pack.description && (
                    <span className="settings-pack-desc">{pack.description}</span>
                  )}
                </div>
                {packs.includes(pack.name) && (
                  <span className="settings-pack-installed">{t('settings.packs.installed')}</span>
                )}
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.vaults.title')}</h2>
        <p className="settings-vaults-note">{t('settings.vaults.note')}</p>

        <form
          className="settings-vault-add"
          onSubmit={(e) => {
            e.preventDefault();
            addVault.mutate(
              { name: newVaultName.trim(), path: newVaultPath.trim() },
              {
                onSuccess: () => {
                  setNewVaultName('');
                  setNewVaultPath('');
                },
              },
            );
          }}
        >
          <input
            className="settings-vault-add-input"
            type="text"
            placeholder={t('settings.vaults.namePlaceholder')}
            value={newVaultName}
            onChange={(e) => setNewVaultName(e.target.value)}
            disabled={addVault.isPending}
          />
          <input
            className="settings-vault-add-input"
            type="text"
            placeholder={t('settings.vaults.pathPlaceholder')}
            value={newVaultPath}
            onChange={(e) => setNewVaultPath(e.target.value)}
            disabled={addVault.isPending}
          />
          <button
            className="btn btn--primary settings-vault-add-btn"
            type="submit"
            disabled={!newVaultName.trim() || !newVaultPath.trim() || addVault.isPending}
          >
            {addVault.isPending ? t('settings.vaults.adding') : t('settings.vaults.addButton')}
          </button>
          {addVault.isError && (
            <span className="error-state settings-vault-add-error">
              {addVault.error instanceof Error ? addVault.error.message : t('common.error')}
            </span>
          )}
        </form>

        {vaults.length === 0 ? (
          <div className="settings-empty">{t('settings.vaults.empty')}</div>
        ) : (
          <ul className="settings-vaults-list">
            {vaults.map((vault) => (
              <li
                key={vault.path}
                className={`settings-vault-item${vault.path === currentVault ? ' settings-vault-item--current' : ''}`}
              >
                <span className="settings-vault-name">{vault.name}</span>
                <span className="settings-vault-path">{vault.path}</span>
                {vault.path === currentVault && (
                  <span className="settings-vault-current-badge">{t('settings.vaults.current')}</span>
                )}
                <button
                  className="btn btn--ghost settings-vault-remove-btn"
                  type="button"
                  onClick={() => removeVault.mutate(vault.name)}
                  disabled={removeVault.isPending}
                >
                  {t('settings.vaults.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
