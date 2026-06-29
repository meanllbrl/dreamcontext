import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../context/I18nContext';
import { api } from '../api/client';
import { useConfig, useUpdateConfig, type PlatformId, type SetupConfig } from '../hooks/useConfig';
import { SearchableSelect } from '../components/tasks/SearchableSelect';
import { ConnectionsManager } from '../components/settings/ConnectionsManager';
import { TaskOverrideEditor } from '../components/settings/TaskOverrideEditor';
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

interface ProviderTokenStatus {
  set: boolean;
  source: 'env' | 'secrets' | null;
  masked: string | null;
}

// Token status is reported for the ACTIVE backend only (the server resolves the
// provider from the saved config); `backend` says which one it describes.
interface TokenStatusResponse extends ProviderTokenStatus {
  backend: string;
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

// ─── Section navigation (in-page menu) ────────────────────────────────────────

type SettingsSectionId = 'platforms' | 'tasks' | 'format' | 'memory' | 'connections' | 'sleepy';

interface SettingsNavItem {
  id: SettingsSectionId;
  icon: string;
  labelKey: string;
  desktopOnly?: boolean;
  beta?: boolean;
}

// Monochrome geometric glyphs matching the main Sidebar's icon language.
// Task Format sits just above Sleepy — both are the newer, beta-tier surfaces.
const SETTINGS_NAV: SettingsNavItem[] = [
  { id: 'platforms', icon: '⬡', labelKey: 'settings.nav.platforms' },
  { id: 'tasks', icon: '⇅', labelKey: 'settings.nav.tasks' },
  { id: 'memory', icon: '❖', labelKey: 'settings.nav.memory' },
  { id: 'connections', icon: '⊕', labelKey: 'settings.nav.connections' },
  { id: 'format', icon: '▤', labelKey: 'settings.nav.format', beta: true },
  { id: 'sleepy', icon: '☾', labelKey: 'settings.nav.sleepy', desktopOnly: true },
];

// ─── Component ────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: config, isLoading: configLoading, isError: configError } = useConfig();
  const updateConfig = useUpdateConfig();

