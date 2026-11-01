import { useState, type ReactNode } from 'react';
import { useI18n } from '../../../../context/I18nContext';
import { useTheme } from '../../../../context/ThemeContext';
import { useVault } from '../../../../context/VaultContext';
import { useChrome } from '../../../layout/WindowChrome';
import { SettingGroup, SettingRow, Toggle } from '../../SettingRow';
import { SaveMark, useInstantSave } from '../../useInstantSave';
import { NewLayoutSetting } from '../../NewLayoutSetting';
import { EcoModeRow } from '../../EcoModeRow';
import { SleepSettings } from '../../SleepSettings';
import { TaskOverrideEditor } from '../../TaskOverrideEditor';
import { ConnectionsManager } from '../../ConnectionsManager';
import { SystemDependencies } from '../../SystemDependencies';
import { AutoUpdateSetting } from '../../AutoUpdateSetting';
import { LoopbackPorts } from '../../LoopbackPorts';
import { LinkedRepos } from '../../../brain/LinkedRepos';
import { HandsfreeSettingsCard } from '../../../handsfree/HandsfreeSettingsCard';
import { isDesktop } from '../../../../lib/desktop';
import { useTheses, useSetLearningEnabled } from '../../../../hooks/useTheses';
import { useLightMode } from '../../../../lib/lightMode';
import { readChatPermissionMode, writeChatPermissionMode, type AgentSettings } from '../../../../lib/agentSettings';
import { setSuperSounds, superSoundsEnabled } from '../../../../lib/superSfx';
import { PageHead, Seg } from '../controls';
import { pageDescKey, pageTitleKey, type SwPageId } from '../sections';
import { useAgentCfg } from '../useAgentCfg';

/** What every page receives: the jobs' model rows come from Models (wave 3 fills `chip`). */
export interface PageProps {
  /** Search is drawing every page: no page-level actions, every group shown. */
  searching?: boolean;
  /** The model chip for one job, or null while it is not built. */
  chip?: (job: 'chat' | 'super' | 'assistant' | 'sleep') => ReactNode;
  /** Open another page of the window (a "Team sync ›" link). */
  go?: (page: SwPageId) => void;
}

function Head({ id, action }: { id: SwPageId; action?: ReactNode }) {
  const { t } = useI18n();
  return <PageHead title={t(pageTitleKey(id))} desc={t(pageDescKey(id))} action={action} />;
}

/** A field change that writes through and shows its own Saved mark. */
function useCfgRow(update: (p: Partial<AgentSettings>) => Promise<boolean>) {
  const save = useInstantSave();
  const write = (patch: Partial<AgentSettings>) => {
    void save.save(async () => { if (!(await update(patch))) throw new Error('not saved'); });
  };
  return { state: save.state, write };
}

const ZOOMS = [0.85, 0.9, 1, 1.1, 1.2] as const;

// ─── General ────────────────────────────────────────────────────────────────

