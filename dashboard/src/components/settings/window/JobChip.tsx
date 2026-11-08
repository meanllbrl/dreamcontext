import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../../context/I18nContext';
import { useAgentModelConfig, useAgentTools, codexModelConfig } from '../../../hooks/useAgentCapabilities';
import {
  SLEEP_EFFORT_OPTIONS, useConfig, useSleepSpecialistDefaults, useUpdateConfig, type SleepSpecialist,
} from '../../../hooks/useConfig';
import { FALLBACK_MODEL_CONFIG } from '../../../lib/agentComposer';
import { SUPER_EFFORT_CHOICES, type AgentSettings } from '../../../lib/agentSettings';
import { getAssistantStatus, saveProfile } from '../../../lib/assistantProfile';
import { SaveMark, useInstantSave } from '../useInstantSave';
import { ModelChip } from './ModelChip';
import type { SettingsTarget } from '../../sleepy/chat/model-picker/ModelPicker';
import { useAgentCfg } from './useAgentCfg';

export type Job = 'chat' | 'super' | 'assistant' | 'sleep';

/** MIRRORED from `src/lib/assistant/home.ts`: what the Assistant runs on before anyone picks. */
const ASSISTANT_DEFAULT = { model: 'sonnet', effort: 'medium' } as const;

/** A refused write is not a save (`patchAgentSettings` resolves `{ ok: false }`). */
function useCfgWrite() {
  const { cfg, update } = useAgentCfg();
  const save = useInstantSave();
  const write = (patch: Partial<AgentSettings>) => {
    void save.save(async () => { if (!(await update(patch))) throw new Error('not saved'); });
  };
  return { cfg, write, state: save.state };
}

/**
 * One job's chip: the same choice wherever the job appears (its own page and Models →
 * Defaults). Each writes the job's existing key; a tool the job cannot run on is passive in
 * the picker and says why.
 */
export function JobChip({ job, onOpenTab }: { job: Job; onOpenTab?: (t: SettingsTarget) => void }) {
  if (job === 'chat') return <ChatChip onOpenTab={onOpenTab} />;
  if (job === 'super') return <SuperChip />;
  if (job === 'assistant') return <AssistantChip />;
  return <SleepChip />;
}

function ChatChip({ onOpenTab }: { onOpenTab?: (t: SettingsTarget) => void }) {
  const { t } = useI18n();
  const { cfg, write, state } = useCfgWrite();
  const claude = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const codex = codexModelConfig(useAgentTools().data?.find((x) => x.tool === 'codex'));
  if (!cfg) return null;
  const onCodex = cfg.chatDefaultTool === 'codex';
  return (
    <>
      <SaveMark state={state} />
      <ModelChip
        label={t('shell.sw.models.chat')}
        testId="sw-chip-chat"
        value={{ tool: onCodex ? 'codex' : 'claude', model: onCodex ? cfg.codexDefaultModel : cfg.chatDefaultModel, effort: onCodex ? cfg.codexDefaultEffort : cfg.chatDefaultEffort }}
        fallback={onCodex
          ? { model: codex?.defaultModel ?? '', effort: codex?.defaultEffort ?? '' }
          : { model: claude.defaultModel, effort: claude.defaultEffort }}
        onPick={(tool, model) => write(tool === 'codex'
          ? { chatDefaultTool: 'codex', codexDefaultModel: model }
          : { chatDefaultTool: '', chatDefaultModel: model })}
        onEffort={(effort) => write(onCodex ? { codexDefaultEffort: effort } : { chatDefaultEffort: effort })}
        onOpenTab={onOpenTab}
      />
    </>
  );
}

function SuperChip() {
  const { t } = useI18n();
  const { cfg, write, state } = useCfgWrite();
  if (!cfg) return null;
  return (
    <>
      <SaveMark state={state} />
      <ModelChip
        label={t('shell.sw.models.super')}
        testId="sw-chip-super"
        value={{ tool: 'claude', model: cfg.superModel, effort: cfg.superEffort }}
        target={{ lockedTools: { codex: t('shell.sw.locked.super') }, efforts: [...SUPER_EFFORT_CHOICES] }}
        onPick={(_tool, model) => write({ superModel: model })}
        onEffort={(effort) => write({ superEffort: effort })}
      />
    </>
  );
}

const ASSISTANT_KEY = ['sw-assistant-status'] as const;
type AssistantState = { model: string; effort: string } | 'none';

/** Whether this computer has an Assistant, and what it runs on. Shared by the chip and its row
 *  (which says why the chip is passive). The status route answers before the Assistant exists
 *  (the profile route is a 404 then). */
