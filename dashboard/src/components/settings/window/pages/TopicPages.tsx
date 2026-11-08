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
import { useAuthStatus } from '../../../../hooks/useBrainStatus';
import type { PageProps } from './SimplePages';
import { GitHubLogin } from '../../../brain/GitHubLogin';
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

/** Team sync: the GitHub account (Task mirroring uses it too), then the sync itself. */
export function TeamSyncPage() {
  const { t } = useI18n();
  const { data: auth } = useAuthStatus();
  return (
    <>
      <Head id="teamsync" />
      <SettingGroup title="GitHub" note={t('shell.sw.teamsync.account.note')}>
        <div className="setting-row" data-row="github" data-search-k="github account login sign in token"><GitHubLogin /></div>
      </SettingGroup>
      {auth?.connected ? <TeamSyncRows title={t('shell.sw.teamsync.sync')} /> : (
        <SettingGroup title={t('shell.sw.teamsync.sync')}>
          <SettingRow
            id="tsync"
            title={t('settings.teamsync.needsAccount.title')}
            hint={t('settings.teamsync.needsAccount.hint')}
            keywords="team sync push pull share brain"
            why={t('shell.sw.teamsync.needsLogin')}
          />
        </SettingGroup>
      )}
    </>
  );
}

export function MirrorPage({ go }: PageProps) {
  return (<><Head id="mirror" /><TaskMirroring go={go} /></>);
}
