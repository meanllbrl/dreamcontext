import { useRef } from 'react';
import type React from 'react';
import { useI18n } from '../../context/I18nContext';
import { Toggle } from '../settings/SettingRow';
import { DictationInstall } from '../settings/DictationInstall';
import {
  AVATAR_ACCEPT, CHARACTER_MAX, NAME_MAX, autonomyWarnings, captureChord, fillCopy, formatChordGlyphs,
  hotkeyResultView,
  type AssistantAutonomy, type AssistantHotkey, type CaptureOutcome, type HotkeyApplyResult, type HotkeyMode,
} from './assistantWizardLogic';

/**
 * The wizard's step bodies — presentational only. State, persistence and navigation live in
 * `AssistantWizard.tsx`; every string comes from i18n (`assistant.*`).
 */

function StepHead({ q, hint }: { q: string; hint: string }) {
  return (
    <>
      <h3 className="aw-q">{q}</h3>
      <p className="aw-hint">{hint}</p>
    </>
  );
}

export function NameStep({ name, onName, onSubmit, invalid, creating }: {
  name: string;
  onName: (v: string) => void;
  onSubmit: () => void;
  invalid: boolean;
  creating: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <StepHead q={t('assistant.name.q')} hint={t('assistant.name.hint')} />
      <input
        className="aw-input"
        autoFocus
        maxLength={NAME_MAX}
        value={name}
        disabled={creating}
        placeholder={t('assistant.name.placeholder')}
        aria-label={t('assistant.step.name')}
        aria-invalid={invalid}
        onChange={(e) => onName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
      />
      {invalid && <p className="aw-note aw-note--error">{t('assistant.name.invalid')}</p>}
      {creating && <p className="aw-note" role="status">{t('assistant.name.creating')}</p>}
    </>
  );
}

export function AvatarStep({ src, uploading, onPick }: {
  src: string | null;
  uploading: boolean;
  onPick: (file: File) => void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <StepHead q={t('assistant.avatar.q')} hint={t('assistant.avatar.hint')} />
      <div className="aw-avatar-row">
        <span className="aw-avatar aw-avatar--lg" aria-hidden={!src}>
          {src ? <img src={src} alt={t('assistant.avatar.alt')} /> : null}
        </span>
        <button type="button" className="aw-btn" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? t('assistant.avatar.uploading') : src ? t('assistant.avatar.change') : t('assistant.avatar.pick')}
        </button>
        <input
          ref={input}
          type="file"
          accept={AVATAR_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onPick(f);
          }}
        />
      </div>
    </>
  );
}

export function CharacterStep({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <>
      <StepHead q={t('assistant.character.q')} hint={t('assistant.character.hint')} />
      <textarea
        className="aw-input aw-textarea"
        autoFocus
        rows={7}
        maxLength={CHARACTER_MAX}
        value={value}
        placeholder={t('assistant.character.placeholder')}
        aria-label={t('assistant.step.character')}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="aw-note aw-note--count">
        {fillCopy(t('assistant.character.count'), { n: value.length, max: CHARACTER_MAX })}
      </p>
    </>
  );
}

