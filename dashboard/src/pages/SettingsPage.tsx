import { useState, useEffect, useRef } from 'react';
import { useI18n } from '../context/I18nContext';
import { useVault } from '../context/VaultContext';
import { useConfig, useUpdateConfig, type PlatformId } from '../hooks/useConfig';
import { SleepSettings } from '../components/settings/SleepSettings';
import { ConnectionsManager } from '../components/settings/ConnectionsManager';
import { EmbeddingModelCard } from '../components/settings/EmbeddingModelCard';
import { TaskOverrideEditor } from '../components/settings/TaskOverrideEditor';
import { SETTINGS_ICONS } from '../components/settings/SettingsIcons';
import { CloudTaskSync } from '../components/settings/CloudTaskSync';
import { SettingGroup, SettingRow, SettingChoice, Toggle } from '../components/settings/SettingRow';
import { useInstantSave, SaveMark } from '../components/settings/useInstantSave';
import { useAgentCapabilities } from '../hooks/useAgentCapabilities';
import { useAuthStatus, useBrainSettings, useBrainStatus, useUpdateBrainSettings } from '../hooks/useBrainStatus';
import { useSleep, useUpdateSleep, type RecallMode } from '../hooks/useSleep';
import { useTheses, useSetLearningEnabled } from '../hooks/useTheses';
import { GitHubLogin } from '../components/brain/GitHubLogin';
import { OriginSetup } from '../components/brain/OriginSetup';
import { SystemDependencies, FeatureDepsNotice } from '../components/settings/SystemDependencies';
import { ClaudeAccounts } from '../components/settings/ClaudeAccounts';
import { LinkedRepos } from '../components/brain/LinkedRepos';
import { readAutoCheckpointOnOpen, writeAutoCheckpointOnOpen } from '../lib/brainSyncPrefs';
import { isDesktop } from '../lib/desktop';
import {
  readSleepyConfig,
  writeSleepyConfig,
  applySleepyHotkey,
  type SleepyConfig,
} from '../lib/sleepy';
import {
  initAgentSettingsFromServer,
  writeAgentSettings,
  AGENT_SETTINGS_EVENT,
  accelFromKeyEvent as accelFromAgentKey,
  loneModifierToken,
  formatHotkey,
  DOUBLE_TAP_MS,
  type AgentSettings,
} from '../lib/agentSettings';
import './SettingsPage.css';

/** Build a Tauri accelerator (e.g. "Alt+Cmd+S") from a keydown; null if incomplete. */
function accelFromKeyEvent(e: React.KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.metaKey) mods.push('Cmd');
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = e.key;
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null; // modifier-only
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else key = key.charAt(0).toUpperCase() + key.slice(1);
  if (mods.length === 0) return null; // a global hotkey needs at least one modifier
  return [...mods, key].join('+');
}

// ─── Platform options (duplicated client-side — can't import from src/lib) ────

interface PlatformOption {
  id: PlatformId;
  labelKey: string;
}

const PLATFORM_OPTIONS: PlatformOption[] = [
  { id: 'claude', labelKey: 'settings.platform.claude' },
];

// ─── Memory recall modes (mirror RECALL_MODES in src/cli/commands/sleep.ts) ───

interface RecallModeOption {
  mode: RecallMode;
  labelKey: string;
  hintKey: string;
  experimental?: boolean;
}

const RECALL_MODE_OPTIONS: RecallModeOption[] = [
  { mode: 'haiku', labelKey: 'settings.recall.haiku.label', hintKey: 'settings.recall.haiku.hint' },
  { mode: 'raw', labelKey: 'settings.recall.raw.label', hintKey: 'settings.recall.raw.hint' },
  { mode: 'hybrid', labelKey: 'settings.recall.hybrid.label', hintKey: 'settings.recall.hybrid.hint', experimental: true },
  { mode: 'off', labelKey: 'settings.recall.off.label', hintKey: 'settings.recall.off.hint' },
];

// ─── Section navigation (in-page menu) ────────────────────────────────────────

