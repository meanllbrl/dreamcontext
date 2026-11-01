import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../../context/I18nContext';
import { useApi } from '../../../context/VaultContext';
import { SettingGroup, SettingRow, Toggle } from '../SettingRow';
import { SaveMark, useInstantSave } from '../useInstantSave';
import { Seg } from './controls';

type RulesTool = 'claude' | 'codex';
type Strategy = 'score' | 'sequential';
type OnExhausted = 'stop' | 'continue';
interface Weights { session: number; weekly: number; order: number }
export interface ToolRulesState {
  autoSwitch: boolean;
  strategy: Strategy;
  weights: Weights;
  agentThreshold: number;
  onExhausted: OnExhausted;
}
type RulesResponse = Record<RulesTool, ToolRulesState>;

const THRESHOLDS = [70, 80, 90] as const;
const WEIGHT_KEYS: ReadonlyArray<keyof Weights> = ['session', 'weekly', 'order'];

/** Both tools' limit rules as they are in force (`GET /api/agent/accounts/rules`). */
export function useToolRules() {
  const api = useApi();
  return useQuery({
    queryKey: ['agent-account-rules'],
    queryFn: () => api.get<RulesResponse>('/agent/accounts/rules'),
    staleTime: 10_000,
  });
}

/** The threshold choices, with a stored value outside 70/80/90 kept as its own option. */
export function thresholdChoices(current: number | undefined): number[] {
  const base: number[] = [...THRESHOLDS];
  if (current !== undefined && !base.includes(current)) base.push(current);
  return base.sort((a, b) => a - b);
}

/**
 * One tool's Limit rules (Settings window → Models → the tool's tab). Each tool keeps its own:
 * a switch never leaves the tool, and editing Claude's never moves Codex's
 * (`src/lib/account-rules.ts`). Every control writes its own key at once.
 */
export function ToolRules({ tool, toolName, accountCount }: { tool: RulesTool; toolName: string; accountCount: number }) {
  const { t } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useToolRules();
  const r = data?.[tool];
  const sw = useInstantSave();
  const pick = useInstantSave();
  const th = useInstantSave();
  const out = useInstantSave();

  const post = async (patch: Partial<ToolRulesState> | { weights: Partial<Weights> }) => {
    const next = await api.post<RulesResponse>('/agent/accounts/rules', { tool, patch });
    qc.setQueryData(['agent-account-rules'], next);
    // Claude's switch policy is also read by the accounts list and the chat's picker.
    if (tool === 'claude') void qc.invalidateQueries({ queryKey: ['agent-claude-accounts'] });
  };

  const many = accountCount > 1;
  const passive = !many ? t('shell.sw.rules.oneAccount') : undefined;

  return (
    <SettingGroup tab={tool} title={t('shell.sw.rules')}>
      <SettingRow
        id={`${tool}-switch`}
        title={t('shell.sw.rules.switch')}
        hint={t('shell.sw.rules.switch.h').replace('{tool}', toolName)}
        keywords="limit auto switch account near limit"
        status={<SaveMark state={sw.state} />}
        control={<Toggle label={t('shell.sw.rules.switch')} checked={r?.autoSwitch ?? true} disabled={!r} onChange={(v) => { void sw.save(() => post({ autoSwitch: v })); }} />}
      />
      <SettingRow
        id={`${tool}-pick`}
        title={t('shell.sw.rules.pick')}
        hint={t(r?.strategy === 'sequential' ? 'shell.sw.rules.pick.drain.h' : 'shell.sw.rules.pick.spread.h')}
        keywords="limit strategy spread drain order weights next account"
        why={passive}
        status={<SaveMark state={pick.state} />}
        control={(
          <Seg<Strategy>
            label={t('shell.sw.rules.pick')}
            value={r?.strategy ?? 'score'}
            disabled={!r}
            onChange={(v) => { void pick.save(() => post({ strategy: v })); }}
            options={[{ value: 'score', label: t('shell.sw.rules.pick.spread') }, { value: 'sequential', label: t('shell.sw.rules.pick.drain') }]}
          />
        )}
      >
        {r?.strategy !== 'sequential' && r && (
          <details className="setting-row-more">
            <summary>{t('shell.sw.details')}</summary>
            <WeightFields tool={tool} saved={r.weights} onSave={(w) => post({ weights: w })} />
          </details>
        )}
      </SettingRow>
      <SettingRow
        id={`${tool}-threshold`}
        title={t('accounts.threshold.title')}
        hint={t('shell.sw.rules.threshold.h')}
        keywords="limit agent jobs routines threshold percent protect"
        status={<SaveMark state={th.state} />}
        control={(
          <Seg
            label={t('accounts.threshold.title')}
            value={String(r?.agentThreshold ?? 80)}
            disabled={!r}
            onChange={(v) => { void th.save(() => post({ agentThreshold: Number(v) })); }}
            options={thresholdChoices(r?.agentThreshold).map((n) => ({ value: String(n), label: `${n}%` }))}
          />
        )}
      />
      <SettingRow
        id={`${tool}-out`}
        title={t('shell.sw.rules.out')}
        hint={t(r?.onExhausted === 'continue' ? 'shell.sw.rules.out.continue.h' : 'shell.sw.rules.out.stop.h')}
        keywords="limit reset resume continue wait exhausted out"
        status={<SaveMark state={out.state} />}
        control={(
          <Seg<OnExhausted>
            label={t('shell.sw.rules.out')}
            value={r?.onExhausted ?? 'stop'}
            disabled={!r}
            onChange={(v) => { void out.save(() => post({ onExhausted: v })); }}
            options={[{ value: 'stop', label: t('shell.sw.rules.out.stop') }, { value: 'continue', label: t('shell.sw.rules.out.continue') }]}
          />
        )}
      />
    </SettingGroup>
  );
}

/**
 * The spread rule's three weights. A field commits on blur or Enter and sends only itself, so a
 * value saved meanwhile elsewhere is never overwritten; a refused write puts the old number back.
 */
function WeightFields({ tool, saved, onSave }: { tool: RulesTool; saved: Weights; onSave: (w: Partial<Weights>) => Promise<void> }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Partial<Record<keyof Weights, string>>>({});
  const [err, setErr] = useState(false);
  useEffect(() => { setDraft({}); }, [saved.session, saved.weekly, saved.order]);
  const commit = (k: keyof Weights) => {
    const raw = draft[k];
    if (raw === undefined) return;
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || n === saved[k]) { setDraft((d) => ({ ...d, [k]: undefined })); return; }
    setErr(false);
    onSave({ [k]: n }).catch(() => { setErr(true); setDraft((d) => ({ ...d, [k]: undefined })); });
  };
  return (
    <span className="sw-weights" data-testid={`sw-weights-${tool}`}>
      {WEIGHT_KEYS.map((k) => (
        <label key={k}>
          <span>{t(`shell.sw.rules.w.${k}`)}</span>
          <input
            type="number"
            min={0}
            step={0.5}
            className="settings-text-input"
            value={draft[k] ?? String(saved[k])}
            onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
            onBlur={() => commit(k)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(k); }}
          />
        </label>
      ))}
      {err && <span className="setting-row-why">{t('common.error')}</span>}
    </span>
  );
}
