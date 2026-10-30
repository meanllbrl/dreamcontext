import { useEffect, useState } from 'react';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { SettingRow, Toggle } from './SettingRow';
import { SaveMark, useInstantSave } from './useInstantSave';

interface HandoffDefault { enabled: boolean; nudgeAt: number; hardAt: number }

/** 300000 → "300k", 1000000 → "1M". */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * Settings → Chat → Eco mode (task codex-tarzi-yeni-kabuk W2-C, flagged F4): this machine's
 * default for the context hand-off nudge in THIS project (`.brain-local.json`
 * `contextHandoffDefault`), the switch every new chat pane starts from. A pane's own toggle in
 * the composer still wins for that pane. The row shows what the server stored, and the
 * thresholds it fires at come from the team's `.config.json`.
 */
export function EcoModeRow() {
  const { t } = useI18n();
  const api = useApi();
  const save = useInstantSave();
  const [state, setState] = useState<HandoffDefault | null>(null);
  useEffect(() => {
    let gone = false;
    api.get<HandoffDefault>('/agent/context-handoff-default').then((s) => { if (!gone) setState(s); }, () => {});
    return () => { gone = true; };
  }, [api]);
  const hint = t('shell.settings.eco.hint')
    .replace('{nudge}', tokens(state?.nudgeAt ?? 300_000))
    .replace('{hard}', tokens(state?.hardAt ?? 650_000));
  return (
    <SettingRow
      title={t('shell.settings.eco')}
      hint={hint}
      status={<SaveMark state={save.state} />}
      control={(
        <Toggle
          label={t('shell.settings.eco')}
          checked={!!state?.enabled}
          disabled={!state}
          onChange={(next) => void save.save(async () => {
            setState(await api.post<HandoffDefault>('/agent/context-handoff-default', { enabled: next }));
          })}
        />
      )}
    />
  );
}
