import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { useApi } from '../../context/VaultContext';
import { useConfig, useUpdateConfig } from '../../hooks/useConfig';
import { SearchableSelect } from '../tasks/SearchableSelect';
import { useInstantSave, SaveMark } from './useInstantSave';
import { SettingRow, Toggle } from './SettingRow';

/**
 * Task mirroring for ONE provider — the ClickUp half lives under Integrations →
 * ClickUp, the GitHub half under Integrations → GitHub, beside that account's
 * project sync.
 *
 * Splitting the old single "Cloud Tasks" section by provider is what let GitHub
 * stop asking to be set up in three different places. The backends are still
 * mutually exclusive (`taskBackend` is one value), so the inactive provider says
 * so out loud rather than pretending the two switches are independent.
 *
 * Everything writes on change or on blur — there is no Save button on this page.
 */

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

interface TokenStatusResponse extends ProviderTokenStatus {
  backend: string;
}

type Provider = 'clickup' | 'github';

export function CloudTaskSync({ provider }: { provider: Provider }) {
  const { t } = useI18n();
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();

  const backend = config?.taskBackend ?? 'local';
  const active = backend === provider;
  const otherProvider: Provider = provider === 'github' ? 'clickup' : 'github';
  const otherActive = backend === otherProvider;

  const toggleSave = useInstantSave();
  const fieldsSave = useInstantSave();
  const tokenSave = useInstantSave();

  // Coordinates are edited locally and written on blur — a PATCH per keystroke
  // would hammer the config file and race itself.
  const [clickupTeam, setClickupTeam] = useState('');
  const [clickupSpace, setClickupSpace] = useState('');
  const [clickupList, setClickupList] = useState('');
  const [githubOwner, setGithubOwner] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  // Write-only: never seeded from the server (the token is never sent back).
  const [token, setToken] = useState('');

  const [testResult, setTestResult] = useState<ConnectionTestResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [provisionNote, setProvisionNote] = useState<string | null>(null);
  const [provisionPreview, setProvisionPreview] = useState<ProvisionResult | null>(null);
  const [provisioning, setProvisioning] = useState(false);

  useEffect(() => {
    setClickupTeam(config?.clickup?.teamId ?? '');
    setClickupSpace(config?.clickup?.spaceId ?? '');
    setClickupList(config?.clickup?.listId ?? '');
    setGithubOwner(config?.github?.owner ?? '');
    setGithubRepo(config?.github?.repo ?? '');
  }, [config]);

  const { data: syncStatus } = useQuery({
    queryKey: ['tasks-sync-status'],
    queryFn: () => api.get<{ status: SyncStatus }>('/tasks/sync-status'),
    select: (d) => d.status,
  });

  // Reported for the ACTIVE backend only, so only trust it when that's us.
  const { data: tokenStatus } = useQuery({
    queryKey: ['tasks-token-status'],
    queryFn: () => api.get<TokenStatusResponse>('/tasks/token-status'),
    enabled: active,
  });
  const providerTokenStatus: ProviderTokenStatus | undefined =
    tokenStatus && tokenStatus.backend === provider ? tokenStatus : undefined;

  const { data: containers } = useQuery({
    queryKey: ['tasks-containers'],
    queryFn: () => api.get<{ containers: RemoteContainer[] }>('/tasks/containers'),
    select: (d) => d.containers,
    enabled: active,
    staleTime: 5 * 60 * 1000,
  });

  const coordinates = () =>
    provider === 'github'
      ? { github: { owner: githubOwner || undefined, repo: githubRepo || undefined } }
      : { clickup: { teamId: clickupTeam || undefined, spaceId: clickupSpace || undefined, listId: clickupList || undefined } };

  const saveCoordinates = () => fieldsSave.save(async () => {
    await updateConfig.mutateAsync(coordinates());
    await queryClient.invalidateQueries({ queryKey: ['tasks-containers'] });
  });

  const saveToken = async (): Promise<boolean> => {
    const typed = token.trim();
    if (!typed) return true;
    const ok = await tokenSave.save(async () => {
      await api.post('/tasks/token', { token: typed });
    });
    if (ok) {
      setToken('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks-token-status'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks-containers'] }),
      ]);
    }
    return ok;
  };

  const toggleActive = () => toggleSave.save(async () => {
    await updateConfig.mutateAsync({
      taskBackend: active ? 'local' : provider,
      // Send this provider's coordinates along with the switch-on so the backend
      // resolves against what is on screen, not a half-written earlier attempt.
      ...(active ? {} : coordinates()),
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks-token-status'] }),
      queryClient.invalidateQueries({ queryKey: ['tasks-containers'] }),
      queryClient.invalidateQueries({ queryKey: ['tasks-sync-status'] }),
    ]);
  });

  const handlePickContainer = (path: string | null) => {
    const picked = (containers ?? []).find((c) => c.path === path);
    if (!picked) return;
    if (provider === 'github') {
      setGithubOwner(picked.ids.owner ?? '');
      setGithubRepo(picked.ids.repo ?? '');
    } else {
      setClickupTeam(picked.ids.teamId ?? '');
      setClickupSpace(picked.ids.spaceId ?? '');
      setClickupList(picked.ids.listId ?? '');
    }
    // A pick is a decision, not a keystroke — persist it right away.
    void fieldsSave.save(async () => {
      await updateConfig.mutateAsync(
        provider === 'github'
          ? { github: { owner: picked.ids.owner || undefined, repo: picked.ids.repo || undefined } }
          : { clickup: { teamId: picked.ids.teamId || undefined, spaceId: picked.ids.spaceId || undefined, listId: picked.ids.listId || undefined } },
      );
    });
  };

  /** Flush anything the user typed but never blurred, so a probe tests what's on screen. */
  const flush = async (): Promise<boolean> => {
    const ok = await saveCoordinates();
    if (!ok) return false;
    return saveToken();
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setProvisionPreview(null);
    try {
      if (!(await flush())) return;
      setTestResult(await api.post<ConnectionTestResponse>('/tasks/sync-test', {}));
    } catch (err) {
      setTestResult({ ok: false, backend: provider, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const formatProvisionResult = (result: ProvisionResult): string =>
    result.errors.length > 0
      ? `⚠ ${result.errors[0]}`
      : result.created.length > 0
        ? `✓ ${t('settings.cloud_tasks.provision_created')}: ${result.created.join(', ')}${result.backfilled > 0 ? ` · ${t('settings.cloud_tasks.provision_backfilled').replace('{n}', String(result.backfilled))}` : ''}`
        : `✓ ${t('settings.cloud_tasks.provision_nothing')}`;

  const handleProvisionPreview = async () => {
    setProvisioning(true);
    setProvisionNote(null);
    setProvisionPreview(null);
    try {
      if (!(await flush())) return;
      const { result } = await api.post<{ result: ProvisionResult }>('/tasks/provision', { dryRun: true });
      if (result.created.length === 0 && result.errors.length === 0) {
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

  const tokenStatusHint = (s?: ProviderTokenStatus): string => {
    if (!s || !s.set) return t('settings.cloud_tasks.api_key_none');
    if (s.source === 'env') return `${t('settings.cloud_tasks.api_key_env')} ${s.masked ?? ''}`.trim();
    return `${t('settings.cloud_tasks.api_key_set')} ${s.masked ?? ''}`.trim();
  };

  const toggleLabel = provider === 'github'
    ? t('settings.tasksync.github.label')
    : t('settings.tasksync.clickup.label');

  return (
    <div className="setting-rows">
      <SettingRow
        title={toggleLabel}
        hint={provider === 'github' ? t('settings.tasksync.github.hint') : t('settings.tasksync.clickup.hint')}
        status={<SaveMark state={toggleSave.state} />}
        control={
          <Toggle
            label={toggleLabel}
            checked={active}
            disabled={toggleSave.state.kind === 'saving'}
            onChange={() => void toggleActive()}
          />
        }
      />

      {/* The two backends are one setting. Say so instead of letting the second
          switch look like an independent one that simply refuses to stick. */}
      {otherActive && (
        <SettingRow
          tone="warn"
          title={t('settings.tasksync.switching.title')}
          hint={t('settings.tasksync.other_active').replace(
            '{other}',
            otherProvider === 'github' ? t('settings.cloud_tasks.provider.github') : t('settings.cloud_tasks.provider.clickup'),
          )}
        />
      )}

      {active && (
        <>
          {(containers ?? []).length > 0 && (
            <SettingRow
              title={provider === 'github' ? t('settings.cloud_tasks.github.repo_picker') : t('settings.cloud_tasks.list_label')}
              hint={t('settings.tasksync.picker_hint')}
            >
              <SearchableSelect
                value={
                  provider === 'github'
                    ? (githubOwner && githubRepo ? `${githubOwner}/${githubRepo}` : null)
                    : (clickupList ? ((containers ?? []).find((c) => c.ids.listId === clickupList)?.path ?? null) : null)
                }
                options={(containers ?? []).map((c) => ({ value: c.path, label: c.path }))}
                placeholder={provider === 'github' ? t('settings.cloud_tasks.github.pick') : t('settings.cloud_tasks.list_pick')}
                searchPlaceholder={provider === 'github' ? t('settings.cloud_tasks.github.search') : t('settings.cloud_tasks.list_search')}
                clearLabel={t('settings.cloud_tasks.keep_current')}
                onChange={handlePickContainer}
              />
            </SettingRow>
          )}

          {/* The raw coordinates, for when the picker can't reach the account. */}
          <SettingRow
            title={t('settings.tasksync.coordinates.title')}
            hint={t('settings.tasksync.coordinates.hint')}
            status={<SaveMark state={fieldsSave.state} />}
          >
            <div className="setting-fields">
              {provider === 'clickup' ? (
                <>
                  <label className="setting-field">
                    <span>{t('settings.cloud_tasks.team')}</span>
                    <input
                      className="settings-text-input"
                      value={clickupTeam}
                      onChange={(e) => setClickupTeam(e.target.value)}
                      onBlur={() => void saveCoordinates()}
                    />
                  </label>
                  <label className="setting-field">
                    <span>{t('settings.cloud_tasks.space')}</span>
                    <input
                      className="settings-text-input"
                      value={clickupSpace}
                      onChange={(e) => setClickupSpace(e.target.value)}
                      onBlur={() => void saveCoordinates()}
                    />
                  </label>
                  <label className="setting-field">
                    <span>{t('settings.cloud_tasks.list')}</span>
                    <input
                      className="settings-text-input"
                      value={clickupList}
                      onChange={(e) => setClickupList(e.target.value)}
                      onBlur={() => void saveCoordinates()}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="setting-field">
                    <span>{t('settings.cloud_tasks.github.owner')}</span>
                    <input
                      className="settings-text-input"
                      value={githubOwner}
                      onChange={(e) => setGithubOwner(e.target.value)}
                      onBlur={() => void saveCoordinates()}
                    />
                  </label>
                  <label className="setting-field">
                    <span>{t('settings.cloud_tasks.github.repo')}</span>
                    <input
                      className="settings-text-input"
                      value={githubRepo}
                      onChange={(e) => setGithubRepo(e.target.value)}
                      onBlur={() => void saveCoordinates()}
                    />
                  </label>
                </>
              )}
            </div>
          </SettingRow>

          <SettingRow
            title={t('settings.cloud_tasks.api_key')}
            hint={tokenStatusHint(providerTokenStatus)}
            more={provider === 'github' ? t('settings.cloud_tasks.github.token_hint') : t('settings.cloud_tasks.token_hint')}
            status={<SaveMark state={tokenSave.state} />}
            control={
              <input
                type="password"
                className="settings-text-input"
                autoComplete="off"
                aria-label={t('settings.cloud_tasks.api_key')}
                value={token}
                placeholder={providerTokenStatus?.set ? (providerTokenStatus.masked ?? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022') : t('settings.cloud_tasks.api_key_placeholder')}
                onChange={(e) => setToken(e.target.value)}
                onBlur={() => void saveToken()}
              />
            }
          />

          <SettingRow
            title={t('settings.tasksync.check.title')}
            hint={t('settings.tasksync.check.hint')}
          >
            <div className="settings-test-row">
              <button className="btn btn--secondary" onClick={() => void handleTestConnection()} disabled={testing || provisioning}>
                {testing ? t('settings.cloud_tasks.testing') : t('settings.cloud_tasks.test')}
              </button>
              <button className="btn btn--secondary" onClick={() => void handleProvisionPreview()} disabled={provisioning || testing}>
                {provisioning && !provisionPreview
                  ? (provider === 'github' ? t('settings.cloud_tasks.github.provisioning') : t('settings.cloud_tasks.provisioning'))
                  : (provider === 'github' ? t('settings.cloud_tasks.github.provision') : t('settings.cloud_tasks.provision'))}
              </button>
              {testResult && testResult.ok && (
                <span className="settings-test-ok">
                  \u2713 {testResult.note ?? `${t('settings.cloud_tasks.test_ok')} ${testResult.user}`}
                </span>
              )}
              {testResult && !testResult.ok && <span className="settings-test-err">\u2717 {testResult.error}</span>}
            </div>
            {provisionNote && <p className="settings-field-hint">{provisionNote}</p>}

            {provisionPreview && (
              <div className="settings-provision-preview">
                <p className="settings-provision-preview-title">
                  {provider === 'github' ? t('settings.cloud_tasks.github.preview_title') : t('settings.cloud_tasks.preview_title')}
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
                  <button className="btn btn--primary" onClick={() => void handleProvisionConfirm()} disabled={provisioning}>
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
                {syncStatus.conflicts > 0 && ` \u00b7 ${syncStatus.conflicts} ${t('settings.cloud_tasks.conflicts')}`}
              </p>
            )}
          </SettingRow>
        </>
      )}
    </div>
  );
}
