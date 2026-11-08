import { useEffect, useState, type ReactNode } from 'react';
import { Popover } from '../SkillPickerPopover';
import { useI18n } from '../../../context/I18nContext';
import { useDictationState } from '../../settings/DictationInstall';
import {
  micMenuItems, dictationStepPlan, type MicStep, type DictationStepPlan, type DictationStepState,
} from '../../../lib/voice/micMenu';
import { grantMicPermission, type MicPermission } from '../../../lib/voice/micPermission';
import { notifyDictationChanged } from '../../../lib/voice/useDictationReady';
import { MicIcon, SpeakerIcon, HushIcon, DownloadIcon, SlidersIcon } from './voiceIcons';

/**
 * The mic and its options as ONE split button (owner, 2026-11-08, mockup A): the mic on the
 * left (hold to talk, unchanged), a small caret on the right that opens the voice menu. The
 * separate speaker button is gone; its switch is the menu's "reply aloud" row, and a blue dot
 * on the caret says it is on. Anything still missing (the microphone permission, a dictation
 * model) is a step at the top of the menu and an amber dot on the mic, and a press on the mic
 * opens the menu on that step instead of recording (`micPressAction`).
 *
 * The rules (what is listed, in which order) are `lib/voice/micMenu.ts`, tested on their own.
 */

export interface MicSplitProps {
  /** The composer's mic button, handlers and all. */
  mic: ReactNode;
  steps: MicStep[];
  permission: MicPermission;
  readAloudAvailable: boolean;
  readAloudOn: boolean;
  /** "Reply aloud when I speak" on the Super Agent, "Read replies aloud" on the Assistant. */
  readAloudLabel: string;
  settingsAvailable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggleReadAloud: () => void;
  onOpenSettings: () => void;
}

export function MicSplit(props: MicSplitProps) {
  // The install state is read only while a model is missing, and polled only while it installs:
  // held HERE, not in the menu, so closing the menu mid-download still sees it finish.
  return props.steps.includes('dictation') ? <MicSplitWithDictation {...props} /> : <MicSplitView {...props} dictation={null} />;
}

function MicSplitWithDictation(props: MicSplitProps) {
  const d = useDictationState();
  const { read } = d;
  // Opening the menu reads the install fresh (another window may have installed it), and a fresh
  // "installed" corrects this window's gate, so a working mic is never held behind a stale step.
  useEffect(() => { if (props.open) void read(); }, [props.open, read]);
  const installed = d.state?.installed === true;
  useEffect(() => { if (installed) notifyDictationChanged(); }, [installed]);
  return <MicSplitView {...props} dictation={{ state: d.state as DictationStepState | null, install: (m) => { void d.choose(m); }, sending: d.sending, error: d.postError }} />;
}

interface DictationHandle {
  state: DictationStepState | null;
  install: (model: string) => void;
  sending: boolean;
  error: string | null;
}

