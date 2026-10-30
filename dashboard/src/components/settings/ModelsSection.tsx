import { useEffect, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import {
  SUPER_EFFORT_CHOICES, SUPER_MODEL_CHOICES, patchAgentSettings, type AgentSettings,
} from '../../lib/agentSettings';
import { getAssistantStatus, saveProfile } from '../../lib/assistantProfile';
import {
  SLEEP_EFFORT_OPTIONS, SLEEP_MODEL_OPTIONS, SLEEP_SPECIALISTS, useConfig, useUpdateConfig,
} from '../../hooks/useConfig';
import { SettingGroup, SettingRow } from './SettingRow';
import { SaveMark, useInstantSave } from './useInstantSave';

/**
 * Settings → This machine → Models (task codex-tarzi-yeni-kabuk W2-C, new shell only): which
 * model each kind of work uses, every row on a key that already exists. One row per USE, so a
 * tool and an account column can be added later without rebuilding it (Track T).
 *
 *  - New chats: `chatDefaultModel` / `chatDefaultEffort` (agent settings);
 *  - Super Agent: `superModel` / `superEffort`, moved here from the Chat section;
 *  - Assistant: `/api/assistant/profile` `model` / `effort`, disabled until it exists;
 *  - Sleep cycle: every `sleep.specialists[*].{model, effort}` at once through `/api/config`.
 *
 * The AI Team team-wide and Short text models are not here: their keys do not exist yet.
 */
const CHAT_MODELS = ['opus', 'sonnet', 'haiku'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** MIRRORED from `src/lib/assistant/home.ts` (DEFAULT_ASSISTANT_MODEL and its default effort): what
 *  the Assistant runs on before anyone picks; the server cannot store "no choice", so no Default. */
const ASSISTANT_DEFAULT = { model: 'sonnet', effort: 'medium' } as const;

/** Options with the current value kept when it is not one of them (never silently re-pinned). */
function withCurrent(choices: readonly string[], current: string): string[] {
  return current && !choices.includes(current) ? [...choices, current] : [...choices];
}

function label(v: string): string {
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function Pick({ value, choices, onChange, aria, inherit, disabled, testId }: {
  value: string;
  choices: readonly string[];
  onChange: (v: string) => void;
  aria: string;
  /** The empty value's label ("Default"); absent = no empty option. */
  inherit?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <select className="settings-text-input" aria-label={aria} value={value} disabled={disabled} data-testid={testId}
      onChange={(e) => onChange(e.target.value)}>
      {inherit !== undefined && <option value="">{inherit}</option>}
      {withCurrent(choices, value).filter((c) => c !== '').map((c) => <option key={c} value={c}>{label(c)}</option>)}
    </select>
  );
}

export function ModelsSection({ agentCfg, onOpenSleep }: {
  /** This window's agent settings (null until read; the chat and Super rows wait for it). */
  agentCfg: AgentSettings | null;
  onOpenSleep: () => void;
}) {
  const { t } = useI18n();
  const chatSave = useInstantSave();
  const superSave = useInstantSave();
  const assistantSave = useInstantSave();
  const sleepSave = useInstantSave();

  const [assistant, setAssistant] = useState<{ model: string; effort: string } | 'none' | null>(null);
  useEffect(() => {
    let gone = false;
    // The status route answers before the Assistant exists (the profile route is a 404 then).
    getAssistantStatus().then(
      (st) => {
        if (gone) return;
        if (!st.exists || !st.config) { setAssistant('none'); return; }
        setAssistant({ model: st.config.model ?? '', effort: st.config.effort ?? '' });
      },
      () => { if (!gone) setAssistant('none'); },
    );
    return () => { gone = true; };
  }, []);

  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const specialists = SLEEP_SPECIALISTS.map((n) => config?.sleep?.specialists?.[n]);
  const same = (field: 'model' | 'effort') => {
    const vals = new Set(specialists.map((o) => o?.[field] ?? ''));
    return vals.size === 1 ? [...vals][0] : null;
  };
  const sleepModel = same('model');
  const sleepEffort = same('effort');
  const setSleep = (field: 'model' | 'effort', value: string) => {
    const patch = Object.fromEntries(SLEEP_SPECIALISTS.map((n) => [n, { [field]: value === '' ? null : value }]));
    void sleepSave.save(() => updateConfig.mutateAsync({ sleep: { specialists: patch as never } }));
  };

  const inherit = t('shell.settings.models.inherit');
  const noAssistant = assistant === 'none';
  const a = assistant && assistant !== 'none' ? assistant : { model: '', effort: '' };

  return (
    <SettingGroup>
      <SettingRow
        title={t('shell.settings.models.chat')}
        hint={t('shell.settings.models.chatHint')}
        status={<SaveMark state={chatSave.state} />}
        control={agentCfg && (
          <span className="settings-models-pair">
            <Pick aria={`${t('shell.settings.models.chat')} model`} testId="models-chat-model" value={agentCfg.chatDefaultModel} choices={CHAT_MODELS} inherit={inherit}
              onChange={(v) => void chatSave.save(() => patchAgentSettings({ chatDefaultModel: v }))} />
            <Pick aria={`${t('shell.settings.models.chat')} effort`} testId="models-chat-effort" value={agentCfg.chatDefaultEffort} choices={EFFORTS} inherit={inherit}
              onChange={(v) => void chatSave.save(() => patchAgentSettings({ chatDefaultEffort: v }))} />
          </span>
        )}
      />
      <SettingRow
        title={t('shell.settings.models.super')}
        hint={t('shell.settings.models.superHint')}
        status={<SaveMark state={superSave.state} />}
        control={agentCfg && (
          <span className="settings-models-pair">
            <Pick aria={t('settings.agents.super_model')} testId="settings-super-model" value={agentCfg.superModel} choices={SUPER_MODEL_CHOICES}
              onChange={(v) => void superSave.save(() => patchAgentSettings({ superModel: v }))} />
            <Pick aria={t('settings.agents.super_effort')} testId="settings-super-effort" value={agentCfg.superEffort} choices={SUPER_EFFORT_CHOICES}
              onChange={(v) => void superSave.save(() => patchAgentSettings({ superEffort: v }))} />
          </span>
        )}
      />
      <SettingRow
        title={t('shell.settings.models.assistant')}
        hint={noAssistant ? t('shell.settings.models.noAssistant') : t('shell.settings.models.assistantHint')}
        status={<SaveMark state={assistantSave.state} />}
        control={(
          <span className="settings-models-pair">
            <Pick aria={`${t('shell.settings.models.assistant')} model`} testId="models-assistant-model" value={a.model || ASSISTANT_DEFAULT.model} choices={CHAT_MODELS} disabled={assistant === null || noAssistant}
              onChange={(v) => void assistantSave.save(async () => {
                const c = await saveProfile({ model: v });
                setAssistant({ model: c.model ?? '', effort: c.effort ?? '' });
              })} />
            <Pick aria={`${t('shell.settings.models.assistant')} effort`} testId="models-assistant-effort" value={a.effort || ASSISTANT_DEFAULT.effort} choices={EFFORTS} disabled={assistant === null || noAssistant}
              onChange={(v) => void assistantSave.save(async () => {
                const c = await saveProfile({ effort: v });
                setAssistant({ model: c.model ?? '', effort: c.effort ?? '' });
              })} />
          </span>
        )}
      />
      <SettingRow
        title={t('shell.settings.models.sleep')}
        hint={sleepModel === null || sleepEffort === null ? t('shell.settings.models.sleepMixed') : t('shell.settings.models.sleepHint')}
        status={<SaveMark state={sleepSave.state} />}
        control={(
          <span className="settings-models-pair">
            <select className="settings-text-input" aria-label={`${t('shell.settings.models.sleep')} model`} data-testid="models-sleep-model"
              value={sleepModel ?? '\u0000mixed'} onChange={(e) => setSleep('model', e.target.value)}>
              {sleepModel === null && <option value={'\u0000mixed'} disabled>{t('shell.settings.models.mixed')}</option>}
              <option value="">{inherit}</option>
              {SLEEP_MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <select className="settings-text-input" aria-label={`${t('shell.settings.models.sleep')} effort`} data-testid="models-sleep-effort"
              value={sleepEffort ?? '\u0000mixed'} onChange={(e) => setSleep('effort', e.target.value)}>
              {sleepEffort === null && <option value={'\u0000mixed'} disabled>{t('shell.settings.models.mixed')}</option>}
              <option value="">{inherit}</option>
              {SLEEP_EFFORT_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button type="button" className="settings-models-link" onClick={onOpenSleep}>{t('shell.settings.models.details')}</button>
          </span>
        )}
      />
    </SettingGroup>
  );
}