type SettingsSectionId =
  | 'platforms' | 'format' | 'linkedrepos' | 'agents' | 'sleepy'
  | 'memory' | 'sleep' | 'learning' | 'recall'
  | 'github' | 'teamsync' | 'clickup' | 'connections'
  | 'system';

interface SettingsNavItem {
  id: SettingsSectionId;
  labelKey: string;
  desktopOnly?: boolean;
  beta?: boolean;
  lab?: boolean;
}

interface SettingsNavGroup {
  id: string;
  labelKey: string;
  items: SettingsNavItem[];
}

/**
 * The menu is GROUPED, and each row is an icon + a short label — nothing else.
 *
 * The flat nine-row menu carried a one-line description under every label, which
 * the section below then restated at length: a single screen managed to say
 * "Cloud sync" seven times (nav label, nav description, section title, section
 * description, the toggle's own label, the paragraph under it, and its tooltip).
 * One name in the rail, one sentence at the top of the section — that's the rule
 * this structure exists to enforce.
 *
 * The grouping is also what let GitHub stop being three separate setups: project
 * sync and Issues task-mirroring now share one account section under Integrations.
 */
const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    id: 'project',
    labelKey: 'settings.group.project',
    items: [
      { id: 'platforms', labelKey: 'settings.nav.platforms' },
      { id: 'format', labelKey: 'settings.nav.format', beta: true },
      { id: 'linkedrepos', labelKey: 'settings.nav.linkedrepos' },
      { id: 'agents', labelKey: 'settings.nav.agents', desktopOnly: true, beta: true },
      { id: 'sleepy', labelKey: 'settings.nav.sleepy', desktopOnly: true, lab: true },
    ],
  },
  {
    id: 'memory',
    labelKey: 'settings.group.memory',
    items: [
      { id: 'memory', labelKey: 'settings.nav.memory' },
      { id: 'sleep', labelKey: 'settings.nav.sleep' },
      { id: 'learning', labelKey: 'settings.nav.learning' },
      { id: 'recall', labelKey: 'settings.nav.recall' },
    ],
  },
  {
    id: 'integrations',
    labelKey: 'settings.group.integrations',
    items: [
      { id: 'github', labelKey: 'settings.nav.github' },
      { id: 'teamsync', labelKey: 'settings.nav.teamsync' },
      { id: 'clickup', labelKey: 'settings.nav.clickup' },
      { id: 'connections', labelKey: 'settings.nav.connections' },
    ],
  },
  {
    id: 'machine',
    labelKey: 'settings.group.machine',
    items: [
      { id: 'system', labelKey: 'settings.nav.system' },
    ],
  },
];