function MicSplitView({ mic, steps, permission, readAloudAvailable, readAloudOn, readAloudLabel, settingsAvailable, open, onOpenChange, onToggleReadAloud, onOpenSettings, dictation }: MicSplitProps & { dictation: DictationHandle | null }) {
  const { t } = useI18n();
  const items = micMenuItems({ steps, readAloudAvailable, readAloudOn, settingsAvailable });
  // Nothing to list (the phone): the plain mic, as before.
  if (items.length === 0) return <>{mic}</>;
  return (
    <Popover
      align="right"
      menuClassName="agent-composer-menu--glass chat-cmp-micmenu"
      open={open}
      onOpenChange={onOpenChange}
      trigger={(isOpen, toggle) => (
        <span className={`chat-cmp-micsplit${isOpen ? ' is-open' : ''}${steps.length ? ' has-step' : ''}`}>
          {mic}
          <span className="chat-cmp-micsplit-rule" aria-hidden />
          <button
            type="button"
            className="chat-cmp-iconbtn chat-cmp-micsplit-caret"
            onClick={toggle}
            title={t('micmenu.aria')}
            aria-label={t('micmenu.aria')}
            aria-haspopup="menu"
            aria-expanded={isOpen}
          >
            <svg className="chat-cmp-ic chat-cmp-caret" viewBox="0 0 24 24" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
            {readAloudAvailable && readAloudOn && <span className="chat-cmp-micdot is-speaking" aria-hidden />}
          </button>
        </span>
      )}
    >
      {(close) => (
        <div className="chat-cmp-menu-list chat-cmp-micmenu-list">
          {items.map((item, i) => {
            const rule = i > 0 && items[i - 1]!.kind === 'step' && item.kind !== 'step';
            const key = item.kind === 'step' ? `step-${item.step}` : item.kind;
            return (
              <MenuRow key={key} rule={rule}>
                {item.kind === 'step' && item.step === 'permission' && <PermissionRow permission={permission} />}
                {item.kind === 'step' && item.step === 'dictation' && <DictationRow dictation={dictation} canOpenSettings={settingsAvailable} onOpenSettings={() => { onOpenSettings(); close(); }} />}
                {item.kind === 'read-aloud' && (
                  <button type="button" role="menuitemcheckbox" aria-checked={item.on} className="chat-cmp-micmenu-row" onClick={onToggleReadAloud}>
                    {item.on ? <SpeakerIcon /> : <HushIcon />}
                    <span className="chat-cmp-micmenu-text"><span>{readAloudLabel}</span></span>
                    <span className={`chat-cmp-micmenu-switch${item.on ? ' is-on' : ''}`} aria-hidden />
                  </button>
                )}
                {item.kind === 'settings' && (
                  <button type="button" role="menuitem" className="chat-cmp-micmenu-row" onClick={() => { onOpenSettings(); close(); }}>
                    <SlidersIcon />
                    <span className="chat-cmp-micmenu-text"><span>{t('micmenu.settings')}</span><small>{t('micmenu.settings.d')}</small></span>
                  </button>
                )}
              </MenuRow>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

function MenuRow({ rule, children }: { rule: boolean; children: ReactNode }) {
  return (
    <>
      {rule && <span className="chat-cmp-micmenu-rule" role="separator" />}
      {children}
    </>
  );
}

function PermissionRow({ permission }: { permission: MicPermission }) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const refused = permission === 'denied' || permission === 'restricted';
  return (
    <button
      type="button"
      role="menuitem"
      className="chat-cmp-micmenu-row is-step"
      disabled={asking}
      onClick={() => {
        setAsking(true);
        void grantMicPermission(permission).finally(() => setAsking(false));
      }}
    >
      <MicIcon />
      <span className="chat-cmp-micmenu-text">
        <span>{t('micmenu.allow')}</span>
        <small>{refused ? t('micmenu.allow.denied') : t('micmenu.allow.ask')}</small>
      </span>
    </button>
  );
}

function mb(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)} GB` : `${n} MB`;
}

function bytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`;
}

/** `canOpenSettings` false (the notch): a plan that needs Voice settings is shown as its reason on
 *  a disabled row, never as a button that does nothing (pattern a-button-in-the-desktop-app…). */
function DictationRow({ dictation, canOpenSettings, onOpenSettings }: { dictation: DictationHandle | null; canOpenSettings: boolean; onOpenSettings: () => void }) {
  const { t } = useI18n();
  const plan: DictationStepPlan = dictationStepPlan(dictation?.state ?? null);
  const busy = plan.kind === 'engine' || plan.kind === 'download' || plan.kind === 'checking' || !!dictation?.sending;
  const sub = dictation?.error ? dictation.error
    : plan.kind === 'checking' ? t('micmenu.setup.checking')
      : plan.kind === 'engine' ? t('micmenu.setup.engine')
        : plan.kind === 'download'
          ? (plan.total > 0
            ? t('micmenu.setup.download').replace('{model}', plan.model ?? '').replace('{got}', bytes(plan.received)).replace('{total}', bytes(plan.total))
            : t('micmenu.setup.engine'))
          : plan.kind === 'install'
            ? (plan.onDisk ? t('micmenu.setup.ondisk') : t('micmenu.setup.install').replace('{model}', plan.model).replace('{size}', mb(plan.downloadMB)))
            : plan.error ?? t(`micmenu.setup.${plan.reason}`);
  return (
    <button
      type="button"
      role="menuitem"
      className="chat-cmp-micmenu-row is-step"
      aria-busy={busy}
      disabled={busy || (plan.kind === 'settings' && !canOpenSettings)}
      onClick={() => {
        if (plan.kind === 'install') dictation?.install(plan.model);
        else if (plan.kind === 'settings') onOpenSettings();
      }}
    >
      <DownloadIcon />
      <span className="chat-cmp-micmenu-text">
        <span>{t('micmenu.setup')}</span>
        <small>{sub}</small>
        {plan.kind === 'download' && (
          <progress className="chat-cmp-micmenu-bar" max={100} value={plan.pct ?? undefined} aria-label={t('micmenu.setup')} />
        )}
      </span>
    </button>
  );
}
