import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { useApi } from '../../context/VaultContext';
import { SettingGroup, SettingRow, Toggle } from './SettingRow';
import { SaveMark, useInstantSave } from './useInstantSave';
import { channelStatusLine, statusLine, type SelfUpdateView, type UpdateChannelView } from '../../lib/selfUpdateStatus';
import './AutoUpdateSetting.css';

const QUERY_KEY = ['launcher-self-update'];
const CHANNEL_KEY = ['launcher-update-channel'];

/**
 * Settings → This machine: the one switch for keeping dreamcontext current without a terminal.
 * On (the default), the desktop app upgrades its CLI at launch and every 6 h and refreshes every
 * project, and the Claude prompt hook upgrades it too; off stops both (a marker file in
 * ~/.dreamcontext). Under it, one line with the last outcome, read from the self-update record.
 * Then "Beta programı" (plan npmsiz-beta C10): the app's update channel. On, the app updates from
 * the beta feed; off, from stable, and a build newer than stable stays until stable passes it.
 */
export function AutoUpdateSetting() {
  const { t } = useI18n();
  const api = useApi();
  const queryClient = useQueryClient();
  const save = useInstantSave();
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<SelfUpdateView>('/launcher/self-update'),
    refetchInterval: 60_000,
  });

  const channelSave = useInstantSave();
  const { data: channel } = useQuery({
    queryKey: CHANNEL_KEY,
    queryFn: () => api.get<UpdateChannelView>('/launcher/update-channel'),
    refetchInterval: 60_000,
  });
  // The owner's own click (owner key): an agent's loopback call cannot move this Mac to Beta.
  const toggleBeta = (next: boolean) => {
    void channelSave.save(async () => {
      await queryClient.cancelQueries({ queryKey: CHANNEL_KEY });
      const view = await api.ownerPost<UpdateChannelView>('/launcher/update-channel', { channel: next ? 'beta' : 'stable' });
      queryClient.setQueryData(CHANNEL_KEY, view);
    });
  };

  const toggle = (next: boolean) => {
    void save.save(async () => {
      // A poll already in flight would land after the save and put the old state back.
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const view = await api.post<SelfUpdateView>('/launcher/self-update', { enabled: next });
      queryClient.setQueryData(QUERY_KEY, view);
    });
  };

  return (
    <div className="settings-self-update">
      <SettingGroup title={t('settings.selfUpdate.group')}>
        <SettingRow
          labelled
          title={t('settings.selfUpdate.label')}
          hint={t(data?.desktop ? 'settings.selfUpdate.hint' : 'settings.selfUpdate.hintTerminal')}
          status={<SaveMark state={save.state} />}
          control={
            <Toggle
              checked={data?.enabled ?? true}
              disabled={!data || save.state.kind === 'saving'}
              onChange={toggle}
            />
          }
        />
        {data && <p className="settings-field-hint" data-testid="self-update-status">{statusLine(data, t)}</p>}
        <SettingRow
          labelled
          title={t('settings.beta.label')}
          hint={t('settings.beta.hint')}
          status={<SaveMark state={channelSave.state} />}
          control={
            <Toggle
              checked={channel?.channel === 'beta'}
              disabled={!channel || !channel.desktop || channelSave.state.kind === 'saving'}
              onChange={toggleBeta}
            />
          }
        />
        {channel && <p className="settings-field-hint" data-testid="update-channel-status">{channelStatusLine(channel, t)}</p>}
      </SettingGroup>
    </div>
  );
}
