import { useEffect, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { fetchShellMode, writeShellMode, type ShellPref } from '../../lib/launcherPrefs';
import { isMacPhoneSurface } from '../../lib/phoneSurface';
import { MaturityTag } from '../common/MaturityTag';
import { SettingGroup, SettingRow, Toggle } from './SettingRow';
import { SaveMark, useInstantSave } from './useInstantSave';

/**
 * Settings → This machine → "New layout" (beta): the switch for the Codex-style shell. It is
 * per person and per Mac (`~/.dreamcontext/launcher-ui.json`), read from and written to the
 * SERVER, never a local mirror, so the save mark shows what was actually stored. The window's
 * shell is frozen when it opens (lib/uxMode.ts): the change lands on the next launch. Not drawn
 * on Mac mode's tunnel, which always keeps today's UI.
 */
export function NewLayoutSetting() {
  const { t } = useI18n();
  const save = useInstantSave();
  const [shell, setShell] = useState<ShellPref | null>(null);
  useEffect(() => {
    let live = true;
    void fetchShellMode().then((s) => { if (live) setShell(s); }, () => { if (live) setShell('classic'); });
    return () => { live = false; };
  }, []);
  if (isMacPhoneSurface()) return null;

  const toggle = (on: boolean) => {
    void save.save(async () => {
      const stored = await writeShellMode(on ? 'new' : 'classic');
      setShell(stored);
    });
  };

  return (
    <div data-testid="new-layout-setting">
      <SettingGroup title={t('shell.newLayout')} badge={<MaturityTag level="beta" />}>
      <SettingRow
        labelled
        title={t('shell.newLayout')}
        hint={`${t('shell.newLayout.hint')} ${t('shell.newLayout.restart')}`}
        status={<SaveMark state={save.state} />}
        control={
          <Toggle
            label={t('shell.newLayout')}
            checked={shell === 'new'}
            disabled={shell === null || save.state.kind === 'saving'}
            onChange={toggle}
          />
        }
      />
      </SettingGroup>
    </div>
  );
}