export function GeneralPage({ searching }: PageProps) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const { zoom, setZoom } = useChrome();
  const { cfg, update } = useAgentCfg();
  const light = useLightMode();
  const reopen = useCfgRow(update);
  const battery = useCfgRow(update);
  const [confirm, setConfirm] = useState(false);

  const mods: string[] = [];
  if (theme !== 'system') mods.push(t('shell.sw.general.theme'));
  if (zoom !== 1) mods.push(t('shell.sw.general.zoom'));
  if (cfg && !cfg.restoreTabs) mods.push(t('shell.sw.general.reopen'));
  if (cfg && cfg.lightMode !== 'auto') mods.push(t('shell.sw.general.battery'));

  const restore = () => {
    setTheme('system');
    setZoom(1);
    void update({ restoreTabs: true, lightMode: 'auto' });
    setConfirm(false);
  };

  const action = searching ? undefined : (
    <button type="button" className="sw-btn" disabled={mods.length === 0} onClick={() => setConfirm(true)} data-testid="sw-restore">
      ↺ {t('shell.sw.general.restore')}
    </button>
  );

  return (
    <>
      <Head id="general" action={action} />
      {confirm && !searching && (
        <div className="sw-confirm" role="alertdialog" aria-label={t('shell.sw.general.restore')}>
          <b>{t('shell.sw.general.restoreQ').replace('{n}', String(mods.length))}</b>
          <span>{t('shell.sw.general.restoreBody').replace('{list}', mods.join(', '))}</span>
          <span className="sw-confirm-btns">
            <button type="button" className="sw-btn" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
            <button type="button" className="sw-btn sw-btn--accent" onClick={restore}>{t('shell.sw.general.restoreGo')}</button>
          </span>
        </div>
      )}
      <SettingGroup title={t('shell.sw.general.appearance')}>
        <SettingRow
          id="theme"
          title={t('shell.sw.general.theme')}
          hint={t('shell.sw.general.theme.h')}
          keywords="dark light appearance color"
          control={<Seg label={t('shell.sw.general.theme')} value={theme} onChange={setTheme}
            options={[{ value: 'system', label: t('shell.sw.general.theme.system') }, { value: 'light', label: t('shell.sw.general.theme.light') }, { value: 'dark', label: t('shell.sw.general.theme.dark') }]} />}
        />
        <SettingRow
          id="zoom"
          title={t('shell.sw.general.zoom')}
          hint={t('shell.sw.general.zoom.h')}
          keywords="text size scale bigger smaller"
          control={<Seg label={t('shell.sw.general.zoom')} value={String(zoom)} onChange={(v) => setZoom(Number(v))}
            options={ZOOMS.map((z) => ({ value: String(z), label: `${Math.round(z * 100)}%` }))} />}
        />
      </SettingGroup>
      <SettingGroup title={t('shell.sw.general.launch')}>
        <SettingRow
          id="reopen"
          title={t('shell.sw.general.reopen')}
          hint={t('shell.sw.general.reopen.h')}
          keywords="restore tabs launch"
          status={<SaveMark state={reopen.state} />}
          control={<Toggle label={t('shell.sw.general.reopen')} checked={cfg?.restoreTabs ?? true} disabled={!cfg} onChange={(v) => reopen.write({ restoreTabs: v })} />}
        />
      </SettingGroup>
      <SettingGroup title={t('shell.sw.general.performance')}>
        <SettingRow
          id="battery"
          title={t('shell.sw.general.battery')}
          hint={t('shell.sw.general.battery.h')}
          keywords="light mode low power performance animations"
          why={cfg?.lightMode === 'auto' && light.on && light.reason !== 'setting'
            ? t(light.reason === 'battery' ? 'settings.performance.light_active_battery' : light.reason === 'low-power' ? 'settings.performance.light_active_low_power' : 'settings.performance.light_active_ram')
            : undefined}
          status={<SaveMark state={battery.state} />}
          control={<Seg label={t('shell.sw.general.battery')} value={cfg?.lightMode ?? 'auto'} disabled={!cfg} onChange={(v) => battery.write({ lightMode: v })}
            options={[{ value: 'auto', label: t('settings.performance.light_auto') }, { value: 'on', label: t('settings.performance.light_on') }, { value: 'off', label: t('settings.performance.light_off') }]} />}
        />
      </SettingGroup>
      <NewLayoutSetting />
    </>
  );
}

// ─── Chat ───────────────────────────────────────────────────────────────────

export function ChatPage({ chip, go }: PageProps) {
  const { t } = useI18n();
  const { vault, bus } = useVault();
  const { cfg, update } = useAgentCfg();
  const [perm, setPerm] = useState(() => readChatPermissionMode(vault));
  const autoTitle = useCfgRow(update);
  const park = useCfgRow(update);
  return (
    <>
      <Head id="chat" />
      <SettingGroup title={t('shell.sw.chat.new')}>
        <SettingRow
          id="cmodel"
          title={t('shell.sw.model')}
          hint={t('shell.sw.model.same')}
          keywords="model effort opus sonnet haiku codex default tool"
          control={chip?.('chat') ?? <ModelsLink go={go} />}
        />
        <SettingRow
          id="perm"
          title={t('shell.sw.chat.perm')}
          hint={t('shell.sw.chat.perm.h')}
          keywords="permission bypass auto approve ask"
          control={(
            <>
              <span className="sw-scope">{t('shell.sw.scope.project')}</span>
              <Seg label={t('shell.sw.chat.perm')} value={perm} onChange={(v) => { setPerm(v); writeChatPermissionMode(bus, vault, v); }}
                options={[{ value: 'auto', label: 'Auto' }, { value: 'bypass', label: 'Bypass' }]} />
            </>
          )}
        />
        <EcoModeRow />
        <SettingRow
          id="autoname"
          title={t('settings.agents.auto_title')}
          hint={t('settings.agents.auto_title_hint')}
          keywords="auto title tab name rename"
          status={<SaveMark state={autoTitle.state} />}
          control={<Toggle label={t('settings.agents.auto_title')} checked={cfg?.autoTitle ?? true} disabled={!cfg} onChange={(v) => autoTitle.write({ autoTitle: v })} />}
        />
      </SettingGroup>
      <SettingGroup title={t('shell.sw.chat.busy')}>
        <SettingRow
          id="park"
          title={t('settings.agents.park')}
          hint={t('settings.agents.park_hint')}
          more={t('settings.agents.park_more')}
          keywords="park idle under load memory disk"
          status={<SaveMark state={park.state} />}
          control={<Toggle label={t('settings.agents.park')} checked={cfg?.parkIdleChats ?? true} disabled={!cfg} onChange={(v) => park.write({ parkIdleChats: v })} />}
        />
      </SettingGroup>
    </>
  );
}