  // In-page section nav: only one settings group is shown at a time so a
  // specific setting is quick to find instead of buried in one long scroll.
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('platforms');
  const navItems = SETTINGS_NAV.filter((item) => !item.desktopOnly || isDesktop());

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
  // API-key inputs are write-only: empty by default, never seeded from the server
  // (the token is never sent back). A non-empty value is saved on Save/Test/Provision.
  const [clickupToken, setClickupToken] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [testResult, setTestResult] = useState<ConnectionTestResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [provisionNote, setProvisionNote] = useState<string | null>(null);
  const [provisionPreview, setProvisionPreview] = useState<ProvisionResult | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);
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

  // Whether an API key is already configured (and from where), without ever
  // pulling the secret itself — drives the "key set ✓" indicator.
  const { data: tokenStatus } = useQuery({
    queryKey: ['tasks-token-status'],
    queryFn: () => api.get<TokenStatusResponse>('/tasks/token-status'),
    enabled: cloudTasks,
  });
  // The status describes the SAVED backend; only trust it for the provider the
  // form currently shows (switching the dropdown before saving shouldn't claim a
  // key is set for the newly-picked provider).
  const providerTokenStatus: ProviderTokenStatus | undefined =
    tokenStatus && tokenStatus.backend === taskProvider ? tokenStatus : undefined;

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

  /**
   * Persist the cloud-task form to disk: write the API key (if one was typed)
   * into the gitignored secrets store, then PATCH the provider coordinates.
   * Test Connection and Provision call this FIRST so they always act on what is
   * on screen — the old flow tested stale saved config and reported "not set".
   * Returns true on success; sets `persistError` and returns false on failure.
   */
  const persistCloudConfig = async (): Promise<boolean> => {
    const taskBackend = cloudTasks ? taskProvider : 'local';
    const typedToken = (taskProvider === 'github' ? githubToken : clickupToken).trim();
    try {
      // Config FIRST: this sets `taskBackend`, so the server resolves the right
      // backend for the token write and every subsequent test/provision call.
      await updateConfig.mutateAsync({
        platforms,
        disableNativeMemory,
        taskBackend,
        ...(cloudTasks && taskProvider === 'clickup'
          ? { clickup: { teamId: clickupTeam || undefined, spaceId: clickupSpace || undefined, listId: clickupList || undefined } }
          : {}),
        ...(cloudTasks && taskProvider === 'github'
          ? { github: { owner: githubOwner || undefined, repo: githubRepo || undefined } }
          : {}),
      });
      // Then the API key into the active backend's gitignored secrets store.
      if (cloudTasks && typedToken) {
        await api.post('/tasks/token', { token: typedToken });
      }
      // The secret is on disk now — drop it from React state and refresh derived
      // queries (key status, pickable containers, sync badge).
      if (typedToken) {
        if (taskProvider === 'github') setGithubToken(''); else setClickupToken('');
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks-token-status'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks-containers'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks-sync-status'] }),
      ]);
      setDirty(false);
      setPersistError(null);
      return true;
    } catch (err) {
      setPersistError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const formatProvisionResult = (result: ProvisionResult): string =>
    result.errors.length > 0
      ? `⚠ ${result.errors[0]}`
      : result.created.length > 0
        ? `✓ ${t('settings.cloud_tasks.provision_created')}: ${result.created.join(', ')}${result.backfilled > 0 ? ` · ${t('settings.cloud_tasks.provision_backfilled').replace('{n}', String(result.backfilled))}` : ''}`
        : `✓ ${t('settings.cloud_tasks.provision_nothing')}`;

  // One-line status under the API-key input: where the key comes from, masked.
  const tokenStatusHint = (s?: ProviderTokenStatus): string => {
    if (!s || !s.set) return t('settings.cloud_tasks.api_key_none');
    if (s.source === 'env') return `${t('settings.cloud_tasks.api_key_env')} ${s.masked ?? ''}`.trim();
    return `${t('settings.cloud_tasks.api_key_set')} ${s.masked ?? ''}`.trim();
  };

  // Step 1 of provisioning: auto-save, then a DRY RUN that previews exactly which
  // fields/labels will be created vs already exist — nothing is written yet.
  const handleProvisionPreview = async () => {
    setProvisioning(true);
    setProvisionNote(null);
    setProvisionPreview(null);
    try {
      if (!(await persistCloudConfig())) return;
      const { result } = await api.post<{ result: ProvisionResult }>('/tasks/provision', { dryRun: true });
      if (result.created.length === 0 && result.errors.length === 0) {
        // Nothing to do — say so instead of showing an empty confirm panel.
        setProvisionNote(`✓ ${t('settings.cloud_tasks.provision_nothing')}`);
      } else {
        setProvisionPreview(result);
      }
    } catch (err) {
      setProvisionNote(`⚠ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProvisioning(false);
    }
  };

  // Step 2: the user confirmed the preview — actually create the fields/labels.
  const handleProvisionConfirm = async () => {
    setProvisioning(true);
    setProvisionNote(null);
    try {
      const { result } = await api.post<{ result: ProvisionResult }>('/tasks/provision', { dryRun: false });
      setProvisionPreview(null);
      setProvisionNote(formatProvisionResult(result));
      void queryClient.invalidateQueries({ queryKey: ['tasks-sync-status'] });
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

  const handleSave = async () => {
    setSaveSuccess(false);
    if (await persistCloudConfig()) setSaveSuccess(true);
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
    setProvisionPreview(null);
    try {
      // Auto-save first so the probe runs against the on-screen values (incl. a
      // freshly typed API key), not whatever was last persisted.
      if (!(await persistCloudConfig())) return;
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

      <div className="settings-body">
        <nav className="settings-nav" aria-label={t('settings.title')}>
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-nav-item${activeSection === item.id ? ' settings-nav-item--active' : ''}`}
              aria-current={activeSection === item.id ? 'page' : undefined}
              onClick={() => setActiveSection(item.id)}
            >
              <span className="settings-nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="settings-nav-label">{t(item.labelKey)}</span>
              {item.beta && <span className="settings-beta-badge">BETA</span>}
            </button>
          ))}
        </nav>

        <div className="settings-content">
      {activeSection === 'platforms' && (
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
      )}

      {activeSection === 'tasks' && (
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
                  <div className="settings-field-row">
                    <label>{t('settings.cloud_tasks.api_key')}</label>
                    <input
                      type="password"
                      className="settings-text-input"
                      autoComplete="off"
                      value={clickupToken}
                      placeholder={providerTokenStatus?.set ? (providerTokenStatus.masked ?? '••••••••') : t('settings.cloud_tasks.api_key_placeholder')}
                      onChange={(e) => { setClickupToken(e.target.value); markDirty(); }}
                    />
                  </div>
                  <p className="settings-field-hint">{tokenStatusHint(providerTokenStatus)}</p>
                  <p className="settings-field-hint">{t('settings.cloud_tasks.token_hint')}</p>
                </>
              )}

              {taskProvider === 'github' && (
                <>
                  {(containers ?? []).length > 0 && (
                    <div className="settings-field-row">
                      <label>{t('settings.cloud_tasks.github.repo_picker')}</label>
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
                  <div className="settings-field-row">
                    <label>{t('settings.cloud_tasks.api_key')}</label>
                    <input
                      type="password"
                      className="settings-text-input"
                      autoComplete="off"
                      value={githubToken}
                      placeholder={providerTokenStatus?.set ? (providerTokenStatus.masked ?? '••••••••') : t('settings.cloud_tasks.api_key_placeholder')}
                      onChange={(e) => { setGithubToken(e.target.value); markDirty(); }}
                    />
                  </div>
                  <p className="settings-field-hint">{tokenStatusHint(providerTokenStatus)}</p>
                  <p className="settings-field-hint">{t('settings.cloud_tasks.github.token_hint')}</p>
                </>
              )}

              <div className="settings-test-row">
                <button className="btn btn--secondary" onClick={handleTestConnection} disabled={testing || provisioning}>
                  {testing ? t('settings.cloud_tasks.testing') : t('settings.cloud_tasks.test')}
                </button>
                <button className="btn btn--secondary" onClick={handleProvisionPreview} disabled={provisioning || testing}>
                  {provisioning && !provisionPreview
                    ? (taskProvider === 'github' ? t('settings.cloud_tasks.github.provisioning') : t('settings.cloud_tasks.provisioning'))
                    : (taskProvider === 'github' ? t('settings.cloud_tasks.github.provision') : t('settings.cloud_tasks.provision'))}
                </button>
                {testResult && testResult.ok && (
                  <span className="settings-test-ok">
                    ✓ {testResult.note ?? `${t('settings.cloud_tasks.test_ok')} ${testResult.user}`}
                  </span>
                )}
                {testResult && !testResult.ok && (
                  <span className="settings-test-err">✗ {testResult.error}</span>
                )}
              </div>
              {persistError && <p className="settings-test-err">✗ {persistError}</p>}
              {provisionNote && <p className="settings-field-hint">{provisionNote}</p>}

              {provisionPreview && (
                <div className="settings-provision-preview">
                  <p className="settings-provision-preview-title">
                    {taskProvider === 'github'
                      ? t('settings.cloud_tasks.github.preview_title')
                      : t('settings.cloud_tasks.preview_title')}
                  </p>
                  {provisionPreview.created.length > 0 && (
                    <p className="settings-provision-line">
                      <span className="settings-provision-badge settings-provision-badge--new">
                        {t('settings.cloud_tasks.preview_will_create').replace('{n}', String(provisionPreview.created.length))}
                      </span>{' '}
                      {provisionPreview.created.join(', ')}
                    </p>
                  )}
                  {provisionPreview.existing.length > 0 && (
                    <p className="settings-provision-line settings-provision-line--muted">
                      <span className="settings-provision-badge">
                        {t('settings.cloud_tasks.preview_existing').replace('{n}', String(provisionPreview.existing.length))}
                      </span>{' '}
                      {provisionPreview.existing.join(', ')}
                    </p>
                  )}
                  <div className="settings-provision-actions">
                    <button className="btn btn--primary" onClick={handleProvisionConfirm} disabled={provisioning}>
                      {provisioning
                        ? t('settings.cloud_tasks.provision_creating')
                        : t('settings.cloud_tasks.provision_confirm').replace('{n}', String(provisionPreview.created.length))}
                    </button>
                    <button className="btn btn--ghost" onClick={() => setProvisionPreview(null)} disabled={provisioning}>
                      {t('settings.cloud_tasks.provision_cancel')}
                    </button>
                  </div>
                </div>
              )}
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
      )}

      {activeSection === 'format' && <TaskOverrideEditor />}

      {activeSection === 'memory' && (
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
      )}

      {activeSection === 'connections' && (
      <ConnectionsManager
        shareable={shareable}
        onToggleShareable={handleToggleShareable}
        shareablePending={updateConfig.isPending}
      />
      )}

      {activeSection === 'sleepy' && isDesktop() && (
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
      </div>
    </div>
  );
}
