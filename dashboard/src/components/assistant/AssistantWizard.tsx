import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { MaturityTag } from '../common/MaturityTag';
import { isDesktop, sendDesktopNotification } from '../../lib/desktop';
import {
  AssistantApiError, applyAssistantHotkey, createAssistant, getProfile, getVoiceKeySet, saveProfile,
  saveVoiceKey, setAssistantAutostart, uploadAvatar, wakeAssistant, type AssistantProfilePatch,
} from '../../lib/assistantProfile';
import {
  WIZARD_STEPS, fillCopy, isValidAssistantName,
  type AssistantAutonomy, type AssistantHotkey, type HotkeyApplyResult, type HotkeyMode, type WizardStep,
} from './assistantWizardLogic';
import {
  AutonomyStep, AutostartStep, AvatarStep, CharacterStep, HotkeyStep, NameStep, PermissionsStep, VoiceStep,
  WakeStep, PERMISSIONS, type HotkeyStepRefusal, type PermissionKey, type WakeState,
} from './AssistantWizardSteps';
import './AssistantWizard.css';

export interface AssistantWizardProps {
  /** True when the assistant already exists: the wizard opens as "Assistant settings",
   *  prefilled, with every step reachable. */
  exists: boolean;
  onClose: () => void;
  /** Something the Launcher card shows changed (created, renamed, new avatar, woke). */
  onChanged: () => void;
}

/**
 * "Create dreamcontext Assistant" / "Assistant settings".
 *
 * The assistant is CREATED at the end of the name step, not at "Wake up": the avatar and
 * profile routes 404 until the hidden vault exists, so every later step saves as it goes and
 * "Wake up" only shows the notch. Closing half-way therefore leaves a real, working assistant
 * with defaults, which the Launcher card then offers to finish under "Assistant settings".
 */
