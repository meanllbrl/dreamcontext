import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../context/I18nContext';
import { api } from '../api/client';
import { useConfig, useUpdateConfig, type PlatformId, type SetupConfig } from '../hooks/useConfig';
import { SearchableSelect } from '../components/tasks/SearchableSelect';
import { ConnectionsManager } from '../components/settings/ConnectionsManager';
import { isDesktop } from '../lib/desktop';
import {
  readSleepyConfig,
  writeSleepyConfig,
  applySleepyHotkey,
  type SleepyConfig,
} from '../lib/sleepy';
import './SettingsPage.css';

/** Build a Tauri accelerator (e.g. "Alt+Cmd+S") from a keydown; null if incomplete. */
function accelFromKeyEvent(e: React.KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.metaKey) mods.push('Cmd');
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = e.key;
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null; // modifier-only
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else key = key.charAt(0).toUpperCase() + key.slice(1);
  if (mods.length === 0) return null; // a global hotkey needs at least one modifier
  return [...mods, key].join('+');
}

interface RemoteContainer {
  ids: Record<string, string>;
  path: string;
  name: string;
}

interface ProvisionResult {
  created: string[];
  existing: string[];
  backfilled: number;
  errors: string[];
}

interface SyncStatus {
  backend: string;
  pendingPush: number;
  queuedOps: number;
  conflicts: number;
  watermark: number | null;
}

