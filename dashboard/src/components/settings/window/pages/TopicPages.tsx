import { useI18n } from '../../../../context/I18nContext';
import { useConfig, useUpdateConfig } from '../../../../hooks/useConfig';
import { useSleep, useUpdateSleep } from '../../../../hooks/useSleep';
import { SettingGroup, SettingRow, Toggle } from '../../SettingRow';
import { SaveMark, useInstantSave } from '../../useInstantSave';
import { RecallModeCards } from '../../RecallModeCards';
import { McpServers } from '../../McpServers';
import { VoiceRows } from '../VoiceRows';
import { TaskMirroring } from '../TaskMirroring';
import { TeamSyncRows } from '../../TeamSyncRows';
import { useState } from 'react';
import { useGitHubAccess, useLogoutGitHub, useProjectGitHubToken, type AuthStatus, type GitHubAccessState } from '../../../../hooks/useBrainStatus';
import { useVault } from '../../../../context/VaultContext';
import type { PageProps } from './SimplePages';
import { GitHubPatForm } from '../../../brain/GitHubLogin';
import { GitHubInApp, GitHubReconnect, GitHubStatusLine } from '../../../brain/GitHubReconnect';
import { PageHead } from '../controls';
import { pageDescKey, pageTitleKey, type SwPageId } from '../sections';

function Head({ id }: { id: SwPageId }) {
  const { t } = useI18n();
  return <PageHead title={t(pageTitleKey(id))} desc={t(pageDescKey(id))} />;
}

export function McpPage() {
  const { t } = useI18n();
  return (
    <>
      <Head id="mcp" />
      <SettingGroup>
        <SettingRow id="servers" title={t('shell.sw.mcp.servers')} keywords="mcp server tool github playwright posthog codex claude connectors sign in">
          <div className="sw-wide"><McpServers codex /></div>
        </SettingRow>
      </SettingGroup>
    </>
  );
}

export function VoicePage() {
  return (<><Head id="voice" /><VoiceRows /></>);
}

/** Memory search: the measured ways to search, plus the native memory row (its source). */
export function MemoryPage() {
  const { t } = useI18n();
  const { data: sleep } = useSleep();
  const updateSleep = useUpdateSleep();
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const native = useInstantSave();
  const disabled = config?.disableNativeMemory ?? true;
  return (
    <>
      <Head id="memory" />
      <RecallModeCards
        recallMode={sleep?.recall_mode ?? 'haiku'}
        saving={updateSleep.isPending}
        onSelectMode={(mode) => updateSleep.mutate({ recall_mode: mode })}
      />
      <SettingGroup title={t('shell.sw.memory.source')}>
        <SettingRow
          id="native"
          labelled
          title={t('settings.native_memory.label')}
          hint={t('settings.native_memory.hint')}
          keywords="native memory claude memory.md"
          status={<SaveMark state={native.state} />}
          control={<Toggle checked={disabled} disabled={native.state.kind === 'saving'} onChange={() => { void native.save(() => updateConfig.mutateAsync({ disableNativeMemory: !disabled })); }} />}
        />
      </SettingGroup>
    </>
  );
}

/** The account chip: four states, each its own word (never a bare colour). */
function GitHubChip({ state }: { state: GitHubAccessState }) {
  const { t } = useI18n();
  if (state === 'connected') return <span className="sw-ok">{t('github.chip.connected')}</span>;
  if (state === 'expired') return <span className="sw-chip-bad">{t('github.chip.expired')}</span>;
  if (state === 'desktopOnly') return <span className="sw-chip-off">{t('github.chip.inApp')}</span>;
  if (state === 'signedOut') return <span className="sw-chip-off">{t('github.chip.signedOut')}</span>;
  return null;
}

/** What one project token row says: the open project overrides the sign-in, or it was healed. */
function projectTokenNote(auth: AuthStatus | undefined, t: (k: string) => string): string | null {
  if (auth?.projectToken === 'active') return t('github.uses.ownToken');
  if (auth?.projectToken === 'demoted') return t('github.uses.healed');
  return null;
}

/**
 * Settings → GitHub (plan D8): the one GitHub sign-in every path uses, the fixed list of what
 * uses it, and, folded under Advanced, another account or this project's own token.
 */
