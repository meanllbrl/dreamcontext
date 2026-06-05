import { useState, useEffect } from 'react';
import { useI18n } from '../context/I18nContext';
import { useConfig, useUpdateConfig, type PlatformId, type SetupConfig } from '../hooks/useConfig';
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

const DEFAULT_CONFIG: Pick<SetupConfig, 'platforms' | 'disableNativeMemory'> = {
  platforms: [],
  disableNativeMemory: true,
};

// ─── Component ────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const { t } = useI18n();
  const { data: config, isLoading: configLoading, isError: configError } = useConfig();
  const updateConfig = useUpdateConfig();

  const [platforms, setPlatforms] = useState<PlatformId[]>(DEFAULT_CONFIG.platforms);
  const [disableNativeMemory, setDisableNativeMemory] = useState<boolean>(
    DEFAULT_CONFIG.disableNativeMemory,
  );
  const [dirty, setDirty] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Seed form state from loaded config
  useEffect(() => {
    const base = config ?? DEFAULT_CONFIG;
    setPlatforms(base.platforms);
    setDisableNativeMemory(base.disableNativeMemory ?? true);
    setDirty(false);
    setSaveSuccess(false);
  }, [config]);

  if (configLoading) {
    return <div className="loading">{t('common.loading')}</div>;
  }
  if (configError) {
    return <div className="error-state">{t('common.error')}</div>;
  }

  const togglePlatform = (id: PlatformId) => {
    setPlatforms((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      setDirty(true);
      setSaveSuccess(false);
      return next;
    });
  };

  const toggleNativeMemory = () => {
    setDisableNativeMemory((prev) => !prev);
    setDirty(true);
    setSaveSuccess(false);
  };

  const handleSave = () => {
    updateConfig.mutate(
      { platforms, disableNativeMemory },
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
        <h2 className="settings-section-title">{t('settings.memory')}</h2>
        <div className="settings-checkboxes">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={disableNativeMemory}
              onChange={toggleNativeMemory}
            />
            <span>{t('settings.native_memory.label')}</span>
          </label>
          <p className="settings-field-hint">{t('settings.native_memory.hint')}</p>
        </div>
      </section>
    </div>
  );
}