/** Section header: the name once, then the one sentence that explains it. */
function SectionHead({ titleKey, descKey, badge }: { titleKey: string; descKey: string; badge?: 'beta' | 'lab' }) {
  const { t } = useI18n();
  return (
    <div className="settings-section-head">
      <h2 className="settings-section-title">
        {t(titleKey)}
        {badge === 'beta' && <span className="settings-beta-badge">BETA</span>}
        {badge === 'lab' && <span className="settings-lab-badge">{t('nav.lab')}</span>}
      </h2>
      <p className="settings-section-desc">{t(descKey)}</p>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface SettingsPageProps {
  /** Sidebar deep-link target — `{ id: 'brain', nonce }` opens the GitHub section. */
  focus?: { id: string | null; nonce: number };
}

export function SettingsPage({ focus }: SettingsPageProps) {
  const { t } = useI18n();
  const { data: config, isLoading: configLoading, isError: configError } = useConfig();
  const updateConfig = useUpdateConfig();

  // Whether the desktop-only surfaces (Agents, Sleepy) are available here. The
  // client-side `isDesktop()` (`window.__TAURI_INTERNALS__`) is unreliable in a
  // remote-loaded vault window — Tauri v2 doesn't inject its internals into the
  // http://localhost dashboard origin — so a genuine desktop session reads false
  // there and these panels would vanish. The server's capability probe
  // (`DREAMCONTEXT_DESKTOP=1`, the signal the agent dock itself uses) is the
  // authoritative one; union the two so either positive shows the panels.
  const { data: agentCaps } = useAgentCapabilities();
  const desktopSurfaces = (agentCaps?.desktop ?? false) || isDesktop();

  // Team sync's two preconditions, read here so the SWITCH can be gated on them rather
  // than offered and then refused by the server (400 `no_origin`).
  const { data: brainSettings } = useBrainSettings();
  const { data: brainStatus } = useBrainStatus();
  const { data: githubAuth } = useAuthStatus();
  const updateBrainSettings = useUpdateBrainSettings();
  const githubConnected = githubAuth?.connected === true;
  const hasOrigin = brainStatus?.hasRemote === true;
  // Machine-local "auto-checkpoint on open" preference (localStorage, not team
  // config), and PER VAULT: it decides whether opening THIS project auto-commits its
  // uncommitted work, so it is read and written against this instance's vault.
  const { vault } = useVault();
  const [autoCheckpoint, setAutoCheckpoint] = useState<boolean>(() => readAutoCheckpointOnOpen(vault));

  // Memory recall mode lives in .sleep.json (not the setup config).
  const { data: sleepState } = useSleep();
  const updateSleep = useUpdateSleep();
  const recallMode: RecallMode = sleepState?.recall_mode ?? 'haiku';

  // Learning layer (Hypotheses) switch — dedicated /api/learning endpoints.
  const { data: thesesData } = useTheses();
  const learningEnabled = thesesData?.enabled === true;
  const setLearningEnabled = useSetLearningEnabled();

  // In-page section nav: only one settings group is shown at a time so a
  // specific setting is quick to find instead of buried in one long scroll.
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('platforms');
  const navGroups = SETTINGS_NAV
    .map((g) => ({ ...g, items: g.items.filter((item) => !item.desktopOnly || desktopSurfaces) }))
    .filter((g) => g.items.length > 0);

  // Config-backed switches read straight from the server copy, so a write that
  // fails leaves the control showing what is actually on disk instead of a value
  // the user believes was saved.
  const platforms = config?.platforms ?? [];
  const disableNativeMemory = config?.disableNativeMemory ?? true;
  const platformsSave = useInstantSave();
  const nativeMemorySave = useInstantSave();
  const brainToggleSave = useInstantSave();

  // Sleepy notch quick-capture (desktop-only, persisted in localStorage; applies live).
  const [sleepy, setSleepy] = useState<SleepyConfig>(() => readSleepyConfig());
  const [capturingHotkey, setCapturingHotkey] = useState(false);

  const updateSleepy = (next: SleepyConfig) => {
    setSleepy(next);
    writeSleepyConfig(next);
    void applySleepyHotkey(next);
  };

  // Agents (beta) surface prefs (desktop-only). Seeded from the server so the toggles
  // reflect the persisted truth; each change writes through (localStorage + server +
  // a window event the mounted AgentSurface listens for → applies live, no reload).
  const [agentCfg, setAgentCfg] = useState<AgentSettings | null>(null);
  const [capturingAgentHotkey, setCapturingAgentHotkey] = useState(false);
  // Tracks the last lone-modifier tap while the hotkey field is capturing, so a
  // second tap of the SAME modifier within the window binds a double-tap hotkey.
  const lastModTapRef = useRef<{ token: string; ts: number } | null>(null);
  // Seed from the server, then TRACK the same event this page dispatches — because it is no
  // longer the only editor of this blob. The agent surface floats OVER this page and its tab
  // right-click menu writes `autoTitle`; without this listener the checkbox below would sit
  // stale, and worse, the next whole-object `updateAgentCfg` write would spread that stale
  // snapshot back over the change the user just made in the menu.
  useEffect(() => {
    if (!desktopSurfaces) return;
    let cancelled = false;
    void initAgentSettingsFromServer().then((s) => { if (!cancelled) setAgentCfg(s); });
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<AgentSettings>).detail;
      if (detail) setAgentCfg(detail);
    };
    window.addEventListener(AGENT_SETTINGS_EVENT, onChange);
    return () => { cancelled = true; window.removeEventListener(AGENT_SETTINGS_EVENT, onChange); };
  }, [desktopSurfaces]);
  const updateAgentCfg = (next: AgentSettings) => {
    setAgentCfg(next);
    writeAgentSettings(next);
  };

  // Sidebar deep-link: the rail's cloud-sync CTA jumps straight to the GitHub
  // section. `nonce` bumps on every navigate() so re-clicking the rail item
  // re-opens the section even if it's already active. 'brain' is the rail's own
  // id for that CTA and is kept as the wire name so the sidebar needs no change.
  useEffect(() => {
    // The rail's CTA reads "Set up team sync", so that is the section it opens. Its wire
    // name is still 'brain' (the sidebar is unchanged); 'github' is accepted for anything
    // that still asks for the old target.
    if (focus?.id === 'brain' || focus?.id === 'teamsync') setActiveSection('teamsync');
    else if (focus?.id === 'github') setActiveSection('github');
  }, [focus?.id, focus?.nonce]);

  if (configLoading) {
    return <div className="loading">{t('common.loading')}</div>;
  }
  if (configError) {
    return <div className="error-state">{t('common.error')}</div>;
  }

  const togglePlatform = (id: PlatformId) => {
    const next = platforms.includes(id) ? platforms.filter((p) => p !== id) : [...platforms, id];
    void platformsSave.save(() => updateConfig.mutateAsync({ platforms: next }));
  };

  const toggleNativeMemory = () => {
    void nativeMemorySave.save(() => updateConfig.mutateAsync({ disableNativeMemory: !disableNativeMemory }));
  };

  const openMachine = () => setActiveSection('system');

  return (
    <div className="settings-page">
      {config === null && (
        <div className="settings-empty-notice">{t('settings.no_config')}</div>
      )}

      <div className="settings-body">
        <nav className="settings-nav" aria-label={t('settings.title')}>
          {navGroups.map((group) => (
            <div key={group.id} className="settings-nav-group">
              <span className="settings-nav-group-label">{t(group.labelKey)}</span>
              {group.items.map((item) => {
                const NavIcon = SETTINGS_ICONS[item.id];
                const active = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`settings-nav-item${active ? ' settings-nav-item--active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setActiveSection(item.id)}
                  >
                    <span className="settings-nav-icon" aria-hidden="true">
                      {NavIcon ? <NavIcon /> : null}
                    </span>
                    <span className="settings-nav-label">
                      {t(item.labelKey)}
                      {item.lab && <span className="settings-lab-badge">{t('nav.lab')}</span>}
                      {item.beta && <span className="settings-beta-badge">BETA</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="settings-content">

      {/* ─── Project ─────────────────────────────────────────────────────── */}

      {activeSection === 'platforms' && (
      <section className="settings-section">
        <SectionHead titleKey="settings.nav.platforms" descKey="settings.desc.platforms" />
        <SettingGroup>
          {PLATFORM_OPTIONS.map(({ id, labelKey }) => (
            <SettingRow
              key={id}
              labelled
              title={t(labelKey)}
              hint={t(`${labelKey}.hint`)}
              status={<SaveMark state={platformsSave.state} />}
              control={
                <Toggle
                  checked={platforms.includes(id)}
                  disabled={platformsSave.state.kind === 'saving'}
                  onChange={() => togglePlatform(id)}
                />
              }
            />
          ))}
        </SettingGroup>
      </section>
      )}
      {activeSection === 'format' && <TaskOverrideEditor />}

      {activeSection === 'agents' && desktopSurfaces && (
        <section className="settings-section">
          <SectionHead titleKey="settings.nav.agents" descKey="settings.desc.agents" badge="beta" />
          <FeatureDepsNotice feature="agentTerminal" onOpenMachine={openMachine} />

          {/* Connected Claude accounts stay at the TOP: which account an agent runs
              on is the first thing about it, and the limit that stops work is the
              reason this block exists. */}
          <SettingGroup title={t('settings.agents.accounts.title')}>
            <ClaudeAccounts />
          </SettingGroup>

          {!agentCfg ? (
            <p className="settings-field-hint">{t('common.loading')}</p>
          ) : (
            <>
              <SettingGroup title={t('settings.agents.surface.title')}>
                {/* Master on/off — hides the FAB/dock and collapses any open overlay. */}
                <SettingRow
                  title={t('settings.agents.enable')}
                  hint={t('settings.agents.enable_hint')}
                  more={t('settings.agents.enable_more')}
                  control={
                    <Toggle
                      label={t('settings.agents.enable')}
                      checked={agentCfg.enabled}
                      onChange={(next) => updateAgentCfg({ ...agentCfg, enabled: next })}
                    />
                  }
                />

                {agentCfg.enabled && (
                  <>
                    {/* Agent screen — Chat (the standard surface) vs Terminal (legacy), a
                        mutually-exclusive preference: the chosen one takes over every Claude
                        entry point (＋ New, ⌘T/⌘D, reopened tabs, Sleep/delegate spawns).
                        Chat is listed first because it is the default; Terminal stays here as
                        the escape hatch back to the raw TUI. Stored as the same `chatView`
                        boolean the original beta checkbox used (agent-ui.json compat). */}
                    <SettingRow
                      title={t('settings.agents.screen')}
                      hint={t('settings.agents.screen_hint')}
                      more={t('settings.agents.screen_more')}
                      control={
                        <select
                          className="settings-text-input"
                          aria-label={t('settings.agents.screen')}
                          value={agentCfg.chatView ? 'chat' : 'terminal'}
                          onChange={(e) => updateAgentCfg({ ...agentCfg, chatView: e.target.value === 'chat' })}
                        >
                          <option value="chat">{t('settings.agents.screen.chat')}</option>
                          <option value="terminal">{t('settings.agents.screen.terminal')}</option>
                        </select>
                      }
                    />

                    {/* Answer rendering — WHICH LANGUAGE the agent draws structured answers
                        in, sitting directly under the screen it draws them on. An enum, not a
                        checkbox: the modes are mutually exclusive (see `AgentChatRender`), and
                        a third depiction is already proposed.

                        DISABLED on the Terminal screen, deliberately. The choice only reaches
                        the agent through the surface briefing, and that briefing is appended
                        to a CHAT spawn alone — offering it here while it can do nothing is the
                        exact "designed capability, unwired" failure this project has already
                        paid for once. Disabled + a reason beats an active control that lies. */}
                    <SettingRow
                      title={t('settings.agents.chat_render')}
                      hint={agentCfg.chatView ? t('settings.agents.chat_render_hint') : t('settings.agents.chat_render.needs_chat')}
                      more={t('settings.agents.chat_render_more')}
                      tone={agentCfg.chatView ? 'default' : 'warn'}
                      control={
                        <select
                          className="settings-text-input"
                          aria-label={t('settings.agents.chat_render')}
                          value={agentCfg.chatRender}
                          disabled={!agentCfg.chatView}
                          onChange={(e) => updateAgentCfg({ ...agentCfg, chatRender: e.target.value as AgentSettings['chatRender'] })}
                        >
                          <option value="html">{t('settings.agents.chat_render.html')}</option>
                          <option value="openui">{t('settings.agents.chat_render.openui')}</option>
                        </select>
                      }
                    />

                    {/* Quick open/close hotkey (in-app; default Ctrl+A). */}
                    <SettingRow
                      title={t('settings.agents.hotkey')}
                      hint={t('settings.agents.hotkey_hint')}
                      more={t('settings.agents.hotkey_more')}
                      control={
                        <input
                          className="settings-text-input"
                          readOnly
                          aria-label={t('settings.agents.hotkey')}
                          value={capturingAgentHotkey ? t('settings.agents.hotkey_capturing') : formatHotkey(agentCfg.hotkey)}
                          onFocus={() => { setCapturingAgentHotkey(true); lastModTapRef.current = null; }}
                          onBlur={() => { setCapturingAgentHotkey(false); lastModTapRef.current = null; }}
                          onKeyDown={(e) => {
                            e.preventDefault();
                            // Backspace/Delete clears the binding (no quick-toggle key).
                            if (e.key === 'Backspace' || e.key === 'Delete') {
                              updateAgentCfg({ ...agentCfg, hotkey: '' });
                              lastModTapRef.current = null;
                              setCapturingAgentHotkey(false);
                              e.currentTarget.blur();
                              return;
                            }
                            // A lone modifier: bind it on the *second* tap of the same key
                            // within the window (⌃⌃, ⌥⌥, ⌘⌘, ⇧⇧). Ignore auto-repeat while held.
                            const lone = loneModifierToken(e);
                            if (lone) {
                              if (e.repeat) return;
                              const now = Date.now();
                              const last = lastModTapRef.current;
                              if (last && last.token === lone && now - last.ts <= DOUBLE_TAP_MS) {
                                lastModTapRef.current = null;
                                updateAgentCfg({ ...agentCfg, hotkey: `${lone}+${lone}` });
                                setCapturingAgentHotkey(false);
                                e.currentTarget.blur();
                              } else {
                                lastModTapRef.current = { token: lone, ts: now };
                              }
                              return;
                            }
                            // Anything else is a normal chord — a stray modifier tap is cleared.
                            lastModTapRef.current = null;
                            const accel = accelFromAgentKey(e);
                            if (accel) {
                              updateAgentCfg({ ...agentCfg, hotkey: accel });
                              setCapturingAgentHotkey(false);
                              e.currentTarget.blur();
                            }
                          }}
                        />
                      }
                    />
                  </>
                )}
              </SettingGroup>

              {agentCfg.enabled && (
                <SettingGroup title={t('settings.agents.session.title')}>
                  {/* Reopen past tabs on launch. */}
                  <SettingRow
                    title={t('settings.agents.restore_tabs')}
                    hint={t('settings.agents.restore_tabs_hint')}
                    more={t('settings.agents.restore_tabs_more')}
                    control={
                      <Toggle
                        label={t('settings.agents.restore_tabs')}
                        checked={agentCfg.restoreTabs}
                        onChange={(next) => updateAgentCfg({ ...agentCfg, restoreTabs: next })}
                      />
                    }
                  />

                  {/* Auto-title: Haiku names the tab from the first message. */}
                  <SettingRow
                    title={t('settings.agents.auto_title')}
                    hint={t('settings.agents.auto_title_hint')}
                    more={t('settings.agents.auto_title_more')}
                    control={
                      <Toggle
                        label={t('settings.agents.auto_title')}
                        checked={agentCfg.autoTitle}
                        onChange={(next) => updateAgentCfg({ ...agentCfg, autoTitle: next })}
                      />
                    }
                  />

                  {/* Default agent — Claude Code is the only option today. */}
                  <SettingRow
                    title={t('settings.agents.default_agent')}
                    hint={t('settings.agents.default_agent_hint')}
                    control={
                      <select
                        className="settings-text-input"
                        aria-label={t('settings.agents.default_agent')}
                        value={agentCfg.defaultAgent}
                        onChange={(e) => updateAgentCfg({ ...agentCfg, defaultAgent: e.target.value as AgentSettings['defaultAgent'] })}
                      >
                        <option value="claude">{t('settings.agents.agent.claude')}</option>
                      </select>
                    }
                  />

                  {/* Terminal renderer: GPU smoothness vs native-text comfort. Applies
                      live to open sessions (agentSession listens for the settings event). */}
                  <SettingRow
                    title={t('settings.agents.renderer')}
                    hint={t('settings.agents.renderer_hint')}
                    more={t('settings.agents.renderer_more')}
                    control={
                      <select
                        className="settings-text-input"
                        aria-label={t('settings.agents.renderer')}
                        value={agentCfg.renderer}
                        onChange={(e) => updateAgentCfg({ ...agentCfg, renderer: e.target.value as AgentSettings['renderer'] })}
                      >
                        <option value="webgl">{t('settings.agents.renderer.webgl')}</option>
                        <option value="dom">{t('settings.agents.renderer.dom')}</option>
                      </select>
                    }
                  />
                </SettingGroup>
              )}
            </>
          )}
        </section>
      )}
      {activeSection === 'sleepy' && desktopSurfaces && (
        <section className="settings-section">
          <SectionHead titleKey="settings.nav.sleepy" descKey="settings.desc.sleepy" badge="lab" />
          <SettingGroup>
            <SettingRow
              labelled
              title={t('settings.sleepy.enable')}
              hint={t('settings.desc.sleepy')}
              control={<Toggle checked={sleepy.enabled} onChange={(next) => updateSleepy({ ...sleepy, enabled: next })} />}
            />
            {sleepy.enabled && (
              <SettingRow
                title={t('settings.sleepy.hotkey')}
                hint={t('settings.sleepy.hotkey_hint')}
                control={
                  <input
                    className="settings-text-input"
                    readOnly
                    value={capturingHotkey ? t('settings.sleepy.hotkey_capturing') : sleepy.hotkey}
                    onFocus={() => setCapturingHotkey(true)}
                    onBlur={() => setCapturingHotkey(false)}
                    onKeyDown={(e) => {
                      e.preventDefault();
                      const accel = accelFromKeyEvent(e);
                      if (accel) {
                        updateSleepy({ ...sleepy, hotkey: accel });
                        setCapturingHotkey(false);
                        e.currentTarget.blur();
                      }
                    }}
                  />
                }
              />
            )}
          </SettingGroup>
        </section>
      )}
      {activeSection === 'memory' && (
      <section className="settings-section">
        <SectionHead titleKey="settings.nav.memory" descKey="settings.desc.memory" />
        <SettingGroup>
          <SettingRow
            labelled
            title={t('settings.native_memory.label')}
            hint={t('settings.native_memory.hint')}
            status={<SaveMark state={nativeMemorySave.state} />}
            control={
              <Toggle
                checked={disableNativeMemory}
                disabled={nativeMemorySave.state.kind === 'saving'}
                onChange={toggleNativeMemory}
              />
            }
          />
        </SettingGroup>
      </section>
      )}
      {activeSection === 'sleep' && (
      <section className="settings-section">
        <SectionHead titleKey="settings.nav.sleep" descKey="settings.desc.sleep" />
        <SleepSettings />
      </section>
      )}
      {activeSection === 'learning' && (
      <section className="settings-section">
        <SectionHead titleKey="settings.nav.learning" descKey="settings.desc.learning" />
        <SettingGroup>
          <SettingRow
            labelled
            title={t('settings.learning.label')}
            hint={t('settings.learning.row_hint')}
            control={
              <Toggle
                checked={learningEnabled}
                disabled={setLearningEnabled.isPending}
                onChange={(next) => setLearningEnabled.mutate(next)}
              />
            }
          />
        </SettingGroup>
        {setLearningEnabled.isError && <p className="settings-test-err">✗ {t('common.error')}</p>}
      </section>
      )}
      {activeSection === 'recall' && (
      <section className="settings-section">
        <SectionHead titleKey="settings.nav.recall" descKey="settings.desc.recall" />
        <div className="setting-choices" role="radiogroup" aria-label={t('settings.nav.recall')}>
          {RECALL_MODE_OPTIONS.map(({ mode, labelKey, hintKey, experimental }) => (
            <SettingChoice
              key={mode}
              name="recall-mode"
              value={mode}
              checked={recallMode === mode}
              disabled={updateSleep.isPending}
              onSelect={() => updateSleep.mutate({ recall_mode: mode })}
              title={t(labelKey)}
              hint={t(hintKey)}
              badge={experimental ? <span className="settings-beta-badge">{t('settings.recall.experimental')}</span> : undefined}
            >
              {mode === 'hybrid' && recallMode === 'hybrid' && <EmbeddingModelCard />}
            </SettingChoice>
          ))}
        </div>
        {updateSleep.isError && <p className="settings-test-err">✗ {t('common.error')}</p>}
      </section>
      )}
      {activeSection === 'github' && (
      <section className="settings-section">
        <SectionHead titleKey="settings.nav.github" descKey="settings.desc.github" />

        {/* The ACCOUNT, and the one thing that uses it here. Team sync is the other
            use and has its own section — the two were one screen and it read as a
            single, three-part setup nobody could follow. */}
        <SettingGroup title={t('settings.github.account.title')}>
          <div className="setting-row">
            <GitHubLogin />
          </div>
        </SettingGroup>

        <SettingGroup title={t('settings.github.issues.title')} note={t('settings.github.issues.note')}>
          <CloudTaskSync provider="github" />
        </SettingGroup>
      </section>
      )}

      {/* ─── Team sync — its own setting, because it is its own decision ──────────
          It shares the GitHub account but nothing else: what it needs (a repo), what
          it does (pushes the whole project) and when it does it (on open, on demand)
          are all its own. It also has its own entry in the sidebar rail, which is
          where most people meet it. */}
      {activeSection === 'teamsync' && (
      <section className="settings-section">
        <SectionHead titleKey="settings.nav.teamsync" descKey="settings.desc.teamsync" />
        <FeatureDepsNotice feature="cloudSync" onOpenMachine={openMachine} />

        {!githubConnected ? (
          // Nothing here can work without the account, so the section says that once
          // instead of drawing four controls that would each fail on their own.
          <SettingRow
            tone="warn"
            title={t('settings.teamsync.needsAccount.title')}
            hint={t('settings.teamsync.needsAccount.hint')}
            control={
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setActiveSection('github')}>
                {t('settings.teamsync.needsAccount.cta')}
              </button>
            }
          />
        ) : (
          <SettingGroup>
            {/* THE SWITCH IS GATED ON THE REPO, not just styled as if it were. The server
                refuses to enable sync with no origin (400 `no_origin`), so an enabled
                control here was a switch that could only fail — the user flipped it, it
                bounced back, and nothing said why. */}
            <SettingRow
              title={t('brain.cloudSync.label')}
              hint={hasOrigin ? t('brain.cloudSync.hint') : t('settings.teamsync.needsRepo')}
              tone={hasOrigin ? 'default' : 'warn'}
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
            <SettingRow title={t('settings.teamsync.repo.title')} hint={t('settings.teamsync.repo.hint')}>
              <OriginSetup compact />
            </SettingRow>

            <SettingRow
              title={t('brain.scope.autoCheckpoint.label')}
              hint={t('brain.scope.autoCheckpoint.hint')}
              more={t('brain.scope.autoCheckpoint.more')}
              control={
                <Toggle
                  label={t('brain.scope.autoCheckpoint.label')}
                  checked={autoCheckpoint}
                  onChange={(next) => { setAutoCheckpoint(next); writeAutoCheckpointOnOpen(vault, next); }}
                />
              }
            />
          </SettingGroup>
        )}
      </section>
      )}

      {/* Linked repos are neither the GitHub account nor team sync: they are the OTHER
          code repos this brain governs. They sat inside the sync panel and were read as
          part of it. */}
      {activeSection === 'linkedrepos' && (
      <section className="settings-section">
        <SectionHead titleKey="settings.nav.linkedrepos" descKey="settings.desc.linkedrepos" />
        <LinkedRepos compact />
      </section>
      )}
      {activeSection === 'clickup' && (
      <section className="settings-section">
        <SectionHead titleKey="settings.nav.clickup" descKey="settings.desc.clickup" />
        <CloudTaskSync provider="clickup" />
      </section>
      )}

      {activeSection === 'connections' && <ConnectionsManager />}

      {/* ─── This machine ────────────────────────────────────────────────── */}

      {activeSection === 'system' && (
      <section className="settings-section">
        <SectionHead titleKey="settings.nav.system" descKey="settings.desc.system" />
        <SystemDependencies />
      </section>
      )}

        </div>
      </div>
    </div>
  );
}
