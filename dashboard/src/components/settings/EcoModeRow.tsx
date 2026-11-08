import { useEffect, useState } from 'react';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { SettingRow, Toggle } from './SettingRow';
import { SaveMark, useInstantSave } from './useInstantSave';
import { useAgentCfg } from './window/useAgentCfg';

interface Ladder { nudgeAt: number; hardAt: number }

/** 300000 → "300k", 1000000 → "1M". */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * Settings → Chat → Eco mode (owner 2026-11-08): ONE switch for this Mac, ON by default, the
 * one every new chat pane in every project starts from. Stored like every other machine-wide
 * chat setting (`agent-ui.json` `ecoMode`, written through `patchAgentSettings`). A pane's own
 * composer switch still wins for that pane and never changes this. The thresholds in the hint
 * come from the open project's `.config.json` (`GET /agent/context-handoff-default`).
 */
export function EcoModeRow() {
  const { t } = useI18n();
  const api = useApi();
  const save = useInstantSave();
  const { cfg, update } = useAgentCfg();
  const [ladder, setLadder] = useState<Ladder | null>(null);
  useEffect(() => {
    let gone = false;
    api.get<Ladder>('/agent/context-handoff-default').then((s) => { if (!gone) setLadder(s); }, () => {});
    return () => { gone = true; };
  }, [api]);
  const hint = t('shell.settings.eco.hint')
    .replace('{nudge}', tokens(ladder?.nudgeAt ?? 300_000))
    .replace('{hard}', tokens(ladder?.hardAt ?? 650_000));
  return (
    <SettingRow
      id="eco"
      title={t('shell.settings.eco')}
      hint={hint}
      keywords="eco context handoff fresh chat tokens cost"
      status={<SaveMark state={save.state} />}
      control={(
        <Toggle
          label={t('shell.settings.eco')}
          checked={cfg?.ecoMode ?? true}
          disabled={!cfg}
          onChange={(next) => void save.save(async () => {
            if (!(await update({ ecoMode: next }))) throw new Error('not saved');
          })}
        />
      )}
    />
  );
}