function ModelsLink({ go }: { go?: (page: SwPageId) => void }) {
  const { t } = useI18n();
  return <button type="button" className="sw-btn" onClick={() => go?.('models')}>{t('shell.sw.page.models')} ›</button>;
}

// ─── Super Agent ────────────────────────────────────────────────────────────

export function SuperPage({ chip, go }: PageProps) {
  const { t } = useI18n();
  const [sounds, setSounds] = useState(superSoundsEnabled);
  return (
    <>
      <Head id="super" />
      <SettingGroup>
        <SettingRow
          id="smodel"
          title={t('shell.sw.model')}
          hint={t('shell.sw.model.same')}
          keywords="super model effort opus"
          control={chip?.('super') ?? <ModelsLink go={go} />}
        />
        <SettingRow
          id="ssound"
          title={t('settings.super.sounds')}
          hint={t('settings.super.soundsNote')}
          keywords="chime sound notification"
          control={<Toggle label={t('settings.super.sounds')} checked={sounds} onChange={(v) => { setSuperSounds(v); setSounds(v); }} />}
        />
        <SettingRow
          id="sports"
          title={t('settings.super.ports.title')}
          hint={t('settings.super.ports.note')}
          keywords="loopback port localhost sites"
          control={<LoopbackPorts />}
        />
      </SettingGroup>
    </>
  );
}

// ─── Sleep (with Hypotheses) ────────────────────────────────────────────────

export function SleepPage({ chip, go }: PageProps) {
  const { t } = useI18n();
  const { data: theses } = useTheses();
  const setLearning = useSetLearningEnabled();
  const modelRow = (
    <SettingGroup title={t('shell.sw.sleep.model')}>
      <SettingRow
        id="slmodel"
        title={t('shell.sw.model')}
        hint={t('shell.sw.model.same')}
        keywords="specialist helper model effort sleep"
        control={chip?.('sleep') ?? <ModelsLink go={go} />}
      />
    </SettingGroup>
  );
  return (
    <>
      <Head id="sleep" />
      <SleepSettings modelRow={modelRow} />
      <SettingGroup title={t('shell.sw.sleep.hyp')}>
        <SettingRow
          id="learning"
          labelled
          title={t('settings.learning.label')}
          hint={t('settings.learning.row_hint')}
          keywords="learning hypotheses thesis proactive"
          why={setLearning.isError ? t('common.error') : undefined}
          control={<Toggle checked={theses?.enabled === true} disabled={setLearning.isPending} onChange={(v) => setLearning.mutate(v)} />}
        />
      </SettingGroup>
    </>
  );
}

// ─── Project ────────────────────────────────────────────────────────────────

export function TasksPage() {
  return (<><Head id="tasks" /><TaskOverrideEditor /></>);
}

export function ReposPage() {
  return (<><Head id="repos" /><SettingGroup><div className="sw-wide"><LinkedRepos compact /></div></SettingGroup></>);
}

// ─── Connections ────────────────────────────────────────────────────────────

export function ConnectedPage() {
  return (<><Head id="connected" /><ConnectionsManager /></>);
}

export function HandsfreePage() {
  const { t } = useI18n();
  // The card hides itself outside the desktop app; the page then says why instead of standing empty.
  if (!isDesktop()) {
    return (
      <>
        <Head id="handsfree" />
        <SettingGroup>
          <SettingRow id="handsfree" title={t(pageTitleKey('handsfree'))} hint={t(pageDescKey('handsfree'))} keywords="phone mac mode remote" why={t('shell.sw.assistant.desktopOnly')} control={<Toggle label={t(pageTitleKey('handsfree'))} checked={false} disabled onChange={() => {}} />} />
        </SettingGroup>
      </>
    );
  }
  return (<><Head id="handsfree" /><HandsfreeSettingsCard /></>);
}

// ─── System ─────────────────────────────────────────────────────────────────

export function SystemPage() {
  const { t } = useI18n();
  return (
    <>
      <Head id="system" />
      <SettingGroup title={t('shell.sw.system.software')}><div className="sw-wide"><SystemDependencies /></div></SettingGroup>
      <AutoUpdateSetting />
    </>
  );
}
