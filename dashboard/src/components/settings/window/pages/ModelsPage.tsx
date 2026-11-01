import type { ReactNode } from 'react';
import { useI18n } from '../../../../context/I18nContext';
import { useAgentTools, useClaudeAccounts, useCodexAccounts } from '../../../../hooks/useAgentCapabilities';
import { SLEEP_SPECIALISTS, type SleepSpecialist } from '../../../../hooks/useConfig';
import { SettingGroup, SettingRow } from '../../SettingRow';
import { ClaudeAccounts } from '../../ClaudeAccounts';
import { CodexAccounts } from '../../ToolAccounts';
import { ToolMark } from '../../../sleepy/chat/model-picker/ModelPicker';
import type { SettingsTarget } from '../../../sleepy/chat/model-picker/ModelPicker';
import { PageHead } from '../controls';
import { pageDescKey, pageTitleKey, type SwModelsTab } from '../sections';
import { HelperChip, JobChip, useAssistantState, type Job } from '../JobChip';
import { ToolRules } from '../ToolRules';
import type { WindowPageProps } from '../SettingsWindow';

const TABS: ReadonlyArray<{ id: SwModelsTab; name: string }> = [
  { id: 'defaults', name: '' },
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'opencode', name: 'OpenCode' },
];

const JOBS: ReadonlyArray<{ job: Job; key: string; kw: string }> = [
  { job: 'chat', key: 'chat', kw: 'chat new chats default model effort opus sonnet codex' },
  { job: 'super', key: 'super', kw: 'super agent model effort' },
  { job: 'assistant', key: 'assistant', kw: 'assistant notch model effort' },
  { job: 'sleep', key: 'sleep', kw: 'sleep line specialist helper model effort' },
];

const HELPER_KEY: Record<SleepSpecialist, string> = {
  'sleep-tasks': 'tasks',
  'sleep-state': 'state',
  'sleep-product': 'product',
  'sleep-migration': 'migration',
  'sleep-learn': 'learn',
};

/**
 * Models (Settings window): Defaults (one chip per job, then the sleep helpers), and one tab per
 * tool with the same template: whether it is in use, its accounts, its own limit rules.
 * Search draws every tab's groups (each carries `data-tab`), so a hit jumps to its tab.
 */
export function ModelsPage({ tab, setTab, searching }: WindowPageProps) {
  const { t } = useI18n();
  const openTab = (target: SettingsTarget) => setTab(target === 'accounts-codex' ? 'codex' : target === 'accounts' ? 'claude' : 'defaults');
  const show = (id: SwModelsTab) => searching || tab === id;
  return (
    <>
      <PageHead title={t(pageTitleKey('models'))} desc={t(pageDescKey('models'))} />
      {!searching && (
        <div className="sw-tabs" role="tablist" aria-label={t(pageTitleKey('models'))}>
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={tab === x.id}
              className={`sw-tab${tab === x.id ? ' on' : ''}`}
              data-sw-tab={x.id}
              onClick={() => setTab(x.id)}
            >
              {(x.id === 'claude' || x.id === 'codex') && <span className="sw-tab-mark"><ToolMark tool={x.id} /></span>}
              {x.id === 'defaults' ? t('shell.sw.models.defaults') : x.name}
            </button>
          ))}
        </div>
      )}
      {show('defaults') && <DefaultsTab onOpenTab={openTab} />}
      {show('claude') && <ClaudeTab />}
      {show('codex') && <CodexTab />}
      {show('antigravity') && <LaterTab id="antigravity" name="Antigravity" />}
      {show('opencode') && <LaterTab id="opencode" name="OpenCode" />}
    </>
  );
}