export function GitHubPage() {
  const { t } = useI18n();
  const { vault } = useVault();
  const { state, auth } = useGitHubAccess();
  const logout = useLogoutGitHub();
  const flagged = state === 'expired';
  const projectNote = projectTokenNote(auth, t);

  const accountControl = state === 'desktopOnly' ? <GitHubInApp vault={vault} linkOnly />
    : state === 'connected' ? (auth?.source === 'global'
      ? <button type="button" className="sw-btn" onClick={() => logout.mutate()} disabled={logout.isPending}>{t('brain.auth.signOut')}</button>
      : null)
    : state === 'expired' ? (
      <>
        <GitHubReconnect className="sw-btn sw-btn--accent" />
        <button type="button" className="sw-btn" onClick={() => logout.mutate()} disabled={logout.isPending}>{t('brain.auth.signOut')}</button>
      </>
    )
    : state === 'signedOut' && auth?.oauthConfigured !== false ? <GitHubReconnect connect className="sw-btn sw-btn--accent" />
    : null;

  const accountHint = state === 'connected' ? (auth?.source === 'env' ? t('github.account.env') : t('github.account.connected.h'))
    : state === 'expired' ? t('github.account.expired.h')
    : state === 'signedOut' ? (auth?.oauthConfigured === false ? t('github.account.noOauth.h') : t('github.account.signedOut.h'))
    : state === 'desktopOnly' ? t('github.account.inApp.h')
    : t('common.loading');

  const uses: Array<{ id: string; key: string; project: boolean }> = [
    { id: 'gh-teamsync', key: 'shell.sw.page.teamsync', project: true },
    { id: 'gh-mirror', key: 'shell.sw.page.mirror', project: true },
    { id: 'gh-clone', key: 'github.uses.clone', project: false },
    { id: 'gh-share', key: 'github.uses.share', project: false },
  ];

  return (
    <>
      <Head id="github" />
      <SettingGroup>
        <SettingRow
          id="gh-account"
          title={state === 'connected' || state === 'expired' ? (auth?.login ?? 'GitHub') : 'GitHub'}
          hint={accountHint}
          keywords="github account login sign in connect reconnect sign out"
          status={<GitHubChip state={state} />}
          control={accountControl}
        />
      </SettingGroup>
      <SettingGroup title={t('github.uses.title')} note={t('github.uses.note')}>
        {uses.map((u) => {
          const note = u.project ? projectNote : null;
          return (
            <SettingRow
              key={u.id}
              id={u.id}
              title={t(u.key)}
              hint={note ?? undefined}
              keywords="github uses sync mirror clone share"
              control={state === 'desktopOnly' || state === 'loading' ? undefined
                : <span className={flagged || state === 'signedOut' ? 'sw-chip-bad' : 'sw-state'}>
                  {flagged ? t('github.uses.needsReconnect') : state === 'signedOut' ? t('github.chip.signedOut') : t('github.uses.ok')}
                </span>}
            />
          );
        })}
      </SettingGroup>
      {state !== 'desktopOnly' && (
        <SettingGroup title={t('github.adv.title')} collapsible defaultOpen={state === 'signedOut' && auth?.oauthConfigured === false}>
          <SettingRow id="gh-adv-account" title={t('github.adv.account')} hint={t('github.adv.account.h')} keywords="github token pat personal access token another account">
            <GitHubPatForm hint={t('github.adv.account.note')} />
          </SettingRow>
          <ProjectTokenRow auth={auth} />
        </SettingGroup>
      )}
    </>
  );
}

/** The open project's own token (C6): its state, then save or remove. Never echoes a token. */
function ProjectTokenRow({ auth }: { auth: AuthStatus | undefined }) {
  const { t } = useI18n();
  const { save, remove } = useProjectGitHubToken();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const st = auth?.projectToken ?? 'none';
  // Demoted = healed: the sign-in already took over, so its chip is neutral, never the red of 'act now'.
  const submit = async () => {
    setError(null);
    try { await save.mutateAsync(value.trim()); setValue(''); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const drop = async () => {
    setError(null);
    try { await remove.mutateAsync(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <SettingRow
      id="gh-adv-project"
      title={t('github.adv.project')}
      hint={t('github.adv.project.h')}
      keywords="github project token own key override"
      status={<span className={st === 'demoted' ? 'sw-chip-off' : 'sw-state'}>{t(`github.adv.project.${st}`)}</span>}
    >
      <div className="gh-login-pat-form">
        <div className="settings-field-row">
          <input
            type="password"
            className="settings-text-input"
            autoComplete="off"
            aria-label={t('github.adv.project')}
            placeholder={t('brain.auth.pat.placeholder')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="button" className="btn btn--secondary" onClick={() => void submit()} disabled={save.isPending || !value.trim()}>
            {save.isPending ? t('brain.auth.pat.submitting') : t('github.adv.project.save')}
          </button>
          {st !== 'none' && (
            <button type="button" className="btn btn--ghost" onClick={() => void drop()} disabled={remove.isPending}>{t('github.adv.project.remove')}</button>
          )}
        </div>
        {error && <p className="settings-test-err">✗ {error}</p>}
      </div>
    </SettingRow>
  );
}

/** Team sync: one line about the GitHub sign-in (managed on its own page), then the sync. */
export function TeamSyncPage({ go }: PageProps) {
  const { t } = useI18n();
  const { state } = useGitHubAccess();
  return (
    <>
      <Head id="teamsync" />
      <SettingGroup title="GitHub">
        <SettingRow id="github" title={t('github.line.title')} keywords="github account login sign in" control={<GitHubStatusLine onOpen={() => go?.('github')} />} />
      </SettingGroup>
      {state === 'connected' || state === 'expired' ? <TeamSyncRows title={t('shell.sw.teamsync.sync')} /> : (
        <SettingGroup title={t('shell.sw.teamsync.sync')}>
          <SettingRow
            id="tsync"
            title={t('settings.teamsync.needsAccount.title')}
            hint={t('settings.teamsync.needsAccount.hint')}
            keywords="team sync push pull share brain"
            why={state === 'desktopOnly' ? t('github.desktopOnly') : t('shell.sw.teamsync.needsLogin')}
          />
        </SettingGroup>
      )}
    </>
  );
}

export function MirrorPage({ go }: PageProps) {
  return (<><Head id="mirror" /><TaskMirroring go={go} /></>);
}
