import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useVault } from '../../context/VaultContext';
import { useBrainSettings, useBrainStatus, useUpdateBrainSettings } from '../../hooks/useBrainStatus';
import { readAutoCheckpointOnOpen, writeAutoCheckpointOnOpen } from '../../lib/brainSyncPrefs';
import { OriginSetup } from '../brain/OriginSetup';
import { SettingGroup, SettingRow, Toggle } from './SettingRow';
import { SaveMark, useInstantSave } from './useInstantSave';

/**
 * Team sync's own rows (the switch, the repo, auto checkpoint), shared by classic Settings and
 * the Settings window. Extracted with the same DOM; the caller decides what shows with no
 * GitHub account.
 */
export function TeamSyncRows({ title }: { title?: string } = {}) {
  const { t } = useI18n();
  const { vault } = useVault();
  const { data: brainSettings } = useBrainSettings();
  const { data: brainStatus } = useBrainStatus();
  const updateBrainSettings = useUpdateBrainSettings();
  const hasOrigin = brainStatus?.hasRemote === true;
  const [autoCheckpoint, setAutoCheckpoint] = useState<boolean>(() => readAutoCheckpointOnOpen(vault));
  const brainToggleSave = useInstantSave();
  return (
    <SettingGroup title={title}>
      {/* THE SWITCH IS GATED ON THE REPO, not just styled as if it were. The server
          refuses to enable sync with no origin (400 `no_origin`), so an enabled
          control here was a switch that could only fail — the user flipped it, it
          bounced back, and nothing said why. */}
      <SettingRow
        id="tsync"
        title={t('brain.cloudSync.label')}
        hint={hasOrigin ? t('brain.cloudSync.hint') : t('settings.teamsync.needsRepo')}
        tone={hasOrigin ? 'default' : 'warn'}
        keywords="team sync push pull share brain"
        status={<SaveMark state={brainToggleSave.state} />}
        control={
          <Toggle
            label={t('brain.cloudSync.label')}
            checked={brainSettings?.enabled ?? false}
            disabled={!hasOrigin || updateBrainSettings.isPending || brainToggleSave.state.kind === 'saving'}
            onChange={(next) => { void brainToggleSave.save(() => updateBrainSettings.mutateAsync(next)); }}
          />
        }
      />

      {/* The repo it syncs to — create, attach, change or disconnect. */}
      <SettingRow id="trepo" title={t('settings.teamsync.repo.title')} hint={t('settings.teamsync.repo.hint')} keywords="repository origin remote">
        <OriginSetup compact />
      </SettingRow>

      <SettingRow
        id="tcheck"
        title={t('brain.scope.autoCheckpoint.label')}
        hint={t('brain.scope.autoCheckpoint.hint')}
        more={t('brain.scope.autoCheckpoint.more')}
        keywords="checkpoint auto open"
        control={
          <Toggle
            label={t('brain.scope.autoCheckpoint.label')}
            checked={autoCheckpoint}
            onChange={(next) => { setAutoCheckpoint(next); writeAutoCheckpointOnOpen(vault, next); }}
          />
        }
      />
    </SettingGroup>
  );
}