function DefaultsTab({ onOpenTab }: { onOpenTab: (t: SettingsTarget) => void }) {
  const { t } = useI18n();
  // A passive chip says why in its row, where it can be read (a disabled button shows no tooltip).
  const noAssistant = useAssistantState().data === 'none';
  return (
    <>
      <SettingGroup tab="defaults">
        {JOBS.map((j) => (
          <SettingRow
            key={j.job}
            id={`job-${j.job}`}
            title={t(`shell.sw.models.${j.key}`)}
            hint={t(`shell.sw.models.${j.key}.h`)}
            keywords={j.kw}
            why={j.job === 'assistant' && noAssistant ? t('shell.sw.models.noAssistant') : undefined}
            control={<JobChip job={j.job} onOpenTab={onOpenTab} />}
          />
        ))}
      </SettingGroup>
      <SettingGroup tab="defaults" title={t('shell.sw.models.helpers')} note={t('shell.sw.models.helpers.note')}>
        {SLEEP_SPECIALISTS.map((n) => (
          <SettingRow
            key={n}
            id={`helper-${HELPER_KEY[n]}`}
            title={t(`shell.sw.models.helper.${HELPER_KEY[n]}`)}
            hint={t(`shell.sw.models.helper.${HELPER_KEY[n]}.h`)}
            keywords={`sleep helper specialist ${HELPER_KEY[n]} model effort`}
            control={<HelperChip name={n} label={t(`shell.sw.models.helper.${HELPER_KEY[n]}`)} />}
          />
        ))}
      </SettingGroup>
    </>
  );
}

function UseRow({ tool, title, hint, state }: { tool: string; title: string; hint: string; state: ReactNode }) {
  return (
    <SettingGroup tab={tool}>
      <SettingRow id={`${tool}-use`} title={title} hint={hint} keywords="tool provider agent cli sign in installed" control={<span className="sw-state">{state}</span>} />
    </SettingGroup>
  );
}

function ClaudeTab() {
  const { t } = useI18n();
  const n = useClaudeAccounts(true).data?.accounts?.length ?? 0;
  return (
    <>
      <UseRow tool="claude" title={t('shell.sw.models.use').replace('{tool}', 'Claude Code')} hint={t('shell.sw.models.use.claude.h')} state={t('shell.sw.models.always')} />
      <SettingGroup tab="claude" title={t('shell.sw.models.accounts')}><div className="sw-wide sw-acc"><ClaudeAccounts policy={false} /></div></SettingGroup>
      <ToolRules tool="claude" toolName="Claude Code" accountCount={n} />
    </>
  );
}

function CodexTab() {
  const { t } = useI18n();
  const info = useAgentTools().data?.find((x) => x.tool === 'codex');
  const n = useCodexAccounts(true).data?.accounts?.length ?? 0;
  const state = !info ? '' : !info.installed ? t('shell.sw.models.state.notInstalled') : !info.signedIn ? t('shell.sw.models.state.signIn') : info.ready ? t('shell.sw.models.state.ready') : t('shell.sw.models.state.needsNode');
  return (
    <>
      <UseRow tool="codex" title={t('shell.sw.models.use').replace('{tool}', 'Codex')} hint={t('shell.sw.models.use.codex.h')} state={state} />
      <SettingGroup tab="codex" title={t('shell.sw.models.accounts')}><div className="sw-wide sw-acc"><CodexAccounts /></div></SettingGroup>
      <ToolRules tool="codex" toolName="Codex" accountCount={n} />
    </>
  );
}

/** A tool with no backend in this version: passive, and it says so. No made-up accounts. */
function LaterTab({ id, name }: { id: SwModelsTab; name: string }) {
  const { t } = useI18n();
  return (
    <SettingGroup tab={id}>
      <SettingRow
        id={`${id}-use`}
        title={t('shell.sw.models.use').replace('{tool}', name)}
        hint={t('shell.sw.models.later.h').replace('{tool}', name)}
        keywords={`tool provider ${id}`}
        why={t('shell.sw.models.later.why')}
        control={<span className="sw-state">{t('shell.sw.models.state.later')}</span>}
      />
    </SettingGroup>
  );
}
