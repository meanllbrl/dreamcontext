import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { useApi } from '../../context/VaultContext';
import { SettingGroup, SettingRow, Toggle } from './SettingRow';
import { SaveMark, useInstantSave } from './useInstantSave';
import { statusLine, type SelfUpdateView } from '../../lib/selfUpdateStatus';
import './AutoUpdateSetting.css';

const QUERY_KEY = ['launcher-self-update'];

/**
 * Settings → This machine: the one switch for keeping dreamcontext current without a terminal.
 * On (the default), the desktop app upgrades its CLI at launch and every 6 h and refreshes every
 * project, and the Claude prompt hook upgrades it too; off stops both (a marker file in
 * ~/.dreamcontext). Under it, one line with the last outcome, read from the self-update record.
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
      </SettingGroup>
    </div>
  );
}