interface ConnectionTestResponse {
  ok: boolean;
  backend: string;
  user?: string;
  error?: string;
  note?: string;
}

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
  const [cloudTasks, setCloudTasks] = useState(false);
  const [taskProvider, setTaskProvider] = useState<'clickup' | 'github'>('clickup');
  const [clickupTeam, setClickupTeam] = useState('');
  const [clickupSpace, setClickupSpace] = useState('');
  const [clickupList, setClickupList] = useState('');
  const [githubOwner, setGithubOwner] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [testResult, setTestResult] = useState<ConnectionTestResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [provisionNote, setProvisionNote] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  // Sleepy notch quick-capture (desktop-only, persisted in localStorage; applies live).
  const [sleepy, setSleepy] = useState<SleepyConfig>(() => readSleepyConfig());
  const [capturingHotkey, setCapturingHotkey] = useState(false);

  const updateSleepy = (next: SleepyConfig) => {
    setSleepy(next);
    writeSleepyConfig(next);
    void applySleepyHotkey(next);
  };

  const { data: syncStatus } = useQuery({
    queryKey: ['tasks-sync-status'],
    queryFn: () => api.get<{ status: SyncStatus }>('/tasks/sync-status'),
    select: (d) => d.status,
  });

  // Pickable lists straight from the remote API — same picker the CLI
  // onboarding uses, so nobody hunts ids out of URLs in the dashboard either.
  const { data: containers } = useQuery({
    queryKey: ['tasks-containers'],
    queryFn: () => api.get<{ containers: RemoteContainer[] }>('/tasks/containers'),
    select: (d) => d.containers,
    enabled: cloudTasks,
    staleTime: 5 * 60 * 1000,
  });

  // Containers carry a backend-specific id bag (ClickUp: teamId/spaceId/listId;
  // GitHub: owner/repo). The picker keys on `path` (the full, human-readable
  // name) so it is provider-agnostic and stays unique across both shapes.
  const handlePickContainer = (path: string | null) => {
    const picked = (containers ?? []).find(c => c.path === path);
    if (!picked) return;
    if (taskProvider === 'github') {
      setGithubOwner(picked.ids.owner ?? '');
      setGithubRepo(picked.ids.repo ?? '');
    } else {
      setClickupTeam(picked.ids.teamId ?? '');
      setClickupSpace(picked.ids.spaceId ?? '');
      setClickupList(picked.ids.listId ?? '');
    }
    markDirty();
  };

  const handleProvision = async () => {
    setProvisioning(true);
    setProvisionNote(null);
    try {
      const { result } = await api.post<{ result: ProvisionResult }>('/tasks/provision', {});
      setProvisionNote(
        result.errors.length > 0
          ? `⚠ ${result.errors[0]}`
          : result.created.length > 0
            ? `✓ Created: ${result.created.join(', ')}${result.backfilled > 0 ? ` · backfilled ${result.backfilled} value(s)` : ''}`
            : '✓ All recommended fields already exist.',
      );
    } catch (err) {
      setProvisionNote(`⚠ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProvisioning(false);
    }
  };

  // Seed form state from loaded config
  useEffect(() => {
    const base = config ?? DEFAULT_CONFIG;
    setPlatforms(base.platforms);
    setDisableNativeMemory(base.disableNativeMemory ?? true);
    const cfg = config as SetupConfig | null;
    setCloudTasks(cfg?.taskBackend === 'clickup' || cfg?.taskBackend === 'github');
    setTaskProvider(cfg?.taskBackend === 'github' ? 'github' : 'clickup');
    setClickupTeam(cfg?.clickup?.teamId ?? '');
    setClickupSpace(cfg?.clickup?.spaceId ?? '');
    setClickupList(cfg?.clickup?.listId ?? '');
    setGithubOwner(cfg?.github?.owner ?? '');
    setGithubRepo(cfg?.github?.repo ?? '');
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
    const taskBackend = cloudTasks ? taskProvider : 'local';
    updateConfig.mutate(
      {
        platforms,
        disableNativeMemory,
        taskBackend,
        ...(cloudTasks && taskProvider === 'clickup'
          ? { clickup: { teamId: clickupTeam || undefined, spaceId: clickupSpace || undefined, listId: clickupList || undefined } }
          : {}),
        ...(cloudTasks && taskProvider === 'github'
          ? { github: { owner: githubOwner || undefined, repo: githubRepo || undefined } }
          : {}),
      },
      {
        onSuccess: () => {
          setDirty(false);
          setSaveSuccess(true);
        },
      },
    );
  };

  const markDirty = () => {
    setDirty(true);
    setSaveSuccess(false);
  };

  // Federation `shareable` is its own control plane — persisted immediately via
  // PATCH /api/config (not buffered behind the page's Save button) so toggling
  // the read gate takes effect at once.
  const shareable = (config as SetupConfig | null)?.shareable === true;
  const handleToggleShareable = (next: boolean) => {
    updateConfig.mutate({ shareable: next });
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.post<ConnectionTestResponse>('/tasks/sync-test', {}));
    } catch (err) {
      setTestResult({ ok: false, backend: taskProvider, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
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
        <h2 className="settings-section-title">{t('settings.tasks')}</h2>
        <div className="settings-checkboxes">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={cloudTasks}
              onChange={() => { setCloudTasks((p) => !p); markDirty(); }}
            />
            <span>{t('settings.cloud_tasks.label')}</span>
          </label>
          <p className="settings-field-hint">
            {taskProvider === 'github' ? t('settings.cloud_tasks.github.hint') : t('settings.cloud_tasks.hint')}
          </p>
          {cloudTasks && (
            <>
              <div className="settings-field-row">
                <label>{t('settings.cloud_tasks.provider')}</label>
                <select
                  className="settings-text-input"
                  value={taskProvider}
                  onChange={(e) => {
                    const next = e.target.value as 'clickup' | 'github';
                    setTaskProvider(next);
                    setTestResult(null);
                    markDirty();
                  }}
                >
                  <option value="clickup">{t('settings.cloud_tasks.provider.clickup')}</option>
                  <option value="github">{t('settings.cloud_tasks.provider.github')}</option>
                </select>
              </div>

              {taskProvider === 'clickup' && (
                <>
                  {(containers ?? []).length > 0 && (
                    <div className="settings-field-row">
                      <label>{t('settings.cloud_tasks.list_label')}</label>
                      <SearchableSelect
                        value={clickupList ? ((containers ?? []).find(c => c.ids.listId === clickupList)?.path ?? null) : null}
                        options={(containers ?? []).map(c => ({ value: c.path, label: c.path }))}
                        placeholder={t('settings.cloud_tasks.list_pick')}
                        searchPlaceholder={t('settings.cloud_tasks.list_search')}
                        clearLabel={t('settings.cloud_tasks.keep_current')}
                        onChange={handlePickContainer}
                      />
                    </div>
                  )}
                  <div className="settings-field-row">
                    <label>{t('settings.cloud_tasks.team')}</label>
                    <input
                      className="settings-text-input"
                      value={clickupTeam}
                      onChange={(e) => { setClickupTeam(e.target.value); markDirty(); }}
                    />
                  </div>
                  <div className="settings-field-row">
                    <label>{t('settings.cloud_tasks.space')}</label>
                    <input
                      className="settings-text-input"
                      value={clickupSpace}
                      onChange={(e) => { setClickupSpace(e.target.value); markDirty(); }}
                    />
                  </div>
                  <div className="settings-field-row">
                    <label>{t('settings.cloud_tasks.list')}</label>
                    <input
                      className="settings-text-input"
                      value={clickupList}
                      onChange={(e) => { setClickupList(e.target.value); markDirty(); }}
                    />
                  </div>
                  <p className="settings-field-hint">{t('settings.cloud_tasks.token_hint')}</p>
                </>
              )}

              {taskProvider === 'github' && (
                <>
                  {(containers ?? []).length > 0 && (
                    <div className="settings-field-row">
                      <label>{t('settings.cloud_tasks.github.repo')}</label>
                      <SearchableSelect
                        value={githubOwner && githubRepo ? `${githubOwner}/${githubRepo}` : null}
                        options={(containers ?? []).map(c => ({ value: c.path, label: c.path }))}
                        placeholder={t('settings.cloud_tasks.github.pick')}
                        searchPlaceholder={t('settings.cloud_tasks.github.search')}
                        clearLabel={t('settings.cloud_tasks.keep_current')}
                        onChange={handlePickContainer}
                      />
                    </div>
                  )}
                  <div className="settings-field-row">
                    <label>{t('settings.cloud_tasks.github.owner')}</label>
                    <input
                      className="settings-text-input"
                      value={githubOwner}
                      onChange={(e) => { setGithubOwner(e.target.value); markDirty(); }}
                    />
                  </div>
                  <div className="settings-field-row">
                    <label>{t('settings.cloud_tasks.github.repo')}</label>
                    <input
                      className="settings-text-input"
                      value={githubRepo}
                      onChange={(e) => { setGithubRepo(e.target.value); markDirty(); }}
                    />
                  </div>
                  <p className="settings-field-hint">{t('settings.cloud_tasks.github.token_hint')}</p>
                </>
              )}

              <div className="settings-test-row">
                <button className="btn" onClick={handleTestConnection} disabled={testing}>
                  {testing ? t('settings.cloud_tasks.testing') : t('settings.cloud_tasks.test')}
                </button>
                <button className="btn" onClick={handleProvision} disabled={provisioning}>
                  {provisioning
                    ? (taskProvider === 'github' ? t('settings.cloud_tasks.github.provisioning') : t('settings.cloud_tasks.provisioning'))
                    : (taskProvider === 'github' ? t('settings.cloud_tasks.github.provision') : t('settings.cloud_tasks.provision'))}
                </button>
                {provisionNote && <span className="settings-field-hint">{provisionNote}</span>}
                {testResult && testResult.ok && (
                  <span className="settings-test-ok">
                    ✓ {testResult.note ?? `${t('settings.cloud_tasks.test_ok')} ${testResult.user}`}
                  </span>
                )}
                {testResult && !testResult.ok && (
                  <span className="settings-test-err">✗ {testResult.error}</span>
                )}
              </div>
              {syncStatus && syncStatus.backend !== 'local' && (
                <p className="settings-sync-badge">
                  {t('settings.cloud_tasks.status')}: {syncStatus.pendingPush} {t('settings.cloud_tasks.pending')}
                  {syncStatus.conflicts > 0 && ` · ${syncStatus.conflicts} ${t('settings.cloud_tasks.conflicts')}`}
                </p>
              )}
            </>
          )}
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

      <ConnectionsManager
        shareable={shareable}
        onToggleShareable={handleToggleShareable}
        shareablePending={updateConfig.isPending}
      />

      {isDesktop() && (
        <section className="settings-section">
          <h2 className="settings-section-title">
            Sleepy — notch quick-capture
            <span className="settings-beta-badge">BETA</span>
          </h2>
          <div className="settings-checkboxes">
            <label className="settings-checkbox-label">
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={sleepy.enabled}
                onChange={() => updateSleepy({ ...sleepy, enabled: !sleepy.enabled })}
              />
              <span>Enable Sleepy</span>
            </label>
            <p className="settings-field-hint">
              Press the hotkey anywhere to drop a capture bar under the notch: pick a project, type a
              thought, hit return — it's saved to that project's memory and learned.
            </p>
            {sleepy.enabled && (
              <div className="settings-field-row">
                <label>Hotkey</label>
                <input
                  className="settings-text-input"
                  readOnly
                  value={capturingHotkey ? 'Press a key combo…' : sleepy.hotkey}
                  onFocus={() => setCapturingHotkey(true)}
                  onBlur={() => setCapturingHotkey(false)}
                  onKeyDown={(e) => {
                    e.preventDefault();
                    const accel = accelFromKeyEvent(e);
                    if (accel) {
                      updateSleepy({ ...sleepy, hotkey: accel });
                      setCapturingHotkey(false);
                      e.currentTarget.blur();
                    }
                  }}
                />
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