export function AssistantWizard({ exists: existsProp, onClose, onChanged }: AssistantWizardProps) {
  const { t } = useI18n();
  // Frozen at open: the card refetches (and flips `exists`) the moment step 1 creates the
  // assistant, and that must neither retitle the wizard nor re-prefill over the owner's edits.
  const [existsAtOpen] = useState(existsProp);
  const desktop = isDesktop();
  const [exists, setExists] = useState(existsAtOpen);
  const [loading, setLoading] = useState(existsAtOpen);
  const [stepIndex, setStepIndex] = useState(0);
  const step: WizardStep = WIZARD_STEPS[stepIndex];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [nameInvalid, setNameInvalid] = useState(false);
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [character, setCharacter] = useState('');
  const [savedCharacter, setSavedCharacter] = useState('');
  const [hotkey, setHotkey] = useState<AssistantHotkey | null>(null);
  const [hotkeyMode, setHotkeyMode] = useState<HotkeyMode>('hold');
  const [capturing, setCapturing] = useState(false);
  const [refusal, setRefusal] = useState<HotkeyStepRefusal | null>(null);
  const [hotkeyResult, setHotkeyResult] = useState<HotkeyApplyResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [autonomy, setAutonomy] = useState<AssistantAutonomy>('ask');
  const [autostart, setAutostart] = useState(false);
  const [autostartFailure, setAutostartFailure] = useState<string | null>(null);
  const [speak, setSpeak] = useState(false);
  const [keySet, setKeySet] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [ticks, setTicks] = useState<Record<PermissionKey, boolean>>(
    () => Object.fromEntries(PERMISSIONS.map((k) => [k, false])) as Record<PermissionKey, boolean>,
  );
  const [testState, setTestState] = useState<'idle' | 'sent' | 'failed'>('idle');
  const [wake, setWake] = useState<WakeState>({ kind: 'idle' });

  function describe(err: unknown): string {
    if (err instanceof AssistantApiError && err.code === 'assistant_local_only') return t('assistant.wizard.localOnly');
    if (err instanceof AssistantApiError && err.code.startsWith('avatar_')) return t(`assistant.avatar.err.${err.code.slice(7)}`);
    const message = err instanceof Error ? err.message : String(err);
    return fillCopy(t('assistant.wizard.error'), { error: message });
  }
  // `t` is a new function every render, so effects read `describe` through a ref.
  const describeRef = useRef(describe);
  describeRef.current = describe;

  /** Run one save; a failure is shown in the footer, never swallowed. */
  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (err) {
      setError(describe(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const persist = (patch: AssistantProfilePatch) => run(() => saveProfile(patch));

  // Prefill from the stored profile when editing.
  useEffect(() => {
    if (!existsAtOpen) return;
    let cancelled = false;
    getProfile().then((p) => {
      if (cancelled) return;
      setName(p.config.name);
      setSavedName(p.config.name);
      setCharacter(p.character);
      setSavedCharacter(p.character);
      setAvatarSrc(p.avatar ? `${p.avatar}?v=${Date.now()}` : null);
      setHotkey(p.config.hotkey);
      setHotkeyMode(p.config.hotkey?.mode ?? 'hold');
      setAutonomy(p.config.autonomy);
      setAutostart(p.config.autostart);
      setSpeak(p.config.speak);
    }).catch((err) => {
      if (!cancelled) setError(describeRef.current(err));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [existsAtOpen]);

  // The voice step asks the existing voice store whether a key is there (never what it is).
  useEffect(() => {
    if (step !== 'voice' || keySet !== null) return;
    let cancelled = false;
    getVoiceKeySet().then((v) => { if (!cancelled) setKeySet(v); }).catch(() => { /* rendered as "could not check" */ });
    return () => { cancelled = true; };
  }, [step, keySet]);

  // Restore focus to whatever opened the wizard.
  const opener = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);
  useEffect(() => () => { (opener.current as HTMLElement | null)?.focus?.(); }, []);

  const close = useCallback(() => {
    if (busy && !exists) return;   // mid-creation: the vault is being scaffolded
    onClose();
  }, [busy, exists, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !capturing) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [capturing, close]);

  // ─── Step actions ───────────────────────────────────────────────────────────────

  async function submitName(): Promise<boolean> {
    if (!isValidAssistantName(name)) { setNameInvalid(true); return false; }
    setNameInvalid(false);
    const trimmed = name.trim();
    if (!exists) {
      const ok = await run(async () => { await createAssistant({ name: trimmed, autonomy }); return true; });
      if (!ok) return false;
      setExists(true);
      setSavedName(trimmed);
      onChanged();
      return true;
    }
    if (trimmed === savedName) return true;
    const cfg = await persist({ name: trimmed });
    if (!cfg) return false;
    setSavedName(cfg.name);
    onChanged();
    return true;
  }

  async function submitCharacter(): Promise<boolean> {
    if (character === savedCharacter) return true;
    const cfg = await persist({ character });
    if (!cfg) return false;
    setSavedCharacter(character);
    return true;
  }

  async function pickAvatar(file: File) {
    const out = await run(() => uploadAvatar(file));
    if (!out) return;
    setAvatarSrc(`${out.url}?v=${Date.now()}`);
    onChanged();
  }

  /** Save the chord, then ask the shell to register it, and show the REAL answer. */
  async function applyHotkey(next: AssistantHotkey | null) {
    setRefusal(null);
    const cfg = await persist({ hotkey: next });
    if (!cfg) return;
    setHotkey(cfg.hotkey);
    setChecking(true);
    setHotkeyResult(await applyAssistantHotkey());
    setChecking(false);
  }

  function changeMode(m: HotkeyMode) {
    setHotkeyMode(m);
    if (hotkey) void applyHotkey({ ...hotkey, mode: m });
  }

  async function chooseAutonomy(a: AssistantAutonomy) {
    const prev = autonomy;
    setAutonomy(a);
    const cfg = await persist({ autonomy: a });
    setAutonomy(cfg ? cfg.autonomy : prev);
  }

  async function submitKey() {
    const draft = keyDraft.trim();
    if (!draft) return;
    const stored = await run(() => saveVoiceKey(draft));
    setKeyDraft('');
    if (stored === undefined) return;
    setKeySet(stored);
    setKeySaved(true);
  }

  async function toggleSpeak(on: boolean) {
    const cfg = await persist({ speak: on });
    if (cfg) setSpeak(cfg.speak);
  }

  async function toggleAutostart(on: boolean) {
    setAutostartFailure(null);
    setBusy(true);
    const r = await setAssistantAutostart(on);
    setBusy(false);
    if (!r.ok) { setAutostartFailure(r.error ?? ''); return; }
    const cfg = await persist({ autostart: r.enabled });
    setAutostart(cfg ? cfg.autostart : r.enabled);
  }

  async function testNotification() {
    const ok = await sendDesktopNotification(
      fillCopy(t('assistant.perm.testTitle'), { name: savedName || name }),
      t('assistant.perm.testBody'),
    );
    setTestState(ok ? 'sent' : 'failed');
  }

  async function wakeUp() {
    setWake({ kind: 'waking' });
    const r = await wakeAssistant();
    if (r.desktopOnly) setWake({ kind: 'desktop_only' });
    else if (!r.woke) setWake({ kind: 'failed', error: r.error ?? '' });
    else setWake({ kind: 'awake', hotkey: r.hotkey });
    onChanged();
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────────

  async function next() {
    if (step === 'name' && !(await submitName())) return;
    if (step === 'character' && !(await submitCharacter())) return;
    setError(null);
    setStepIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
  }

  function back() {
    setError(null);
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  async function jump(i: number) {
    if (!exists || i === stepIndex) return;
    if (step === 'name' && !(await submitName())) return;
    if (step === 'character' && !(await submitCharacter())) return;
    setError(null);
    setStepIndex(i);
  }

  const creating = busy && !exists && step === 'name';
  const isLast = stepIndex === WIZARD_STEPS.length - 1;
  const optional = step === 'avatar' && !avatarSrc;

  function body() {
    if (loading) return <p className="aw-hint" role="status">{t('assistant.wizard.loading')}</p>;
    switch (step) {
      case 'name':
        return <NameStep name={name} onName={(v) => { setName(v); setNameInvalid(false); }} onSubmit={() => void next()} invalid={nameInvalid} creating={creating} />;
      case 'avatar':
        return <AvatarStep src={avatarSrc} uploading={busy} onPick={(f) => void pickAvatar(f)} />;
      case 'character':
        return <CharacterStep value={character} onChange={setCharacter} />;
      case 'hotkey':
        return (
          <HotkeyStep
            hotkey={hotkey}
            mode={hotkeyMode}
            capturing={capturing}
            refusal={refusal}
            result={hotkeyResult}
            checking={checking}
            onCapturing={(on) => { setCapturing(on); if (on) setRefusal(null); }}
            onChord={(code, mods) => void applyHotkey({ code, mods, mode: hotkeyMode })}
            onRefused={setRefusal}
            onClear={() => void applyHotkey(null)}
            onMode={changeMode}
          />
        );
      case 'autonomy':
        return <AutonomyStep autonomy={autonomy} autostart={autostart} onAutonomy={(a) => void chooseAutonomy(a)} />;
      case 'voice':
        return (
          <VoiceStep
            keySet={keySet}
            keyDraft={keyDraft}
            keySaved={keySaved}
            busy={busy}
            speak={speak}
            onKeyDraft={(v) => { setKeyDraft(v); setKeySaved(false); }}
            onSaveKey={() => void submitKey()}
            onSpeak={(on) => void toggleSpeak(on)}
          />
        );
      case 'autostart':
        return <AutostartStep autostart={autostart} autonomy={autonomy} desktop={desktop} busy={busy} failure={autostartFailure} onToggle={(on) => void toggleAutostart(on)} />;
      case 'permissions':
        return <PermissionsStep ticks={ticks} testState={testState} onTick={(k, on) => setTicks((p) => ({ ...p, [k]: on }))} onTest={() => void testNotification()} />;
      case 'wake':
        return <WakeStep name={savedName || name} hotkey={hotkey} state={wake} onWake={() => void wakeUp()} />;
    }
  }

  return (
    <div className="aw-overlay" role="presentation" data-no-drag onClick={close}>
      <div
        className="aw-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="aw-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="aw-head">
          <h2 id="aw-title" className="aw-title">
            {existsAtOpen ? t('assistant.wizard.editTitle') : t('assistant.wizard.createTitle')}
          </h2>
          <MaturityTag level="alpha" />
          <button type="button" className="aw-close" onClick={close} aria-label={t('assistant.wizard.close')}>×</button>
        </header>

        <ol className="aw-steps" aria-label={t('assistant.wizard.steps')}>
          {WIZARD_STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={`aw-step${i === stepIndex ? ' aw-step--on' : ''}${i < stepIndex ? ' aw-step--done' : ''}`}
                aria-current={i === stepIndex ? 'step' : undefined}
                disabled={!exists || loading || busy}
                onClick={() => void jump(i)}
              >
                {t(`assistant.step.${s}`)}
              </button>
            </li>
          ))}
        </ol>

        <div className="aw-body">{body()}</div>

        {error && <div className="aw-error" role="alert">{error}</div>}

        <footer className="aw-actions">
          {stepIndex > 0 && (
            <button type="button" className="aw-btn" onClick={back} disabled={busy}>{t('assistant.wizard.back')}</button>
          )}
          <span className="aw-spacer" />
          {isLast ? (
            <button type="button" className="aw-btn" onClick={onClose}>{t('assistant.wizard.done')}</button>
          ) : (
            <button
              type="button"
              className={`aw-btn${step === 'name' ? ' aw-btn--primary' : ''}`}
              onClick={() => void next()}
              disabled={busy || loading || (step === 'name' && !name.trim())}
            >
              {busy ? t('assistant.wizard.saving')
                : step === 'name' && !exists ? t('assistant.name.create')
                  : optional ? t('assistant.wizard.skip') : t('assistant.wizard.next')}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