export function useAssistantState() {
  return useQuery<AssistantState>({
    queryKey: ASSISTANT_KEY,
    // A failed read is no answer (data stays undefined, the chip passive and silent): it must not
    // claim there is no assistant.
    queryFn: () => getAssistantStatus().then(
      (st): AssistantState => (st.exists && st.config ? { model: st.config.model ?? '', effort: st.config.effort ?? '' } : 'none'),
    ),
    retry: false,
  });
}

function AssistantChip() {
  const { t } = useI18n();
  const save = useInstantSave();
  const qc = useQueryClient();
  const a = useAssistantState().data ?? null;
  const cur = a && a !== 'none' ? a : { model: '', effort: '' };
  const write = (patch: { model?: string; effort?: string }) => {
    void save.save(async () => {
      const c = await saveProfile(patch);
      qc.setQueryData<AssistantState>(ASSISTANT_KEY, { model: c.model ?? '', effort: c.effort ?? '' });
    });
  };
  return (
    <>
      <SaveMark state={save.state} />
      <ModelChip
        label={t('shell.sw.models.assistant')}
        testId="sw-chip-assistant"
        value={{ tool: 'claude', model: cur.model, effort: cur.effort }}
        fallback={ASSISTANT_DEFAULT}
        disabled={a === null || a === 'none'}
        why={a === 'none' ? t('shell.sw.models.noAssistant') : undefined}
        target={{ lockedTools: { codex: t('shell.sw.locked.assistant') } }}
        onPick={(_tool, model) => write({ model })}
        onEffort={(effort) => write({ effort })}
      />
    </>
  );
}

/** The Sleep line: every helper that is not pinned follows it. */
function SleepChip() {
  const { t } = useI18n();
  const { data: config } = useConfig();
  const update = useUpdateConfig();
  const save = useInstantSave();
  const line = config?.sleep;
  const write = (patch: { model?: string; effort?: 'low' | 'medium' | 'high' }) => {
    void save.save(() => update.mutateAsync({ sleep: patch }));
  };
  return (
    <>
      <SaveMark state={save.state} />
      <ModelChip
        label={t('shell.sw.models.sleep')}
        testId="sw-chip-sleep"
        value={{ tool: 'claude', model: line?.model ?? '', effort: line?.effort ?? '' }}
        fallback={{ model: '', effort: '', text: t('shell.sw.models.sleep.unset') }}
        target={{ lockedTools: { codex: t('shell.sw.locked.sleep') }, efforts: [...SLEEP_EFFORT_OPTIONS] }}
        onPick={(_tool, model) => write({ model })}
        onEffort={(effort) => write({ effort: effort as 'low' | 'medium' | 'high' })}
      />
    </>
  );
}

/**
 * One sleep helper: follows the Sleep line until it is given its own model; ↺ returns it to
 * the line. With no line and no pin it runs on its own shipped default.
 */
export function HelperChip({ name, label }: { name: SleepSpecialist; label: string }) {
  const { t } = useI18n();
  const { data: config } = useConfig();
  const { data: shipped } = useSleepSpecialistDefaults();
  const update = useUpdateConfig();
  const save = useInstantSave();
  const pin = config?.sleep?.specialists?.[name];
  const pinned = !!(pin?.model || pin?.effort);
  const follows = {
    model: config?.sleep?.model ?? shipped?.[name]?.model ?? '',
    effort: config?.sleep?.effort ?? shipped?.[name]?.effort ?? '',
  };
  const write = (patch: { model?: string; effort?: 'low' | 'medium' | 'high' } | null) => {
    void save.save(() => update.mutateAsync({ sleep: { specialists: { [name]: patch } } }));
  };
  return (
    <>
      <SaveMark state={save.state} />
      {pinned && (
        <button type="button" className="sw-reset" onClick={() => write(null)} title={t('shell.sw.models.helper.reset')} aria-label={`${label}: ${t('shell.sw.models.helper.reset')}`} data-testid={`sw-helper-reset-${name}`}>↺</button>
      )}
      <ModelChip
        label={label}
        testId={`sw-chip-${name}`}
        value={{ tool: 'claude', model: pin?.model ?? '', effort: pin?.effort ?? '' }}
        fallback={follows.model ? follows : { ...follows, text: t('shell.sw.models.sleep.unset') }}
        inherited={!pinned}
        target={{ lockedTools: { codex: t('shell.sw.locked.sleep') }, efforts: [...SLEEP_EFFORT_OPTIONS] }}
        onPick={(_tool, model) => write({ model })}
        onEffort={(effort) => write({ effort: effort as 'low' | 'medium' | 'high' })}
      />
    </>
  );
}
