import { useEffect, useState } from 'react';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { SettingRow } from './SettingRow';
import { Seg } from './window/controls';
import { savingModeOf, savingModePatch, type SavingMode } from '../../lib/agentSettings';
import { SaveMark, useInstantSave } from './useInstantSave';
import { useAgentCfg } from './window/useAgentCfg';

interface Ladder { nudgeAt: number; hardAt: number }

/** 300000 → "300k", 1000000 → "1M". */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * Settings → Chat → Tasarruf modu (owner 2026-11-08, Eco Plus 2026-11-22): ONE three-way choice
 * for this Mac, Kapalı · Eco · Eco Plus, Eco by default. Stored like every other machine-wide chat
 * setting (`agent-ui.json` `ecoMode` + `ecoPlus`, written through `patchAgentSettings`): Kapalı
 * `{false,false}`, Eco `{true,false}`, Eco Plus `{true,true}`. Eco keeps the context hand-off
 * nudge; Eco Plus keeps it and runs most work on Sonnet (src/lib/eco-plus.ts). A pane's own
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
  const mode: SavingMode = cfg ? savingModeOf(cfg) : 'eco';
  const key = mode === 'off' ? 'shell.settings.eco.hint.off' : mode === 'plus' ? 'shell.settings.eco.hint.plus' : 'shell.settings.eco.hint';
  const hint = t(key)
    .replace('{nudge}', tokens(ladder?.nudgeAt ?? 300_000))
    .replace('{hard}', tokens(ladder?.hardAt ?? 650_000));
  return (
    <SettingRow
      id="eco"
      title={t('shell.settings.eco')}
      hint={hint}
      keywords="eco eco plus sonnet usage limit context handoff fresh chat tokens cost saving"
      status={<SaveMark state={save.state} />}
      control={(
        <Seg<SavingMode>
          label={t('shell.settings.eco')}
          value={mode}
          disabled={!cfg}
          options={[
            { value: 'off', label: t('shell.settings.eco.off') },
            { value: 'eco', label: 'Eco' },
            { value: 'plus', label: 'Eco Plus' },
          ]}
          onChange={(next) => void save.save(async () => {
            if (!(await update(savingModePatch(next)))) throw new Error('not saved');
          })}
        />
      )}
    />
  );
}
