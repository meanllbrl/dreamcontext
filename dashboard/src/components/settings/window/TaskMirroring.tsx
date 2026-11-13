import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../../context/I18nContext';
import { useGitHubAccess } from '../../../hooks/useBrainStatus';
import { GitHubStatusLine } from '../../brain/GitHubReconnect';
import { useConfig, useUpdateConfig } from '../../../hooks/useConfig';
import { SettingGroup, SettingRow } from '../SettingRow';
import { SaveMark, useInstantSave } from '../useInstantSave';
import { CloudTaskSync } from '../CloudTaskSync';
import { Seg } from './controls';
import type { SwPageId } from './sections';

type Target = 'local' | 'github' | 'clickup';

/**
 * Task mirroring (Settings window → Connections): ONE choice, Off / GitHub Issues / ClickUp,
 * writing `taskBackend`. The chosen tracker's own rows follow, with no switch of their own.
 * GitHub uses the one GitHub sign-in (Settings → GitHub); its row says who and where it is
 * managed, and turns red with one-click Reconnect when GitHub rejected it.
 */
export function TaskMirroring({ go }: { go?: (page: SwPageId) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data: config } = useConfig();
  const update = useUpdateConfig();
  const { state: ghState } = useGitHubAccess();
  const save = useInstantSave();
  const backend: Target = config?.taskBackend === 'github' || config?.taskBackend === 'clickup' ? config.taskBackend : 'local';
  const noLogin = ghState === 'signedOut' || ghState === 'expired';

  const choose = (next: Target) => {
    if (next === backend) return;
    void save.save(async () => {
      await update.mutateAsync({ taskBackend: next });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['tasks-token-status'] }),
        qc.invalidateQueries({ queryKey: ['tasks-containers'] }),
        qc.invalidateQueries({ queryKey: ['tasks-sync-status'] }),
      ]);
    });
  };

  return (
    <>
      <SettingGroup>
        <SettingRow
          id="mtarget"
          title={t('shell.sw.mirror.target')}
          hint={t('shell.sw.mirror.target.h')}
          keywords="mirror sync github issues clickup tracker backend"
          why={backend !== 'github' && noLogin ? t('shell.sw.mirror.noLogin') : undefined}
          status={<SaveMark state={save.state} />}
          control={(
            <>
              {backend !== 'github' && noLogin && (
                <button type="button" className="sw-btn" onClick={() => go?.('github')}>{t('shell.sw.page.github')} ›</button>
              )}
              <span data-testid="sw-mirror-choice">
                <Seg<Target>
                  label={t('shell.sw.mirror.target')}
                  value={backend}
                  disabled={!config || save.state.kind === 'saving'}
                  onChange={choose}
                  options={[
                    { value: 'local', label: t('shell.sw.mirror.off') },
                    { value: 'github', label: 'GitHub Issues' },
                    { value: 'clickup', label: 'ClickUp' },
                  ]}
                />
              </span>
            </>
          )}
        />
      </SettingGroup>
      {backend === 'github' && (
        <SettingGroup title="GitHub Issues">
          <SettingRow id="mgacc" title={t('shell.sw.mirror.account')} keywords="github account login sign in reconnect" control={<GitHubStatusLine onOpen={() => go?.('github')} />} />
          <CloudTaskSync provider="github" embedded />
        </SettingGroup>
      )}
      {backend === 'clickup' && (
        <SettingGroup title="ClickUp"><CloudTaskSync provider="clickup" embedded /></SettingGroup>
      )}
    </>
  );
}
