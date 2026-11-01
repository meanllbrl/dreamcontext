import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { isDesktop } from '../../../../lib/desktop';
import { useI18n } from '../../../../context/I18nContext';
import {
  applyAssistantHotkey, getAssistantStatus, getProfile, getVoiceKeySet, removeAvatar, saveProfile,
  setAssistantAutostart, setAssistantEnabled, uploadAvatar,
  type AssistantConfig, type AssistantProfilePatch,
} from '../../../../lib/assistantProfile';
import {
  AVATAR_ACCEPT, CHARACTER_MAX, NAME_MAX, captureChord, formatChordGlyphs,
  type AssistantAutonomy, type HotkeyApplyResult,
} from '../../../assistant/assistantWizardLogic';
import { AutonomyWarnings, type HotkeyStepRefusal } from '../../../assistant/AssistantWizardSteps';
import { AssistantWizard } from '../../../assistant/AssistantWizard';
import { SettingGroup, SettingRow, Toggle } from '../../SettingRow';
import { SaveMark, useInstantSave } from '../../useInstantSave';
import { PageHead, Seg } from '../controls';
import { pageDescKey, pageTitleKey } from '../sections';
import type { PageProps } from './SimplePages';

interface Loaded {
  config: AssistantConfig;
  character: string;
  avatar: string | null;
}

const AUTONOMIES: readonly AssistantAutonomy[] = ['ask', 'auto', 'bypass'];

/**
 * Settings window → Assistant (moved here from its wizard): Profile (picture, name, character)
 * and How it works (on, wake key, autonomy, model, read aloud, start at login). Every control
 * writes at once through `/api/assistant/profile`; the shell-side ones (hotkey, Login Item, the
 * off switch) report the shell's real answer. With no assistant yet, one button opens the setup.
 */
export function AssistantPage({ chip, searching }: PageProps) {
  const { t } = useI18n();
  // 'error' is NOT 'none': a failed read must never offer the setup, which would overwrite an
  // existing assistant's name and autonomy.
  const [data, setData] = useState<Loaded | 'none' | 'error' | null>(null);
  const [voiceKey, setVoiceKey] = useState(true);
  const [wizard, setWizard] = useState(false);
  const [rev, setRev] = useState(0);
  const load = useCallback(async () => {
    try {
      const st = await getAssistantStatus();
      if (st.exists === false) { setData('none'); return; }
      const p = await getProfile();
      setData({ config: p.config, character: p.character, avatar: p.avatar });
    } catch {
      setData('error');
    }
  }, []);
  useEffect(() => { void load(); void getVoiceKeySet().then(setVoiceKey, () => setVoiceKey(false)); }, [load]);

  const head = <PageHead title={t(pageTitleKey('assistant'))} desc={t(pageDescKey('assistant'))} />;
  if (data === null) return head;
  if (data === 'error') {
    return (
      <>
        {head}
        <SettingGroup>
          <SettingRow
            id="aerror"
            title={t('shell.sw.page.assistant')}
            hint={t('shell.sw.assistant.loadFailed')}
            why={isDesktop() ? undefined : t('shell.sw.assistant.desktopOnly')}
            keywords="assistant notch"
            control={!searching ? <button type="button" className="sw-btn" data-testid="sw-assistant-retry" onClick={() => { setData(null); void load(); }}>{t('settings.agents.load_retry')}</button> : undefined}
          />
        </SettingGroup>
      </>
    );
  }
  if (data === 'none') {
    return (
      <>
        {head}
        <SettingGroup>
          <SettingRow
            id="asetup"
            title={t('shell.sw.assistant.none')}
            hint={t('shell.sw.assistant.none.h')}
            keywords="assistant notch setup create"
            control={!searching ? <button type="button" className="sw-btn sw-btn--accent" data-testid="sw-assistant-setup" onClick={() => setWizard(true)}>{t('shell.sw.assistant.setup')}</button> : undefined}
          />
        </SettingGroup>
        {wizard && (
          <div data-sw-modal>
            <AssistantWizard exists={false} onClose={() => { setWizard(false); void load(); }} onChanged={() => void load()} />
          </div>
        )}
      </>
    );
  }
  return (
    <>
      {head}
      <Profile data={data} rev={rev} onSaved={(fn) => { setData(update(fn)); setRev((n) => n + 1); }} />
      <HowItWorks data={data} voiceKey={voiceKey} chip={chip} onSaved={(fn) => setData(update(fn))} />
    </>
  );
}

/** A save lands on the CURRENT data, never on the snapshot its render saw: two saves in flight
 *  would otherwise put back what the other just wrote. */
type Saved = (fn: (d: Loaded) => Loaded) => void;
const update = (fn: (d: Loaded) => Loaded) => (p: Loaded | 'none' | 'error' | null) => (p && p !== 'none' && p !== 'error' ? fn(p) : p);