export function HotkeyStep({ hotkey, mode, capturing, refusal, result, checking, onCapturing, onChord, onRefused, onClear, onMode }: {
  hotkey: AssistantHotkey | null;
  mode: HotkeyMode;
  capturing: boolean;
  refusal: HotkeyStepRefusal | null;
  result: HotkeyApplyResult | null;
  checking: boolean;
  onCapturing: (on: boolean) => void;
  onChord: (code: string, mods: AssistantHotkey['mods']) => void;
  onRefused: (reason: HotkeyStepRefusal) => void;
  onClear: () => void;
  onMode: (m: HotkeyMode) => void;
}) {
  const { t } = useI18n();

  /** Capture from the field itself: the PHYSICAL key (`code`) plus modifiers. A bare
   *  modifier is "still assembling", never an error. Escape stops listening. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur(); return; }
    if (e.key === 'Tab') return;
    e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'Delete') { onClear(); e.currentTarget.blur(); return; }
    const out = captureChord(e.nativeEvent);
    if (out.kind === 'assembling') return;
    if (out.kind === 'refused') { onRefused(out.reason); return; }
    onChord(out.code, out.mods);
    e.currentTarget.blur();
  };

  const view = result ? hotkeyResultView(result, hotkey) : null;
  return (
    <>
      <StepHead q={t('assistant.hotkey.q')} hint={t('assistant.hotkey.hint')} />
      <div className="aw-hotkey-row">
        <input
          className="aw-input aw-hotkey"
          readOnly
          autoFocus
          aria-label={t('assistant.hotkey.fieldLabel')}
          value={capturing ? t('assistant.hotkey.capturing') : hotkey ? formatChordGlyphs(hotkey) : t('assistant.hotkey.empty')}
          onFocus={() => onCapturing(true)}
          onBlur={() => onCapturing(false)}
          onKeyDown={onKeyDown}
        />
        {hotkey && (
          <button type="button" className="aw-btn" onClick={onClear}>{t('assistant.hotkey.clear')}</button>
        )}
      </div>
      {refusal && <p className="aw-note aw-note--error" role="alert">{t(`assistant.hotkey.refused.${refusal}`)}</p>}
      <div className="aw-live" role="status" aria-live="polite">
        {checking && <span className="aw-note">{t('assistant.hotkey.checking')}</span>}
        {!checking && view?.kind === 'registered' && (
          <span className="aw-note aw-note--ok">{fillCopy(t('assistant.hotkey.registered'), { chord: view.chord })}</span>
        )}
        {!checking && view?.kind === 'taken' && (
          <span className="aw-note aw-note--error">{fillCopy(t('assistant.hotkey.taken'), { detail: view.detail })}</span>
        )}
        {!checking && view?.kind === 'none' && <span className="aw-note">{t('assistant.hotkey.none')}</span>}
        {!checking && view?.kind === 'desktop_only' && <span className="aw-note">{t('assistant.hotkey.desktopOnly')}</span>}
      </div>
      <fieldset className="aw-fieldset">
        <legend className="aw-sublabel">{t('assistant.hotkey.mode')}</legend>
        {(['hold', 'toggle'] as const).map((m) => (
          <label key={m} className="aw-radio">
            <input type="radio" name="aw-hotkey-mode" value={m} checked={mode === m} onChange={() => onMode(m)} />
            <span>{t(`assistant.hotkey.mode.${m}`)}</span>
          </label>
        ))}
      </fieldset>
    </>
  );
}

export type HotkeyStepRefusal = Extract<CaptureOutcome, { kind: 'refused' }>['reason'];

/** The bypass warnings. Rendered on BOTH the autonomy and the autostart step, because
 *  either choice can be the one that completes the dangerous pair. */
export function AutonomyWarnings({ autonomy, autostart }: { autonomy: AssistantAutonomy; autostart: boolean }) {
  const { t } = useI18n();
  const warnings = autonomyWarnings(autonomy, autostart);
  if (warnings.length === 0) return null;
  return (
    <div className="aw-warnings">
      {warnings.map((w) => (
        <p key={w} role="alert" className={`aw-warning${w === 'bypass_autostart' ? ' aw-warning--strong' : ''}`}>
          {t(`assistant.warn.${w}`)}
        </p>
      ))}
    </div>
  );
}

export function AutonomyStep({ autonomy, autostart, onAutonomy }: {
  autonomy: AssistantAutonomy;
  autostart: boolean;
  onAutonomy: (a: AssistantAutonomy) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <StepHead q={t('assistant.autonomy.q')} hint={t('assistant.autonomy.hint')} />
      <fieldset className="aw-fieldset aw-choices">
        <legend className="aw-visually-hidden">{t('assistant.step.autonomy')}</legend>
        {(['ask', 'auto', 'bypass'] as const).map((a) => (
          <label key={a} className={`aw-choice${autonomy === a ? ' aw-choice--on' : ''}`}>
            <input type="radio" name="aw-autonomy" value={a} checked={autonomy === a} onChange={() => onAutonomy(a)} />
            <span className="aw-choice-text">
              <span className="aw-choice-title">{t(`assistant.autonomy.${a}`)}</span>
              <span className="aw-choice-hint">{t(`assistant.autonomy.${a}.hint`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <AutonomyWarnings autonomy={autonomy} autostart={autostart} />
    </>
  );
}

export function VoiceStep({ keySet, keyDraft, keySaved, busy, speak, onKeyDraft, onSaveKey, onSpeak }: {
  keySet: boolean | null;
  keyDraft: string;
  keySaved: boolean;
  busy: boolean;
  speak: boolean;
  onKeyDraft: (v: string) => void;
  onSaveKey: () => void;
  onSpeak: (on: boolean) => void;
}) {
  const { t } = useI18n();
  const status = keySet === null ? t('assistant.voice.keyUnknown')
    : keySet ? t('assistant.voice.keySet') : t('assistant.voice.keyMissing');
  return (
    <>
      <StepHead q={t('assistant.voice.q')} hint={t('assistant.voice.hint')} />
      {/* Setup installs dictation itself (owner, 2026-09-27): the engine and the model, the
          route decided by the server. It keeps going if the owner moves to the next step. */}
      <span className="aw-sublabel">{t('assistant.voice.dictation')}</span>
      <DictationInstall autoStart />
      <label className="aw-sublabel" htmlFor="aw-voice-key">{t('assistant.voice.keyLabel')}</label>
      <div className="aw-hotkey-row">
        {/* Write-only: the server reports only whether a key exists, so this field can never
            show the stored one. The draft is cleared the moment it is saved. */}
        <input
          id="aw-voice-key"
          className="aw-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={keyDraft}
          disabled={busy}
          placeholder={keySet ? '••••••••••••' : 'sk-or-…'}
          onChange={(e) => onKeyDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && keyDraft.trim()) onSaveKey(); }}
        />
        <button type="button" className="aw-btn" disabled={busy || !keyDraft.trim()} onClick={onSaveKey}>
          {t('assistant.voice.save')}
        </button>
      </div>
      <p className="aw-note" role="status">{keySaved ? t('assistant.voice.saved') : status}</p>
      <div className="aw-toggle-row">
        <span className="aw-toggle-text">
          <span className="aw-choice-title">{t('assistant.voice.speak')}</span>
          <span className="aw-choice-hint">{t('assistant.voice.speak.hint')}</span>
        </span>
        <Toggle label={t('assistant.voice.speak')} checked={speak} disabled={busy} onChange={onSpeak} />
      </div>
    </>
  );
}

export function AutostartStep({ autostart, autonomy, desktop, busy, failure, onToggle }: {
  autostart: boolean;
  autonomy: AssistantAutonomy;
  desktop: boolean;
  busy: boolean;
  failure: string | null;
  onToggle: (on: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <StepHead q={t('assistant.autostart.q')} hint={t('assistant.autostart.hint')} />
      <div className="aw-toggle-row">
        <span className="aw-choice-title">{t('assistant.autostart.toggle')}</span>
        <Toggle label={t('assistant.autostart.toggle')} checked={autostart} disabled={busy || !desktop} onChange={onToggle} />
      </div>
      {!desktop && <p className="aw-note">{t('assistant.autostart.desktopOnly')}</p>}
      {failure && <p className="aw-note aw-note--error" role="alert">{fillCopy(t('assistant.autostart.failed'), { error: failure })}</p>}
      <AutonomyWarnings autonomy={autonomy} autostart={autostart} />
    </>
  );
}

export const PERMISSIONS = ['mic', 'notifications', 'appleEvents', 'screen', 'loginItem'] as const;
export type PermissionKey = typeof PERMISSIONS[number];

export function PermissionsStep({ ticks, testState, onTick, onTest }: {
  ticks: Record<PermissionKey, boolean>;
  testState: 'idle' | 'sent' | 'failed';
  onTick: (k: PermissionKey, on: boolean) => void;
  onTest: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <StepHead q={t('assistant.perm.q')} hint={t('assistant.perm.hint')} />
      <ul className="aw-perms">
        {PERMISSIONS.map((k) => (
          <li key={k}>
            <label className="aw-perm">
              <input type="checkbox" checked={ticks[k]} onChange={(e) => onTick(k, e.target.checked)} />
              <span className="aw-choice-text">
                <span className="aw-choice-title">{t(`assistant.perm.${k}`)}</span>
                <span className="aw-choice-hint">{t(`assistant.perm.${k}.why`)}</span>
              </span>
            </label>
            {k === 'notifications' && (
              <div className="aw-perm-action">
                <button type="button" className="aw-btn aw-btn--small" onClick={onTest}>{t('assistant.perm.test')}</button>
                {testState !== 'idle' && (
                  <span className={`aw-note${testState === 'failed' ? ' aw-note--error' : ''}`} role="status">
                    {t(testState === 'sent' ? 'assistant.perm.testSent' : 'assistant.perm.testFailed')}
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export type WakeState =
  | { kind: 'idle' }
  | { kind: 'waking' }
  | { kind: 'awake'; hotkey: HotkeyApplyResult }
  | { kind: 'failed'; error: string }
  | { kind: 'desktop_only' };

export function WakeStep({ name, hotkey, state, onWake }: {
  name: string;
  hotkey: AssistantHotkey | null;
  state: WakeState;
  onWake: () => void;
}) {
  const { t } = useI18n();
  const view = state.kind === 'awake' ? hotkeyResultView(state.hotkey, hotkey) : null;
  return (
    <>
      <StepHead q={t('assistant.wake.q')} hint={t('assistant.wake.hint')} />
      <button
        type="button"
        className="aw-btn aw-btn--primary aw-wake"
        autoFocus
        disabled={state.kind === 'waking'}
        onClick={onWake}
      >
        {state.kind === 'waking' ? t('assistant.wake.waking') : t('assistant.wake.button')}
      </button>
      <div className="aw-live" role="status" aria-live="polite">
        {state.kind === 'awake' && <p className="aw-note aw-note--ok">{fillCopy(t('assistant.wake.awake'), { name })}</p>}
        {view?.kind === 'registered' && <p className="aw-note aw-note--ok">{fillCopy(t('assistant.hotkey.registered'), { chord: view.chord })}</p>}
        {view?.kind === 'taken' && <p className="aw-note aw-note--error">{fillCopy(t('assistant.hotkey.taken'), { detail: view.detail })}</p>}
        {state.kind === 'failed' && <p className="aw-note aw-note--error">{fillCopy(t('assistant.wake.failed'), { error: state.error })}</p>}
        {state.kind === 'desktop_only' && <p className="aw-note">{t('assistant.wake.desktopOnly')}</p>}
      </div>
    </>
  );
}