function Profile({ data, rev, onSaved }: { data: Loaded; rev: number; onSaved: Saved }) {
  const { t } = useI18n();
  const pic = useInstantSave();
  const name = useInstantSave();
  const char = useInstantSave();
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(data.config.name);
  const [charDraft, setCharDraft] = useState(data.character);
  const [picErr, setPicErr] = useState('');
  useEffect(() => { setCharDraft(data.character); }, [data.character]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setPicErr('');
    void pic.save(async () => {
      try {
        const out = await uploadAvatar(f);
        onSaved((d) => ({ ...d, avatar: out.url }));
      } catch (err) {
        setPicErr(t('shell.sw.assistant.pic.bad'));
        throw err;
      }
    });
  };
  const saveName = () => {
    const v = nameDraft.trim().slice(0, NAME_MAX);
    setNaming(false);
    if (!v || v === data.config.name) { setNameDraft(data.config.name); return; }
    void name.save(async () => { const c = await saveProfile({ name: v }); onSaved((d) => ({ ...d, config: c })); });
  };
  const saveChar = () => {
    if (charDraft === data.character) return;
    void char.save(async () => { const sent = charDraft; await saveProfile({ character: sent }); onSaved((d) => ({ ...d, character: sent })); });
  };
  const initial = (data.config.name.trim()[0] ?? '?').toUpperCase();

  return (
    <SettingGroup title={t('shell.sw.assistant.profile')}>
      <SettingRow
        id="apic"
        title={t('shell.sw.assistant.pic')}
        hint={t('shell.sw.assistant.pic.h')}
        keywords="avatar photo image profile picture"
        why={picErr || undefined}
        status={<SaveMark state={pic.state} />}
        control={(
          <>
            {data.avatar
              ? <img className="sw-av" src={`${data.avatar}?v=${rev}`} alt="" />
              : <span className="sw-av" aria-hidden="true">{initial}</span>}
            <label className="sw-btn sw-file">
              {t(data.avatar ? 'shell.sw.assistant.pic.change' : 'shell.sw.assistant.pic.upload')}
              <input type="file" accept={AVATAR_ACCEPT} hidden onChange={onFile} data-testid="sw-avatar-file" />
            </label>
            {data.avatar && (
              <button type="button" className="sw-btn" data-testid="sw-avatar-remove" onClick={() => { void pic.save(async () => { await removeAvatar(); onSaved((d) => ({ ...d, avatar: null })); }); }}>
                {t('shell.sw.remove')}
              </button>
            )}
          </>
        )}
      />
      <SettingRow
        id="aname"
        title={t('shell.sw.assistant.name')}
        hint={t('shell.sw.assistant.name.h')}
        keywords="name"
        status={<SaveMark state={name.state} />}
        control={naming ? (
          <input
            className="settings-text-input"
            autoFocus
            maxLength={NAME_MAX}
            aria-label={t('shell.sw.assistant.name')}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={saveName}
            data-sw-esc
            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { e.stopPropagation(); setNameDraft(data.config.name); setNaming(false); } }}
          />
        ) : (
          <>
            <span className="sw-val">{data.config.name}</span>
            <button type="button" className="sw-btn" onClick={() => { setNameDraft(data.config.name); setNaming(true); }}>{t('shell.sw.assistant.change')}</button>
          </>
        )}
      />
      <SettingRow
        id="achar"
        title={t('shell.sw.assistant.char')}
        hint={t('shell.sw.assistant.char.h')}
        keywords="persona personality prompt tone character"
        status={<SaveMark state={char.state} />}
      >
        <textarea
          className="sw-ta"
          rows={3}
          maxLength={CHARACTER_MAX}
          aria-label={t('shell.sw.assistant.char')}
          value={charDraft}
          onChange={(e) => setCharDraft(e.target.value)}
          onBlur={saveChar}
        />
      </SettingRow>
    </SettingGroup>
  );
}

function HowItWorks({ data, voiceKey, chip, onSaved }: { data: Loaded; voiceKey: boolean; chip: PageProps['chip']; onSaved: Saved }) {
  const { t } = useI18n();
  const on = useInstantSave();
  const wake = useInstantSave();
  const auto = useInstantSave();
  const speak = useInstantSave();
  const login = useInstantSave();
  const c = data.config;
  const [capturing, setCapturing] = useState(false);
  const [refusal, setRefusal] = useState<HotkeyStepRefusal | null>(null);
  const [hk, setHk] = useState<HotkeyApplyResult | null>(null);
  const [shellNote, setShellNote] = useState('');
  const [loginNote, setLoginNote] = useState('');

  const persist = async (patch: AssistantProfilePatch) => {
    const cfg = await saveProfile(patch);
    onSaved((d) => ({ ...d, config: cfg }));
    return cfg;
  };
  const applyHotkey = (next: AssistantProfilePatch['hotkey']) => {
    setRefusal(null);
    void wake.save(async () => { await persist({ hotkey: next }); setHk(await applyAssistantHotkey()); });
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur(); return; }
    if (e.key === 'Tab') return;
    e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'Delete') { applyHotkey(null); e.currentTarget.blur(); return; }
    const out = captureChord(e.nativeEvent);
    if (out.kind === 'assembling') return;
    if (out.kind === 'refused') { setRefusal(out.reason); return; }
    applyHotkey({ code: out.code, mods: out.mods, mode: c.hotkey?.mode ?? 'hold' });
    e.currentTarget.blur();
  };
  const hkWhy = refusal ? t(`assistant.hotkey.refused.${refusal}`)
    : hk && !hk.ok && hk.error ? `${t('shell.sw.assistant.wake.failed')} ${hk.error}`
      : undefined;

  return (
    <SettingGroup title={t('shell.sw.assistant.how')}>
      <SettingRow
        id="aon"
        title={t('shell.sw.assistant.on')}
        hint={t('shell.sw.assistant.on.h')}
        keywords="assistant on off enable notch"
        why={shellNote || undefined}
        status={<SaveMark state={on.state} />}
        control={<Toggle label={t('shell.sw.assistant.on')} checked={c.enabled} onChange={(v) => {
          setShellNote('');
          void on.save(async () => {
            await persist({ enabled: v });
            const r = await setAssistantEnabled(v);
            if (r.desktopOnly) setShellNote(t('shell.sw.assistant.desktopOnly'));
            else if (!r.ok) setShellNote(r.error ?? t('common.error'));
          });
        }} />}
      />
      <SettingRow
        id="awake"
        title={t('shell.sw.assistant.wake')}
        hint={capturing ? t('assistant.hotkey.capturing') : t('shell.sw.assistant.wake.h')}
        keywords="hotkey shortcut wake key notch"
        why={hkWhy}
        status={<SaveMark state={wake.state} />}
        control={(
          <>
            <input
              className="settings-text-input voice-hotkey"
              readOnly
              aria-label={t('shell.sw.assistant.wake')}
              value={capturing ? t('assistant.hotkey.capturing') : c.hotkey ? formatChordGlyphs(c.hotkey) : t('assistant.hotkey.empty')}
              onFocus={() => { setCapturing(true); setRefusal(null); }}
              onBlur={() => setCapturing(false)}
              onKeyDown={onKey}
              data-sw-esc
            />
            <Seg<'hold' | 'toggle'>
              label={t('assistant.hotkey.mode')}
              value={c.hotkey?.mode ?? 'hold'}
              disabled={!c.hotkey}
              onChange={(m) => { if (c.hotkey) applyHotkey({ ...c.hotkey, mode: m }); }}
              options={[{ value: 'hold', label: t('shell.sw.voice.talk.hold') }, { value: 'toggle', label: t('shell.sw.voice.talk.press1') }]}
            />
          </>
        )}
      />
      <SettingRow
        id="aauto"
        title={t('shell.sw.assistant.auto')}
        hint={t(`assistant.autonomy.${c.autonomy}.hint`)}
        keywords="autonomy permission bypass ask"
        status={<SaveMark state={auto.state} />}
        control={(
          <Seg<AssistantAutonomy>
            label={t('shell.sw.assistant.auto')}
            value={c.autonomy}
            onChange={(a) => { void auto.save(() => persist({ autonomy: a })); }}
            options={AUTONOMIES.map((a) => ({ value: a, label: t(`assistant.autonomy.${a}`) }))}
          />
        )}
      >
        <AutonomyWarnings autonomy={c.autonomy} autostart={c.autostart} />
      </SettingRow>
      <SettingRow
        id="amodel"
        title={t('shell.sw.model')}
        hint={t('shell.sw.model.same')}
        keywords="assistant model effort"
        control={chip?.('assistant')}
      />
      <SettingRow
        id="speakasst"
        title={t('shell.sw.assistant.speak')}
        hint={t('shell.sw.assistant.speak.h')}
        keywords="speak tts notch read aloud"
        why={!voiceKey ? t('shell.sw.voice.needsKey') : undefined}
        status={<SaveMark state={speak.state} />}
        control={<Toggle label={t('shell.sw.assistant.speak')} checked={c.speak && voiceKey} disabled={!voiceKey} onChange={(v) => { void speak.save(() => persist({ speak: v })); }} />}
      />
      <SettingRow
        id="alogin"
        title={t('shell.sw.assistant.login')}
        hint={t('shell.sw.assistant.login.h')}
        keywords="autostart login item launch start"
        why={loginNote || undefined}
        status={<SaveMark state={login.state} />}
        control={<Toggle label={t('shell.sw.assistant.login')} checked={c.autostart} onChange={(v) => {
          setLoginNote('');
          void login.save(async () => {
            const r = await setAssistantAutostart(v);
            if (r.desktopOnly) { setLoginNote(t('shell.sw.assistant.desktopOnly')); throw new Error('desktop only'); }
            if (!r.ok) { setLoginNote(r.error ?? t('common.error')); throw new Error('refused'); }
            await persist({ autostart: r.enabled });
          });
        }} />}
      />
    </SettingGroup>
  );
}
